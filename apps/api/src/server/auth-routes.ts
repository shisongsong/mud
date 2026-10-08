import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  loginRequestSchema,
  registerAccountRequestSchema,
  sessionViewSchema,
} from "../contracts/http.ts";
import {
  AuthInvalidCredentialsError,
  AuthSessionError,
  UsernameUnavailableError,
} from "../platform/identity.ts";
import type {
  IssuedSession,
  PostgresIdentityService,
} from "../platform/identity.ts";
import { normalizeUsername } from "../platform/identity.ts";
import type { AuthRateLimiter } from "../platform/auth-rate-limiter.ts";

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

export interface AuthRouteDependencies {
  readonly identity: Pick<
    PostgresIdentityService,
    | "getOrCreateSession"
    | "register"
    | "login"
    | "logout"
    | "validateCsrf"
  >;
  readonly rateLimiter: AuthRateLimiter;
  readonly publicOrigin: string;
  readonly secureCookies: boolean;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: AuthRouteDependencies,
): void {
  const cookieName = dependencies.secureCookies
    ? "__Host-mud_session"
    : "mud_session";

  app.get("/auth/session", async (request, reply) => {
    try {
      const issued = await dependencies.identity.getOrCreateSession(
        readSessionSecret(request, dependencies.secureCookies),
      );
      if (issued.cookieChanged) setSessionCookie(reply, cookieName, issued, dependencies.secureCookies);
      return reply.send(sessionViewSchema.parse(issued.view));
    } catch {
      return sendServiceUnavailable(reply, randomUUID());
    }
  });

  app.post("/auth/register", async (request, reply) => {
    const traceId = randomUUID();
    if (!hasAllowedOrigin(request, dependencies.publicOrigin)) {
      return sendError(reply, 403, "ORIGIN_REJECTED", "auth.originRejected", traceId);
    }
    const body = registerAccountRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "api.invalid_request", traceId);
    }
    const secret = readSessionSecret(request, dependencies.secureCookies);
    const csrfToken = readHeader(request.headers["x-csrf-token"]);
    const csrfValid = await validateCsrf(dependencies.identity, secret, csrfToken);
    if (csrfValid === null) return sendServiceUnavailable(reply, traceId);
    if (!csrfValid) {
      return sendError(reply, 403, "CSRF_REJECTED", "auth.csrfRejected", traceId);
    }
    const withinLimit = await consumeLimit(
      dependencies.rateLimiter,
      "register-ip",
      request.ip,
      5,
      REGISTER_WINDOW_MS,
    );
    if (withinLimit === null) return sendServiceUnavailable(reply, traceId);
    if (!withinLimit) {
      return sendError(reply, 429, "RATE_LIMITED", "auth.rateLimited", traceId);
    }

    try {
      const issued = await dependencies.identity.register(
        secret!,
        csrfToken!,
        body.data.username,
        body.data.password,
      );
      setSessionCookie(reply, cookieName, issued, dependencies.secureCookies);
      return reply.code(201).send(sessionViewSchema.parse(issued.view));
    } catch (error: unknown) {
      if (error instanceof AuthSessionError) {
        return sendError(reply, 403, "CSRF_REJECTED", "auth.csrfRejected", traceId);
      }
      if (error instanceof UsernameUnavailableError) {
        return sendError(reply, 409, "USERNAME_UNAVAILABLE", "auth.usernameUnavailable", traceId);
      }
      return sendServiceUnavailable(reply, traceId);
    }
  });

  app.post("/auth/login", async (request, reply) => {
    const traceId = randomUUID();
    if (!hasAllowedOrigin(request, dependencies.publicOrigin)) {
      return sendError(reply, 403, "ORIGIN_REJECTED", "auth.originRejected", traceId);
    }
    const body = loginRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "api.invalid_request", traceId);
    }
    const secret = readSessionSecret(request, dependencies.secureCookies);
    const csrfToken = readHeader(request.headers["x-csrf-token"]);
    const csrfValid = await validateCsrf(dependencies.identity, secret, csrfToken);
    if (csrfValid === null) return sendServiceUnavailable(reply, traceId);
    if (!csrfValid) {
      return sendError(reply, 403, "CSRF_REJECTED", "auth.csrfRejected", traceId);
    }
    const username = normalizeUsername(body.data.username);
    const withinIpLimit = await consumeLimit(
      dependencies.rateLimiter,
      "login-ip",
      request.ip,
      20,
      LOGIN_WINDOW_MS,
    );
    const withinUsernameLimit = await consumeLimit(
      dependencies.rateLimiter,
      "login-username",
      username,
      5,
      LOGIN_WINDOW_MS,
    );
    if (withinIpLimit === null || withinUsernameLimit === null) {
      return sendServiceUnavailable(reply, traceId);
    }
    if (!withinIpLimit || !withinUsernameLimit) {
      return sendError(reply, 429, "RATE_LIMITED", "auth.rateLimited", traceId);
    }

    try {
      const issued = await dependencies.identity.login(
        secret!,
        csrfToken!,
        body.data.username,
        body.data.password,
      );
      setSessionCookie(reply, cookieName, issued, dependencies.secureCookies);
      return reply.send(sessionViewSchema.parse(issued.view));
    } catch (error: unknown) {
      if (error instanceof AuthInvalidCredentialsError) {
        return sendError(
          reply,
          401,
          "AUTH_INVALID_CREDENTIALS",
          "auth.invalidCredentials",
          traceId,
        );
      }
      if (error instanceof AuthSessionError) {
        return sendError(reply, 403, "CSRF_REJECTED", "auth.csrfRejected", traceId);
      }
      return sendServiceUnavailable(reply, traceId);
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    const traceId = randomUUID();
    if (!hasAllowedOrigin(request, dependencies.publicOrigin)) {
      return sendError(reply, 403, "ORIGIN_REJECTED", "auth.originRejected", traceId);
    }
    const secret = readSessionSecret(request, dependencies.secureCookies);
    const csrfToken = readHeader(request.headers["x-csrf-token"]);
    const csrfValid = await validateCsrf(dependencies.identity, secret, csrfToken);
    if (csrfValid === null) return sendServiceUnavailable(reply, traceId);
    if (!csrfValid) {
      return sendError(reply, 403, "CSRF_REJECTED", "auth.csrfRejected", traceId);
    }
    try {
      await dependencies.identity.logout(secret!, csrfToken!);
      reply.header(
        "Set-Cookie",
        `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${dependencies.secureCookies ? "; Secure" : ""}`,
      );
      return reply.code(204).send();
    } catch {
      return sendServiceUnavailable(reply, traceId);
    }
  });
}

