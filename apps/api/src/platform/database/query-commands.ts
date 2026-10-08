import type {
  CreateQueryRequest,
  CreateQueryResponse,
} from "../../contracts/http.ts";
import {
  createQueryRequestSchema,
  createQueryResponseSchema,
} from "../../contracts/http.ts";
import type { PlayerActor } from "../../kernel/actor.ts";
import type { Clock, IdGenerator } from "../../kernel/ports.ts";
import { requestDigest } from "../../kernel/idempotency.ts";
import { createQuery } from "../../modules/query/public.ts";
import type { CommandExecution } from "../transactions/command-receipts.ts";
import { SqlServerCommandReceipts } from "../transactions/command-receipts.ts";
import { SqlServerQueryRepository } from "./query-repository.ts";

const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const CREATE_QUERY_OPERATION = "query.create";

export class SqlServerQueryCommands {
  constructor(
    private readonly repository: SqlServerQueryRepository,
    private readonly receipts: SqlServerCommandReceipts,
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
}
