import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { idempotencyKeySchema } from "../contracts/command.ts";
import {
  createPlayerRequestSchema,
  createPlayerResponseSchema,
} from "../contracts/http.ts";
import type { PlayerActor } from "../kernel/actor.ts";
import type { OwnedKnowledgeItem } from "../modules/script/public.ts";
import type { PostgresIdentityService } from "../platform/identity.ts";
import type { PostgresPlayerCommands } from "../platform/database/player-commands.ts";
import type { PlayerProfile } from "../platform/database/player-repository.ts";
import { readSessionSecret } from "./auth-routes.ts";

export interface PlayerRouteDependencies {
  readonly identity: Pick<PostgresIdentityService, "authenticate">;
  readonly commands: Pick<PostgresPlayerCommands, "create">;
  readonly getByAccountId: (accountId: string) => Promise<PlayerProfile | null>;
  readonly listOwnedKnowledge: (
    actor: PlayerActor,
  ) => Promise<readonly OwnedKnowledgeItem[]>;
  readonly secureCookies: boolean;
}

export function registerPlayerRoutes(
  app: FastifyInstance,
  dependencies: PlayerRouteDependencies,
): void {
  app.get("/players/me", async (request, reply) => {
    const traceId = randomUUID();
    try {
      const identity = await dependencies.identity.authenticate(
        readSessionSecret(request, dependencies.secureCookies),
      );
      if (!identity) {
        return sendError(reply, 401, "UNAUTHENTICATED", "api.unauthenticated", traceId);
      }
      const profile = await dependencies.getByAccountId(identity.accountId);
      if (!profile) {
        return sendError(reply, 404, "PLAYER_NOT_FOUND", "player.not_found", traceId);
      }
      return reply.send({
        playerId: profile.playerId,
        displayName: profile.displayName,
        factionId: profile.factionId,
        powerId: profile.powerId,
        professionId: profile.professionId,
        aggregateVersion: profile.aggregateVersion,
      });
    } catch {
      return sendError(reply, 503, "AUTH_UNAVAILABLE", "auth.unavailable", traceId);
    }
  });

  app.get("/players/me/knowledge", async (request, reply) => {
    const traceId = randomUUID();
    let identity;
    try {
      identity = await dependencies.identity.authenticate(
        readSessionSecret(request, dependencies.secureCookies),
      );
    } catch {
      return sendError(reply, 503, "AUTH_UNAVAILABLE", "auth.unavailable", traceId);
    }
    if (!identity) {
      return sendError(reply, 401, "UNAUTHENTICATED", "api.unauthenticated", traceId);
    }

    let profile: PlayerProfile | null;
    try {
      profile = await dependencies.getByAccountId(identity.accountId);
    } catch {
      request.log.error({ traceId }, "Knowledge owner lookup failed");
      return sendError(reply, 503, "PLAYER_UNAVAILABLE", "player.unavailable", traceId);
    }
    if (!profile) {
      return sendError(reply, 404, "PLAYER_NOT_FOUND", "player.not_found", traceId);
    }

    try {
      const items = await dependencies.listOwnedKnowledge({
        kind: "player",
        accountId: identity.accountId,
        playerId: profile.playerId,
      });
      return reply.send({ items });
    } catch {
      request.log.error({ traceId }, "Knowledge lookup failed");
      return sendError(reply, 503, "KNOWLEDGE_UNAVAILABLE", "knowledge.unavailable", traceId);
    }
  });

  app.post("/players", async (request, reply) => {
    const traceId = randomUUID();
    let identity;
    try {
      identity = await dependencies.identity.authenticate(
        readSessionSecret(request, dependencies.secureCookies),
      );
    } catch {
      return sendError(reply, 503, "AUTH_UNAVAILABLE", "auth.unavailable", traceId);
    }
    if (!identity) {
      return sendError(reply, 401, "UNAUTHENTICATED", "api.unauthenticated", traceId);
    }

    const body = createPlayerRequestSchema.safeParse(request.body);
    const key = idempotencyKeySchema.safeParse(
      request.headers["idempotency-key"],
    );
    if (!body.success || !key.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "api.invalid_request", traceId);
    }

    try {
      const execution = await dependencies.commands.create(
        identity.accountId,
        body.data,
        key.data,
        traceId,
      );
      const result = createPlayerResponseSchema.parse(execution.result);
      reply.header("Location", `/players/${result.playerId}`);
      return reply.code(execution.replayed ? 200 : 201).send(result);
    } catch (error: unknown) {
      if (hasErrorCode(error, "IDEMPOTENCY_CONFLICT")) {
        return sendError(reply, 409, "IDEMPOTENCY_CONFLICT", "api.idempotency_conflict", traceId);
      }
      if (hasErrorCode(error, "PLAYER_ALREADY_EXISTS")) {
        return sendError(reply, 409, "PLAYER_ALREADY_EXISTS", "player.already_exists", traceId);
      }
      if (hasErrorCode(error, "GAMEPLAY_NOT_READY")) {
        return sendError(reply, 503, "GAMEPLAY_NOT_READY", "gameplay.notReady", traceId);
      }
      if (hasErrorCode(error, "GAMEPLAY_RELEASE_CHANGED")) {
        return sendError(reply, 409, "GAMEPLAY_RELEASE_CHANGED", "gameplay.releaseChanged", traceId);
      }
      request.log.error({ traceId }, "Player creation failed");
      return sendError(reply, 500, "INTERNAL_ERROR", "api.internal_error", traceId);
    }
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
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