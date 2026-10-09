import { z } from "zod";
import { uuidSchema } from "../../contracts/identifiers.ts";
import { playerActorSchema } from "../../kernel/actor.ts";
import type { PlayerActor } from "../../kernel/actor.ts";
import {
  queryCardScriptInputSchema,
  toOwnedKnowledgeItem,
} from "../../modules/script/public.ts";
import type {
  OwnedKnowledgeItem,
  QueryCardScriptInput,
} from "../../modules/script/public.ts";
import { requestDigest } from "../../kernel/idempotency.ts";
import type { IdGenerator, Clock } from "../../kernel/ports.ts";
import { PostgresCommandReceipts } from "../transactions/command-receipts.ts";
import { PostgresOutbox } from "../transactions/outbox.ts";
import type { QueryExecutor } from "../transactions/unit-of-work.ts";
import { PostgresScriptRepository } from "./script-repository.ts";

const CREATE_SCRIPT_OPERATION = "script.query-card.create";
const GRANT_KNOWLEDGE_OPERATION = "script.knowledge.grant";
const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;

const scriptResultSchema = z
  .object({
    script: z
      .object({
        scriptId: uuidSchema,
        queryId: uuidSchema,
        playerId: uuidSchema,
        cardId: uuidSchema,
        contentText: z.string().min(1),
        gameplayReleaseId: z.string().min(1),
        createdAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    created: z.boolean(),
  })
  .strict();
const knowledgeGrantResultSchema = z
  .object({ grantId: uuidSchema, created: z.boolean() })
  .strict();

export class PostgresScriptCommands {
  constructor(
    private readonly repository: PostgresScriptRepository,
    private readonly receipts: PostgresCommandReceipts,
    private readonly outbox: PostgresOutbox,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async createQueryCardScript(
    effectId: string,
    input: QueryCardScriptInput,
    traceId: string,
  ): Promise<{
    readonly scriptId: string;
    readonly created: boolean;
    readonly replayed: boolean;
  }> {
    validateEffect(effectId);
    const normalizedInput = queryCardScriptInputSchema.parse(input);
    const trace = uuidSchema.parse(traceId);
    const now = checkedNow(this.clock);
    const actor = { kind: "service", serviceId: "worker" } as const;
    const execution = await this.receipts.execute(
      {
        actorScope: "service:worker:script",
        operation: CREATE_SCRIPT_OPERATION,
        idempotencyKey: effectId,
        requestDigest: requestDigest(
          CREATE_SCRIPT_OPERATION,
          actor,
          normalizedInput,
        ),
        expiresAt: new Date(now.getTime() + RECEIPT_RETENTION_MS),
      },
      (value) => scriptResultSchema.parse(value),
      async (transaction) => {
        const result = await this.repository.createOrGetQueryCardInTransaction(
          transaction,
          {
            ...normalizedInput,
            scriptId: this.idGenerator.next(),
            createdAt: now,
          },
        );
        if (result.created) {
          await this.appendEvent(transaction, {
            type: "ScriptCreated",
            aggregateId: result.script.scriptId,
            streamId: result.script.scriptId,
            releaseVersion: result.script.gameplayReleaseId,
            occurredAt: now,
            traceId: trace,
            payload: {
              scriptId: result.script.scriptId,
              queryId: result.script.queryId,
              playerId: result.script.playerId,
              cardId: result.script.cardId,
            },
          });
        }
        return {
          result: {
            script: {
              ...result.script,
              createdAt: result.script.createdAt.toISOString(),
            },
            created: result.created,
          },
          resourceId: result.script.scriptId,
        };
      },
    );
    return {
      scriptId: execution.result.script.scriptId,
      created: execution.result.created,
      replayed: execution.replayed,
    };
  }

  async grantKnowledgeEffect(
    effectId: string,
    scriptId: string,
    playerId: string,
    sourceRef: string,
    traceId: string,
  ): Promise<{
    readonly grantId: string;
    readonly created: boolean;
    readonly replayed: boolean;
  }> {
    validateEffect(effectId);
    const normalized = {
      scriptId: uuidSchema.parse(scriptId),
      playerId: uuidSchema.parse(playerId),
      sourceRef: z.string().trim().min(1).max(256).parse(sourceRef),
    };
    const trace = uuidSchema.parse(traceId);
    const now = checkedNow(this.clock);
    const actor = { kind: "service", serviceId: "worker" } as const;
    const execution = await this.receipts.execute(
      {
        actorScope: "service:worker:knowledge",
        operation: GRANT_KNOWLEDGE_OPERATION,
        idempotencyKey: effectId,
        requestDigest: requestDigest(
          GRANT_KNOWLEDGE_OPERATION,
          actor,
          normalized,
        ),
        expiresAt: new Date(now.getTime() + RECEIPT_RETENTION_MS),
      },
      (value) => knowledgeGrantResultSchema.parse(value),
      async (transaction) => {
        const grantId = this.idGenerator.next();
        const result = await this.repository.grantKnowledgeInTransaction(
          transaction,
          { grantId, ...normalized, grantedAt: now },
        );
        if (result.created) {
          await this.appendEvent(transaction, {
            type: "KnowledgeGranted",
            aggregateId: result.grantId,
            streamId: normalized.playerId,
            releaseVersion: null,
            occurredAt: now,
            traceId: trace,
            payload: {
              grantId: result.grantId,
              scriptId: normalized.scriptId,
              playerId: normalized.playerId,
            },
          });
        }
        return {
          result: { grantId: result.grantId, created: result.created },
          resourceId: result.grantId,
        };
      },
    );
    return { ...execution.result, replayed: execution.replayed };
  }

  async listOwnedKnowledge(
    actor: PlayerActor,
  ): Promise<readonly OwnedKnowledgeItem[]> {
    const owner = playerActorSchema.parse(actor);
    const rows = await this.repository.listKnowledgeForPlayer(owner.playerId);
    return rows.map(toOwnedKnowledgeItem);
  }

  private async appendEvent(
    transaction: QueryExecutor,
    event: {
      readonly type: string;
      readonly aggregateId: string;
      readonly streamId: string;
      readonly releaseVersion: string | null;
      readonly occurredAt: Date;
      readonly traceId: string;
      readonly payload: Record<string, unknown>;
    },
  ): Promise<void> {
    const eventId = this.idGenerator.next();
    await this.outbox.append(transaction, {
      eventId,
      type: event.type,
      schemaVersion: 1,
      source: "script",
      aggregateId: event.aggregateId,
      aggregateVersion: 1,
      streamId: event.streamId,
      releaseVersion: event.releaseVersion,
      occurredAt: event.occurredAt.toISOString(),
      traceId: event.traceId,
      correlationId: event.traceId,
      causationId: null,
      rootEventId: eventId,
      depth: 0,
      payload: event.payload,
    });
  }
}

function validateEffect(effectId: string): void {
  if (!/^[\x21-\x7e]{16,128}$/.test(effectId)) {
    throw new TypeError(
      "Effect id must contain 16–128 visible ASCII characters",
    );
  }
}

function checkedNow(clock: Clock): Date {
  const now = clock.now();
  const timestamp = now.getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("Clock returned an invalid timestamp");
  }
  return now;
}
