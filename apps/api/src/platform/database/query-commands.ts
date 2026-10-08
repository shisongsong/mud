import type {
  CastVoteRequest,
  CreateQueryRequest,
  CreateQueryResponse,
  LeaveQueryRequest,
} from "../../contracts/http.ts";
import {
  castVoteRequestSchema,
  createQueryRequestSchema,
  createQueryResponseSchema,
  leaveQueryRequestSchema,
  writeReceiptSchema,
} from "../../contracts/http.ts";
import type { PlayerActor } from "../../kernel/actor.ts";
import type { Clock, IdGenerator } from "../../kernel/ports.ts";
import { requestDigest } from "../../kernel/idempotency.ts";
import type { QueryAggregate } from "../../modules/query/public.ts";
import {
  castVote,
  createQuery,
  leaveQuery,
} from "../../modules/query/public.ts";
import type { CommandExecution } from "../transactions/command-receipts.ts";
import { PostgresCommandReceipts } from "../transactions/command-receipts.ts";
import { PostgresQueryRepository } from "./query-repository.ts";

const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const CREATE_QUERY_OPERATION = "query.create";
const LEAVE_QUERY_OPERATION = "query.leave";
const CAST_VOTE_OPERATION = "query.vote";

export class PostgresQueryCommands {
  constructor(
    private readonly repository: PostgresQueryRepository,
    private readonly receipts: PostgresCommandReceipts,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  create(
    actor: PlayerActor,
    input: CreateQueryRequest,
    idempotencyKey: string,
  ): Promise<CommandExecution<CreateQueryResponse>> {
    const normalizedInput = createQueryRequestSchema.parse(input);
    const now = this.clock.now();
    const nowMs = now.getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError("Clock returned an invalid timestamp");
    }

    const digest = requestDigest(
      CREATE_QUERY_OPERATION,
      actor,
      normalizedInput,
    );
    return this.receipts.execute(
      {
        actorScope: `player:${actor.accountId}:${actor.playerId}`,
        operation: CREATE_QUERY_OPERATION,
        idempotencyKey,
        requestDigest: digest,
        expiresAt: new Date(nowMs + RECEIPT_RETENTION_MS),
      },
      (value) => createQueryResponseSchema.parse(value),
      async (transaction) => {
        const query = createQuery(
          this.idGenerator.next(),
          actor.playerId,
          normalizedInput.gameplayReleaseId,
          nowMs,
        );
        await this.repository.createInTransaction(transaction, query);
        return {
          result: {
            queryId: query.queryId,
            aggregateVersion: query.version,
          },
          resourceId: query.queryId,
        };
      },
    );
  }

  leave(
    actor: PlayerActor,
    queryId: string,
    input: LeaveQueryRequest,
    idempotencyKey: string,
  ): Promise<
    CommandExecution<{
      readonly resourceId: string;
      readonly aggregateVersion: number;
    }>
  > {
    const normalizedInput = leaveQueryRequestSchema.parse(input);
    return this.executeMutation(
      actor,
      queryId,
      LEAVE_QUERY_OPERATION,
      normalizedInput,
      idempotencyKey,
      (query, now) =>
        leaveQuery(query, actor.playerId, normalizedInput.expectedVersion, now),
    );
  }

  vote(
    actor: PlayerActor,
    queryId: string,
    input: CastVoteRequest,
    idempotencyKey: string,
  ): Promise<
    CommandExecution<{
      readonly resourceId: string;
      readonly aggregateVersion: number;
    }>
  > {
    const normalizedInput = castVoteRequestSchema.parse(input);
    return this.executeMutation(
      actor,
      queryId,
      CAST_VOTE_OPERATION,
      normalizedInput,
      idempotencyKey,
      (query, now) =>
        castVote(
          query,
          actor.playerId,
          normalizedInput.choiceId,
          normalizedInput.expectedVersion,
          now,
        ),
    );
  }

  private executeMutation<Input extends object>(
    actor: PlayerActor,
    queryId: string,
    operation: string,
    input: Input,
    idempotencyKey: string,
    mutate: (query: QueryAggregate, now: number) => QueryAggregate,
  ): Promise<
    CommandExecution<{
      readonly resourceId: string;
      readonly aggregateVersion: number;
    }>
  > {
    const now = this.clock.now();
    const nowMs = now.getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError("Clock returned an invalid timestamp");
    }
    const digest = requestDigest(operation, actor, { queryId, ...input });

    return this.receipts.execute(
      {
        actorScope: `player:${actor.accountId}:${actor.playerId}`,
        operation,
        idempotencyKey,
        requestDigest: digest,
        expiresAt: new Date(nowMs + RECEIPT_RETENTION_MS),
      },
      (value) =>
        writeReceiptSchema.parse(value) as {
          readonly resourceId: string;
          readonly aggregateVersion: number;
        },
      async (transaction) => {
        const query = await this.repository.getInTransaction(
          transaction,
          queryId,
        );
        if (query === null) {
          const error = new Error("Query not found");
          error.name = "QueryNotFoundError";
          throw error;
        }
        const updated = mutate(query, nowMs);
        const saved = await this.repository.saveInTransaction(
          transaction,
          updated,
          query.version,
        );
        if (!saved) {
          const error = new Error("Query aggregate version changed");
          error.name = "QueryConcurrencyError";
          throw error;
        }
        const result = {
          resourceId: queryId,
          aggregateVersion: updated.version,
        };
        return { result, resourceId: queryId };
      },
    );
  }
}
