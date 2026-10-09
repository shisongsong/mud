import type { FastifyInstance } from "fastify";
import { playPageHtml } from "./play-page.ts";

export function registerPlayRoutes(app: FastifyInstance): void {
  app.get("/", async (_request, reply) => reply.redirect("/play"));
  app.get("/play", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(playPageHtml),
  );
}
