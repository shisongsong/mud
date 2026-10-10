import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PlayerActor } from "../kernel/actor.ts";
import type { BoardSnapshotReader } from "../platform/database/board-views.ts";
import { readSessionSecret } from "./auth-routes.ts";

export interface BoardRouteDependencies {
  readonly identity: {
    authenticate(
      secret: string | null,
    ): Promise<{ readonly accountId: string } | null>;
  };
  readonly secureCookies: boolean;
  readonly getPlayerActor: (accountId: string) => Promise<PlayerActor | null>;
  readonly views: BoardSnapshotReader;
}

export function registerBoardRoutes(
  app: FastifyInstance,
  dependencies: BoardRouteDependencies,
): void {
  app.get("/board", async (request, reply) => {
    const traceId = randomUUID();
    let identity;
    try {
      identity = await dependencies.identity.authenticate(
        readSessionSecret(request, dependencies.secureCookies),
      );
    } catch {
      return reply.code(503).send({
        code: "AUTH_UNAVAILABLE",
        messageKey: "auth.unavailable",
        args: {},
        traceId,
      });
    }
    if (!identity) {
      return reply.code(401).send({
        code: "UNAUTHENTICATED",
        messageKey: "api.unauthenticated",
        args: {},
        traceId,
      });
    }

    try {
      const actor = await dependencies.getPlayerActor(identity.accountId);
      if (!actor) {
        return reply.code(404).send({
          code: "PLAYER_NOT_FOUND",
          messageKey: "player.not_found",
          args: {},
          traceId,
        });
      }
      return reply.send(await dependencies.views.getSnapshot());
    } catch {
      request.log.error({ traceId }, "Board snapshot lookup failed");
      return reply.code(503).send({
        code: "BOARD_UNAVAILABLE",
        messageKey: "board.unavailable",
        args: {},
        traceId,
      });
    }
  });
}
