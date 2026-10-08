import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { idempotencyKeySchema } from "../contracts/command.ts";
import {
  castVoteRequestSchema,
  createQueryRequestSchema,
  createQueryResponseSchema,
  leaveQueryRequestSchema,
  writeReceiptSchema,
} from "../contracts/http.ts";
import type {
  CastVoteRequest,
  CreateQueryRequest,
  CreateQueryResponse,
  LeaveQueryRequest,
} from "../contracts/http.ts";
import { uuidSchema } from "../contracts/identifiers.ts";
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
  leave?(
    actor: PlayerActor,
    queryId: string,
    input: LeaveQueryRequest,
    idempotencyKey: string,
  ): Promise<{
    readonly result: {
      readonly resourceId: string;
      readonly aggregateVersion: number;
    };
    readonly replayed: boolean;
  }>;
  vote?(
    actor: PlayerActor,
    queryId: string,
    input: CastVoteRequest,
    idempotencyKey: string,
  ): Promise<{
    readonly result: {
      readonly resourceId: string;
      readonly aggregateVersion: number;
    };
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

  const leaveCommand = dependencies.commands.leave;
  if (leaveCommand) {
    app.post("/query/:queryId/leave", async (request, reply) => {
      const traceId = randomUUID();
      const actor = await dependencies.authenticatePlayer(request);
      if (!actor) return sendUnauthenticated(reply, traceId);

      const params = queryIdParamsSchema.safeParse(request.params);
      const body = leaveQueryRequestSchema.safeParse(request.body);
      const idempotencyKey = parseIdempotencyKey(
        request.headers["idempotency-key"],
      );
      if (!params.success || !body.success || idempotencyKey === null) {
        return sendInvalidRequest(reply, traceId);
      }

      try {
        const execution = await leaveCommand(
          actor,
          params.data.queryId,
          body.data,
          idempotencyKey,
        );
        return reply.code(200).send(writeReceiptSchema.parse(execution.result));
      } catch (error: unknown) {
        return sendCommandError(request, reply, error, traceId);
      }
    });
  }

  const voteCommand = dependencies.commands.vote;
  if (voteCommand) {
    app.post("/query/:queryId/vote", async (request, reply) => {
      const traceId = randomUUID();
      const actor = await dependencies.authenticatePlayer(request);
      if (!actor) return sendUnauthenticated(reply, traceId);

      const params = queryIdParamsSchema.safeParse(request.params);
      const body = castVoteRequestSchema.safeParse(request.body);
      const idempotencyKey = parseIdempotencyKey(
        request.headers["idempotency-key"],
      );
      if (!params.success || !body.success || idempotencyKey === null) {
        return sendInvalidRequest(reply, traceId);
      }

      try {
        const execution = await voteCommand(
          actor,
          params.data.queryId,
          body.data,
          idempotencyKey,
        );
        return reply.code(200).send(writeReceiptSchema.parse(execution.result));
      } catch (error: unknown) {
        return sendCommandError(request, reply, error, traceId);
      }
    });
  }
}

const queryIdParamsSchema = z.object({ queryId: uuidSchema }).strict();

function parseIdempotencyKey(value: unknown): string | null {
  const parsed = idempotencyKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function sendUnauthenticated(reply: FastifyReply, traceId: string) {
  return reply.code(401).send({
    code: "UNAUTHENTICATED",
    messageKey: "api.unauthenticated",
    args: {},
    traceId,
  });
}

function sendInvalidRequest(reply: FastifyReply, traceId: string) {
  return reply.code(400).send({
    code: "INVALID_REQUEST",
    messageKey: "api.invalid_request",
    args: {},
    traceId,
  });
}

function sendCommandError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  traceId: string,
) {
  if (hasErrorCode(error, "IDEMPOTENCY_CONFLICT")) {
    return reply.code(409).send({
      code: "IDEMPOTENCY_CONFLICT",
      messageKey: "api.idempotency_conflict",
      args: {},
      traceId,
    });
  }
  if (hasErrorName(error, "QueryNotFoundError")) {
    return reply.code(404).send({
      code: "NOT_FOUND",
      messageKey: "api.not_found",
      args: {},
      traceId,
    });
  }
  if (hasErrorCode(error, "QUERY_NOT_MEMBER")) {
    return reply.code(404).send({
      code: "NOT_FOUND",
      messageKey: "api.not_found",
      args: {},
      traceId,
    });
  }
  if (
    hasErrorName(error, "QueryConcurrencyError") ||
    hasErrorCode(error, "INVALID_EXPECTED_VERSION") ||
    hasQueryRuleCode(error)
  ) {
    return reply.code(409).send({
      code: "QUERY_CONFLICT",
      messageKey: "query.conflict",
      args: {},
      traceId,
    });
  }
  request.log.error({ traceId }, "Query command failed");
  return reply.code(500).send({
    code: "INTERNAL_ERROR",
    messageKey: "api.internal_error",
    args: {},
    traceId,
  });
}

function hasErrorName(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === name
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function hasQueryRuleCode(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("QUERY_")
  );
}
