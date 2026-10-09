import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../app.ts";
import { loadEnvironment } from "../config/env.ts";
import type { AuthRouteDependencies } from "./auth-routes.ts";
import type { PlayerRouteDependencies } from "./player-routes.ts";

const origin = "https://game.example.com";
const sessionSecret = "A".repeat(43);
const csrfToken = "B".repeat(43);
const accountId = "11111111-1111-4111-8111-111111111111";
const profile = {
  playerId: "22222222-2222-4222-8222-222222222222",
  accountId,
  displayName: "Ada",
  factionId: "faction_1" as const,
  powerId: "power_1" as const,
  professionId: "profession_1" as const,
  gameplayReleaseId: "gameplay_v1",
  score: 1000,
  aggregateVersion: 1,
};
const knowledgeItem = {
  scriptId: "33333333-3333-4333-8333-333333333333",
  content: "An authorized clue",
  receivedAt: "2026-10-09T12:00:00.000Z",
};

function createFixture(
  options: { readonly allowHostOriginFallback?: boolean } = {},
) {
  let createCalls = 0;
  let knowledgeCalls = 0;
  const identity: AuthRouteDependencies["identity"] &
    PlayerRouteDependencies["identity"] = {
    getOrCreateSession: async () => ({
      cookieChanged: false,
      sessionSecret,
      view: {
        authenticated: true,
        accountId,
        expiresAt: "2026-10-09T12:00:00.000Z",
        csrfToken,
        mfaRequired: false,
      },
    }),
    register: async () => {
      throw new Error("unused");
    },
    login: async () => {
      throw new Error("unused");
    },
    logout: async () => undefined,
    validateCsrf: async (secret, token) =>
      secret === sessionSecret && token === csrfToken,
    authenticate: async (secret) =>
      secret === sessionSecret
        ? {
            accountId,
            csrfToken,
            expiresAt: new Date("2026-10-09T12:00:00.000Z"),
          }
        : null,
  };
  const auth: AuthRouteDependencies = {
    identity,
    rateLimiter: { consume: async () => true },
    publicOrigin: origin,
    secureCookies: false,
    ...(options.allowHostOriginFallback === undefined
      ? {}
      : { allowHostOriginFallback: options.allowHostOriginFallback }),
  };
  const players: PlayerRouteDependencies = {
    identity,
    secureCookies: false,
    getByAccountId: async (receivedAccountId) =>
      receivedAccountId === accountId ? profile : null,
    listOwnedKnowledge: async (actor) => {
      assert.deepEqual(actor, {
        kind: "player",
        accountId,
        playerId: profile.playerId,
      });
      knowledgeCalls += 1;
      return [knowledgeItem];
    },
    commands: {
      create: async (receivedAccountId, input, key, traceId) => {
        assert.equal(receivedAccountId, accountId);
        assert.equal(input.displayName, "Ada");
        assert.equal(key, "create-player-key-0001");
        assert.match(traceId, /^[0-9a-f-]{36}$/);
        createCalls += 1;
        return {
          replayed: false,
          result: {
            playerId: profile.playerId,
            displayName: profile.displayName,
            factionId: profile.factionId,
            powerId: profile.powerId,
            professionId: profile.professionId,
            aggregateVersion: 1,
          },
        };
      },
    },
  };
  const app = createApp(loadEnvironment({ NODE_ENV: "test" }), {
    auth,
    players,
  });
  return {
    app,
    get createCalls() {
      return createCalls;
    },
    get knowledgeCalls() {
      return knowledgeCalls;
    },
  };
}

test("player creation is behind session, same-origin, CSRF, and idempotency checks", async () => {
  const fixture = createFixture({ allowHostOriginFallback: true });
  try {
    const payload = {
      displayName: "Ada",
      factionId: "faction_1",
      powerId: "power_1",
      professionId: "profession_1",
      gameplayReleaseId: "gameplay_v1",
    };
    const crossOrigin = await fixture.app.inject({
      method: "POST",
      url: "/players",
      payload,
      headers: {
        origin: "https://attacker.example",
        cookie: `mud_session=${sessionSecret}`,
        "x-csrf-token": csrfToken,
        "idempotency-key": "create-player-key-0001",
      },
    });
    assert.equal(crossOrigin.statusCode, 403);
    assert.equal(fixture.createCalls, 0);

    const missingCsrf = await fixture.app.inject({
      method: "POST",
      url: "/players",
      payload,
      headers: {
        host: "codespace-3000.app.github.dev",
        origin: "https://codespace-3000.app.github.dev",
        cookie: `mud_session=${sessionSecret}`,
        "idempotency-key": "create-player-key-0001",
      },
    });
    assert.equal(missingCsrf.statusCode, 403);
    assert.equal(fixture.createCalls, 0);

    const created = await fixture.app.inject({
      method: "POST",
      url: "/players",
      payload,
      headers: {
        origin,
        cookie: `mud_session=${sessionSecret}`,
        "x-csrf-token": csrfToken,
        "idempotency-key": "create-player-key-0001",
      },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.headers.location, `/players/${profile.playerId}`);
    assert.equal(created.json().playerId, profile.playerId);
    assert.equal(fixture.createCalls, 1);
  } finally {
    await fixture.app.close();
  }
});

test("player profile lookup requires an authenticated session and omits account internals", async () => {
  const fixture = createFixture();
  try {
    const response = await fixture.app.inject({
      method: "GET",
      url: "/players/me",
      headers: { cookie: `mud_session=${sessionSecret}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      playerId: profile.playerId,
      displayName: profile.displayName,
      factionId: profile.factionId,
      powerId: profile.powerId,
      professionId: profile.professionId,
      aggregateVersion: 1,
    });

    const unauthenticated = await fixture.app.inject({
      method: "GET",
      url: "/players/me",
    });
    assert.equal(unauthenticated.statusCode, 401);
  } finally {
    await fixture.app.close();
  }
});

test("owned Knowledge route requires a session and returns only public item fields", async () => {
  const fixture = createFixture();
  try {
    const response = await fixture.app.inject({
      method: "GET",
      url: "/players/me/knowledge",
      headers: { cookie: `mud_session=${sessionSecret}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { items: [knowledgeItem] });
    assert.equal(fixture.knowledgeCalls, 1);

    const unauthenticated = await fixture.app.inject({
      method: "GET",
      url: "/players/me/knowledge",
    });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(fixture.knowledgeCalls, 1);
  } finally {
    await fixture.app.close();
  }
});
