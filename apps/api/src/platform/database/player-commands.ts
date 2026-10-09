import type {
  CreatePlayerRequest,
  CreatePlayerResponse,
} from "../../contracts/http.ts";
import {
  createPlayerRequestSchema,
  createPlayerResponseSchema,
} from "../../contracts/http.ts";
import type { AccountActor } from "../../kernel/actor.ts";
import { z } from "zod";
import { requestDigest } from "../../kernel/idempotency.ts";
import type { Clock, IdGenerator } from "../../kernel/ports.ts";
import type { CommandExecution } from "../transactions/command-receipts.ts";
import { PostgresCommandReceipts } from "../transactions/command-receipts.ts";
import { PostgresOutbox } from "../transactions/outbox.ts";
import type { QueryExecutor } from "../transactions/unit-of-work.ts";
import type { GameplayReleaseReader } from "./gameplay-release-repository.ts";
import { requireGameplayRelease } from "./gameplay-release-repository.ts";
import {
  PostgresPlayerRepository,
  type PlayerScoreEffect,
} from "./player-repository.ts";

const CREATE_PLAYER_OPERATION = "player.create";
const APPLY_SCORE_OPERATION = "player.score.apply";
const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const playerScoreEffectSchema = z
  .object({
    effectId: z.string().min(1).max(256),
    playerId: z.string().min(1),
    requestedDelta: z.number().int().min(0).max(1_000_000_000),
    effectiveDelta: z.number().int().min(0).max(1_000_000_000),
    scoreBefore: z.number().int().min(0).max(1_000_000_000),
    scoreAfter: z.number().int().min(0).max(1_000_000_000),
    aggregateVersion: z.number().int().positive(),
    clamped: z.boolean(),
    reasonRef: z.string().min(1).max(256),
  })
  .strict();
const scoreEffectReceiptSchema = z
  .object({
    effect: playerScoreEffectSchema,
    replayed: z.boolean(),
  })
  .strict();

export class PlayerAlreadyExistsError extends Error {
  readonly code = "PLAYER_ALREADY_EXISTS";

  constructor() {
    super("An account can have only one player profile");
    this.name = "PlayerAlreadyExistsError";
  }
}

export class PostgresPlayerCommands {
  constructor(
    private readonly repository: PostgresPlayerRepository,
    private readonly receipts: PostgresCommandReceipts,
    private readonly outbox: PostgresOutbox,
    private readonly gameplayReleases: GameplayReleaseReader,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async applyScoreEffect(
    effectId: string,
    playerId: string,
    requestedDelta: number,
    reasonRef: string,
    traceId: string,
  ): Promise<{
    readonly effect: PlayerScoreEffect;
    readonly replayed: boolean;
  }> {
    if (
      effectId.trim().length === 0 ||
      effectId.length < 16 ||
      effectId.length > 128 ||
      !/^[\x21-\x7e]+$/.test(effectId) ||
      reasonRef.trim().length === 0 ||
      reasonRef.length > 256 ||
      !Number.isSafeInteger(requestedDelta) ||
      requestedDelta < 0 ||
      requestedDelta > 1_000_000_000
    ) {
      throw new TypeError("Invalid player score effect");
    }
    const now = this.clock.now();
    const nowMs = now.getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError("Clock returned an invalid timestamp");
    }
    const operationActor = { kind: "service", serviceId: "worker" } as const;
    const execution = await this.receipts.execute(
      {
        actorScope: "service:worker:score",
        operation: APPLY_SCORE_OPERATION,
        idempotencyKey: effectId,
        requestDigest: requestDigest(APPLY_SCORE_OPERATION, operationActor, {
          playerId,
          requestedDelta,
          reasonRef,
        }),
        expiresAt: new Date(nowMs + RECEIPT_RETENTION_MS),
      },
      (value) => scoreEffectReceiptSchema.parse(value),
      async (transaction) => {
        const applied = await this.repository.applyScoreEffectInTransaction(
          transaction,
          { effectId, playerId, requestedDelta, reasonRef, appliedAt: nowMs },
        );
        if (!applied.replayed) {
          await this.appendScoreChanged(
            transaction,
            applied.effect,
            applied.gameplayReleaseId,
            traceId,
            now,
          );
        }
        return {
          result: { effect: applied.effect, replayed: applied.replayed },
          resourceId: playerId,
        };
      },
    );
    return {
      effect: execution.result.effect,
      replayed: execution.replayed || execution.result.replayed,
    };
  }

