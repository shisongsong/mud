import type {
  CreatePlayerRequest,
  CreatePlayerResponse,
} from "../../contracts/http.ts";
import {
  createPlayerRequestSchema,
  createPlayerResponseSchema,
} from "../../contracts/http.ts";
import type { AccountActor } from "../../kernel/actor.ts";
import { requestDigest } from "../../kernel/idempotency.ts";
import type { Clock, IdGenerator } from "../../kernel/ports.ts";
import type { CommandExecution } from "../transactions/command-receipts.ts";
import { PostgresCommandReceipts } from "../transactions/command-receipts.ts";
import { PostgresOutbox } from "../transactions/outbox.ts";
import type { QueryExecutor } from "../transactions/unit-of-work.ts";
import type { GameplayReleaseReader } from "./gameplay-release-repository.ts";
import { requireGameplayRelease } from "./gameplay-release-repository.ts";
import { PostgresPlayerRepository } from "./player-repository.ts";

const CREATE_PLAYER_OPERATION = "player.create";
const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;

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
}

function isPlayerUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly constraint?: unknown };
  return (
    candidate.code === "23505" &&
    (candidate.constraint === "Players_accountId_key" ||
      candidate.constraint === "Players_pkey")
  );
}