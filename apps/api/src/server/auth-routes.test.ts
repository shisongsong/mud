import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../app.ts";
import { loadEnvironment } from "../config/env.ts";
import { AuthInvalidCredentialsError } from "../platform/identity.ts";
import type { IssuedSession } from "../platform/identity.ts";
import type { AuthRouteDependencies } from "./auth-routes.ts";

const origin = "https://game.example.com";
const anonymousSecret = "A".repeat(43);
const anonymousCsrf = "B".repeat(43);
const accountId = "11111111-1111-4111-8111-111111111111";

function issuedSession(authenticated: boolean, secret: string): IssuedSession {
  return {
    sessionSecret: secret,
    cookieChanged: true,
    view: {
      authenticated,
      ...(authenticated ? { accountId } : {}),
      expiresAt: "2026-10-09T12:00:00.000Z",
      csrfToken: authenticated ? "C".repeat(43) : anonymousCsrf,
      mfaRequired: false,
    },
  };
}

function createFixture(
  options: {
    readonly invalidCredentials?: boolean;
    readonly limiterFailure?: boolean;
    readonly secureCookies?: boolean;
    readonly allowHostOriginFallback?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const limits: Array<{ scope: string; subject: string; limit: number }> = [];
  const anonymous = issuedSession(false, anonymousSecret);
  const authenticated = issuedSession(true, "D".repeat(43));
  const identity: AuthRouteDependencies["identity"] = {
    getOrCreateSession: async () => anonymous,
    register: async () => {
      calls.push("register");
      return authenticated;
    },
    login: async () => {
      calls.push("login");
      if (options.invalidCredentials) throw new AuthInvalidCredentialsError();
      return authenticated;
    },
    logout: async () => {
      calls.push("logout");
    },
    validateCsrf: async (secret, token) =>
      secret === anonymousSecret && token === anonymousCsrf,
  };
  const dependencies: AuthRouteDependencies = {
    identity,
    rateLimiter: {
      consume: async (scope, subject, limit) => {
        if (options.limiterFailure) throw new Error("Redis unavailable");
        limits.push({ scope, subject, limit });
        return true;
      },
    },
    publicOrigin: origin,
    secureCookies: options.secureCookies ?? false,
    ...(options.allowHostOriginFallback === undefined
      ? {}
      : { allowHostOriginFallback: options.allowHostOriginFallback }),
  };
  const app = createApp(loadEnvironment({ NODE_ENV: "test" }), {
    auth: dependencies,
  });
  return { app, calls, limits };
}

test("session endpoint issues HttpOnly cookie but never returns its secret", async () => {
  const { app } = createFixture({ secureCookies: true });
  try {
    const response = await app.inject({ method: "GET", url: "/auth/session" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().authenticated, false);
    assert.equal("sessionSecret" in response.json(), false);
    assert.match(
      response.headers["set-cookie"] as string,
      /^__Host-mud_session=[A-Z]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/,
    );
  } finally {
    await app.close();
  }
});

test("registration requires exact Origin and CSRF before creating an account", async () => {
  const { app, calls, limits } = createFixture();
  const payload = {
    username: "Player_01",
    password: "a sufficiently long password",
  };
  const cookie = `mud_session=${anonymousSecret}`;
  try {
    const crossOrigin = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload,
      headers: {
        origin: "https://attacker.example",
        cookie,
        "x-csrf-token": anonymousCsrf,
      },
    });
    assert.equal(crossOrigin.statusCode, 403);
    assert.equal(calls.length, 0);

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload,
      headers: { origin, cookie },
    });
    assert.equal(missingCsrf.statusCode, 403);
    assert.equal(calls.length, 0);

    const created = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload,
      headers: { origin, cookie, "x-csrf-token": anonymousCsrf },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().accountId, accountId);
    assert.equal(calls.join(","), "register");
    assert.deepEqual(limits, [
      { scope: "register-ip", subject: "127.0.0.1", limit: 5 },
    ]);
    assert.match(created.headers["set-cookie"] as string, /^mud_session=D+/);
  } finally {
    await app.close();
  }
});

test("development auth accepts the Origin matching the forwarded request host", async () => {
  const { app, calls } = createFixture({ allowHostOriginFallback: true });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        username: "player_01",
        password: "a sufficiently long password",
      },
      headers: {
        host: "codespace-3000.app.github.dev",
        origin: "https://codespace-3000.app.github.dev",
        cookie: `mud_session=${anonymousSecret}`,
        "x-csrf-token": anonymousCsrf,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(calls.join(","), "login");
  } finally {
    await app.close();
  }
});

test("login uses generic credential errors and rate limits normalized usernames", async () => {
  const { app, calls, limits } = createFixture({ invalidCredentials: true });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        username: "PLAYER_01",
        password: "a sufficiently long password",
      },
      headers: {
        origin,
        cookie: `mud_session=${anonymousSecret}`,
        "x-csrf-token": anonymousCsrf,
      },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, "AUTH_INVALID_CREDENTIALS");
    assert.equal(calls.join(","), "login");
    assert.deepEqual(
      limits.map(({ scope, subject, limit }) => ({ scope, subject, limit })),
      [
        { scope: "login-ip", subject: "127.0.0.1", limit: 20 },
        { scope: "login-username", subject: "player_01", limit: 5 },
      ],
    );
  } finally {
    await app.close();
  }
});

test("auth requests fail closed when Redis rate limiting is unavailable", async () => {
  const { app, calls } = createFixture({ limiterFailure: true });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        username: "player_01",
        password: "a sufficiently long password",
      },
      headers: {
        origin,
        cookie: `mud_session=${anonymousSecret}`,
        "x-csrf-token": anonymousCsrf,
      },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test("logout revokes the session and clears its cookie", async () => {
  const { app, calls } = createFixture();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        origin,
        cookie: `mud_session=${anonymousSecret}`,
        "x-csrf-token": anonymousCsrf,
      },
    });
    assert.equal(response.statusCode, 204);
    assert.equal(calls.join(","), "logout");
    assert.match(response.headers["set-cookie"] as string, /Max-Age=0/);
  } finally {
    await app.close();
  }
});