  async create(
    accountId: string,
    input: CreatePlayerRequest,
    idempotencyKey: string,
    traceId: string,
  ): Promise<CommandExecution<CreatePlayerResponse>> {
    const normalizedInput = createPlayerRequestSchema.parse(input);
    const actor: AccountActor = { kind: "account", accountId };
    const now = this.clock.now();
    const nowMs = now.getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError("Clock returned an invalid timestamp");
    }

    try {
      return await this.receipts.execute(
        {
          actorScope: `account:${accountId}`,
          operation: CREATE_PLAYER_OPERATION,
          idempotencyKey,
          requestDigest: requestDigest(
            CREATE_PLAYER_OPERATION,
            actor,
            normalizedInput,
          ),
          expiresAt: new Date(nowMs + RECEIPT_RETENTION_MS),
        },
        (value) => createPlayerResponseSchema.parse(value),
        async (transaction) => {
          await requireGameplayRelease(
            this.gameplayReleases,
            transaction,
            normalizedInput.gameplayReleaseId,
            false,
          );
          if (await this.repository.getByAccountId(transaction, accountId)) {
            throw new PlayerAlreadyExistsError();
          }
          const playerId = this.idGenerator.next();
          const result: CreatePlayerResponse = {
            playerId,
            displayName: normalizedInput.displayName,
            factionId: normalizedInput.factionId,
            powerId: normalizedInput.powerId,
            professionId: normalizedInput.professionId,
            aggregateVersion: 1,
          };
          await this.repository.createInTransaction(transaction, {
            playerId,
            accountId,
            displayName: normalizedInput.displayName,
            factionId: normalizedInput.factionId,
            powerId: normalizedInput.powerId,
            professionId: normalizedInput.professionId,
            gameplayReleaseId: normalizedInput.gameplayReleaseId,
            aggregateVersion: 1,
          });
          await this.appendEvent(
            transaction,
            playerId,
            accountId,
            normalizedInput,
            traceId,
            now,
          );
          return { result, resourceId: playerId };
        },
      );
    } catch (error: unknown) {
      if (isPlayerUniqueViolation(error)) throw new PlayerAlreadyExistsError();
      throw error;
    }
  }

  private async appendEvent(
    transaction: QueryExecutor,
    playerId: string,
    accountId: string,
    input: CreatePlayerRequest,
    traceId: string,
    occurredAt: Date,
  ): Promise<void> {
    const eventId = this.idGenerator.next();
    await this.outbox.append(transaction, {
      eventId,
      type: "PlayerCreated",
      schemaVersion: 1,
      source: "player",
      aggregateId: playerId,
      aggregateVersion: 1,
      streamId: playerId,
      releaseVersion: input.gameplayReleaseId,
      occurredAt: occurredAt.toISOString(),
      traceId,
      correlationId: traceId,
      causationId: null,
      rootEventId: eventId,
      depth: 0,
      payload: {
        accountId,
        playerId,
        displayName: input.displayName,
        factionId: input.factionId,
        powerId: input.powerId,
        professionId: input.professionId,
      },
    });
  }

  private async appendScoreChanged(
    transaction: QueryExecutor,
    effect: PlayerScoreEffect,
    releaseId: string,
    traceId: string,
    occurredAt: Date,
  ): Promise<void> {
    const eventId = this.idGenerator.next();
    await this.outbox.append(transaction, {
      eventId,
      type: "ScoreChanged",
      schemaVersion: 1,
      source: "player",
      aggregateId: effect.playerId,
      aggregateVersion: effect.aggregateVersion,
      streamId: effect.playerId,
      releaseVersion: releaseId,
      occurredAt: occurredAt.toISOString(),
      traceId,
      correlationId: traceId,
      causationId: null,
      rootEventId: eventId,
      depth: 0,
      payload: {
        effectId: effect.effectId,
        playerId: effect.playerId,
        requestedDelta: effect.requestedDelta,
        effectiveDelta: effect.effectiveDelta,
        scoreBefore: effect.scoreBefore,
        scoreAfter: effect.scoreAfter,
        clamped: effect.clamped,
        reasonRef: effect.reasonRef,
      },
    });
  }
}

function isPlayerUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly constraint?: unknown;
  };
  return (
    candidate.code === "23505" &&
    (candidate.constraint === "Players_accountId_key" ||
      candidate.constraint === "Players_pkey")
  );
}
