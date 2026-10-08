import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import type { ActiveGameplayRelease } from "../platform/database/gameplay-release-repository.ts";

export interface GameplayRouteDependencies {
  readonly getActiveGameplayRelease: () => Promise<ActiveGameplayRelease | null>;
}

export function registerGameplayRoutes(
  app: FastifyInstance,
  dependencies: GameplayRouteDependencies,
): void {
  app.get("/gameplay/release", async (_request, reply) => {
    const traceId = randomUUID();
    try {
      const release = await dependencies.getActiveGameplayRelease();
      if (!release) return sendNotReady(reply, traceId);
      return reply.send({
        gameplayReleaseId: release.releaseId,
        queryEnabled: release.queryEnabled,
        templateIds: release.templates,
      });
    } catch {
      return sendNotReady(reply, traceId);
    }
  });
}

function sendNotReady(reply: FastifyReply, traceId: string) {
  return reply.code(503).send({
    code: "GAMEPLAY_NOT_READY",
    messageKey: "gameplay.notReady",
    args: {},
    traceId,
  });
}