async function consumeLimit(
  limiter: AuthRateLimiter,
  scope: "login-ip" | "login-username" | "register-ip",
  subject: string,
  limit: number,
  windowMs: number,
): Promise<boolean | null> {
  try {
    return await limiter.consume(scope, subject, limit, windowMs);
  } catch {
    return null;
  }
}

async function validateCsrf(
  identity: AuthRouteDependencies["identity"],
  secret: string | null,
  csrfToken: string | null,
): Promise<boolean | null> {
  try {
    return await identity.validateCsrf(secret, csrfToken);
  } catch {
    return null;
  }
}

function hasAllowedOrigin(request: FastifyRequest, expectedOrigin: string): boolean {
  const origin = readHeader(request.headers.origin);
  if (!origin || origin === "null") return false;
  try {
    return new URL(origin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

export function readSessionSecret(
  request: FastifyRequest,
  secureCookies: boolean,
): string | null {
  return readCookie(
    request,
    secureCookies ? "__Host-mud_session" : "mud_session",
  );
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = readHeader(request.headers.cookie);
  if (!header) return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 ? values[0]! : null;
}

function readHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function setSessionCookie(
  reply: FastifyReply,
  name: string,
  issued: IssuedSession,
  secure: boolean,
): void {
  const maxAge = Math.max(
    0,
    Math.floor((Date.parse(issued.view.expiresAt) - Date.now()) / 1000),
  );
  reply.header(
    "Set-Cookie",
    `${name}=${issued.sessionSecret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
  );
}

function sendServiceUnavailable(reply: FastifyReply, traceId: string) {
  return sendError(reply, 503, "AUTH_UNAVAILABLE", "auth.unavailable", traceId);
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  messageKey: string,
  traceId: string,
) {
  return reply.code(status).send({ code, messageKey, args: {}, traceId });
}
