import Fastify, { type FastifyInstance } from "fastify";
import type { AppEnvironment } from "./config/env.ts";
import {
  registerQueryRoutes,
  type QueryRouteDependencies,
} from "./server/query-routes.ts";

export interface AppDependencies {
  readonly queries?: QueryRouteDependencies;
}

export function createApp(
  _environment: AppEnvironment,
  dependencies: AppDependencies = {},
): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health/live", async () => ({ status: "ok" }));
  if (dependencies.queries) {
    registerQueryRoutes(app, dependencies.queries);
  }

  return app;
}
