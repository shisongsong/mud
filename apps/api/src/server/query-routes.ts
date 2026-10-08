import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { idempotencyKeySchema } from "../contracts/command.ts";
import {
  createQueryRequestSchema,
  createQueryResponseSchema,
} from "../contracts/http.ts";
import type {
  CreateQueryRequest,
  CreateQueryResponse,
} from "../contracts/http.ts";
import type { PlayerActor } from "../kernel/actor.ts";

export interface QueryCreationCommand {
  create(
    actor: PlayerActor,
    input: CreateQueryRequest,
    idempotencyKey: string,
  ): Promise<{
    readonly result: CreateQueryResponse;
    readonly replayed: boolean;
  }>;
}

export interface QueryRouteDependencies {
  readonly commands: QueryCreationCommand;
  readonly authenticatePlayer: (
    request: FastifyRequest,
  ) => Promise<PlayerActor | null>;
}

export function registerQueryRoutes(
  app: FastifyInstance,
  dependencies: QueryRouteDependencies,
): void {
  app.post("/queries", async (request, reply) => {
    const traceId = randomUUID();
    const actor = await dependencies.authenticatePlayer(request);
    if (actor === null) {
      return reply.code(401).send({
        code: "UNAUTHENTICATED",
        messageKey: "api.unauthenticated",
        args: {},
        traceId,
      });
    }

    const parsedBody = createQueryRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        code: "INVALID_REQUEST",
        messageKey: "api.invalid_request",
        args: {},
        traceId,
      });
    }

    const rawKey = request.headers["idempotency-key"];
    const parsedKey = idempotencyKeySchema.safeParse(rawKey);
    if (!parsedKey.success) {
      return reply.code(400).send({
        code: "INVALID_IDEMPOTENCY_KEY",
        messageKey: "api.invalid_idempotency_key",
        args: {},
        traceId,
      });
    }

    try {
      const execution = await dependencies.commands.create(
        actor,
        parsedBody.data,
        parsedKey.data,
      );
      const result = createQueryResponseSchema.parse(execution.result);
      reply.header("Location", `/queries/${result.queryId}`);
      return reply.code(execution.replayed ? 200 : 201).send(result);
    } catch (error: unknown) {
      if (hasErrorCode(error, "IDEMPOTENCY_CONFLICT")) {
        return reply.code(409).send({
          code: "IDEMPOTENCY_CONFLICT",
          messageKey: "api.idempotency_conflict",
          args: {},
          traceId,
        });
      }
      request.log.error({ traceId }, "Query creation failed");
      return reply.code(500).send({
        code: "INTERNAL_ERROR",
        messageKey: "api.internal_error",
        args: {},
        traceId,
      });
    }
  });
}

function hasErrorCode(error: unknown, code: "IDEMPOTENCY_CONFLICT"): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
