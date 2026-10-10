import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { AppEnvironment } from "./config/env.ts";
import {
  registerAuthRoutes,
  type AuthRouteDependencies,
} from "./server/auth-routes.ts";
import { readSessionSecret } from "./server/auth-routes.ts";
import {
  registerPlayerRoutes,
  type PlayerRouteDependencies,
} from "./server/player-routes.ts";
import {
  registerGameplayRoutes,
  type GameplayRouteDependencies,
} from "./server/gameplay-routes.ts";
import {
  registerQueryRoutes,
  type QueryRouteDependencies,
} from "./server/query-routes.ts";
import { registerPlayRoutes } from "./server/play-routes.ts";
import { isSameOriginRequest } from "./server/origin.ts";
import {
  registerBoardRoutes,
  type BoardRouteDependencies,
} from "./server/board-routes.ts";

export interface AppDependencies {
  readonly auth?: AuthRouteDependencies;
  readonly players?: PlayerRouteDependencies;
  readonly gameplay?: GameplayRouteDependencies;
  readonly queries?: QueryRouteDependencies;
  readonly board?: BoardRouteDependencies;
  readonly checkReadiness?: () => Promise<void>;
}

export function createApp(
  _environment: AppEnvironment,
  dependencies: AppDependencies = {},
): FastifyInstance {
  const app = Fastify({ logger: false });

  registerPlayRoutes(app);
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    if (!dependencies.checkReadiness) {
      return reply.code(503).send({ status: "not_ready" });
    }
    try {
      await dependencies.checkReadiness();
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
  const auth = dependencies.auth;
  if (auth) {
    app.addHook("preHandler", async (request, reply) => {
      if (
        request.method === "GET" ||
        request.method === "HEAD" ||
        request.method === "OPTIONS" ||
        request.url.startsWith("/auth/")
      ) {
        return;
      }
      if (
        !isSameOriginRequest(
          request,
          auth.publicOrigin,
          auth.allowHostOriginFallback ?? false,
        )
      ) {
        const traceId = randomUUID();
        return reply.code(403).send({
          code: "ORIGIN_REJECTED",
          messageKey: "auth.originRejected",
          args: {},
          traceId,
        });
      }
      try {
        const csrfToken = request.headers["x-csrf-token"];
        const valid = await auth.identity.validateCsrf(
          readSessionSecret(request, auth.secureCookies),
          typeof csrfToken === "string" ? csrfToken : null,
        );
        if (!valid) {
          const traceId = randomUUID();
          return reply.code(403).send({
            code: "CSRF_REJECTED",
            messageKey: "auth.csrfRejected",
            args: {},
            traceId,
          });
        }
      } catch {
        const traceId = randomUUID();
        return reply.code(503).send({
          code: "AUTH_UNAVAILABLE",
          messageKey: "auth.unavailable",
          args: {},
          traceId,
        });
      }
    });
  }
  if (dependencies.auth) {
    registerAuthRoutes(app, dependencies.auth);
  }
  if (dependencies.players) {
    registerPlayerRoutes(app, dependencies.players);
  }
  if (dependencies.gameplay) {
    registerGameplayRoutes(app, dependencies.gameplay);
  }
  if (dependencies.queries) {
    registerQueryRoutes(app, dependencies.queries);
  }
  if (dependencies.board) {
    registerBoardRoutes(app, dependencies.board);
  }

  return app;
}
