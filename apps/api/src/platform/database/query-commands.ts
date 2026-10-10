import type {
  CastVoteRequest,
  CreateQueryRequest,
  CreateQueryResponse,
  LeaveQueryRequest,
  SubmitActionRequest,
} from "../../contracts/http.ts";
import {
  castVoteRequestSchema,
  createQueryRequestSchema,
  createQueryResponseSchema,
  leaveQueryRequestSchema,
  joinQueryResponseSchema,
  submitActionRequestSchema,
  writeReceiptSchema,
} from "../../contracts/http.ts";
import type { PlayerActor } from "../../kernel/actor.ts";
import type {
  Clock,
  IdGenerator,
  PlayerFactionReader,
  RandomSource,
} from "../../kernel/ports.ts";
import { cryptoRandomSource } from "../../kernel/crypto-adapters.ts";
import { requestDigest } from "../../kernel/idempotency.ts";
import type {
  PrivateEvidenceCard,
  QueryAggregate,
  QueryScenario,
  SettlementConfirmation,
} from "../../modules/query/public.ts";
import {
  advanceQuery,
  assertCanInspect,
  castVote,
  createQuery,
  finalizeSettlement,
  inspectQuery,
  leaveQuery,
  QueryRuleError,
} from "../../modules/query/public.ts";
import type { CommandExecution } from "../transactions/command-receipts.ts";
import { PostgresCommandReceipts } from "../transactions/command-receipts.ts";
import { PostgresOutbox } from "../transactions/outbox.ts";
import type { QueryExecutor } from "../transactions/unit-of-work.ts";
import type { GameplayReleaseReader } from "./gameplay-release-repository.ts";
import { requireGameplayRelease } from "./gameplay-release-repository.ts";
import { trial1GlossarySnapshot } from "./postgres-migrations.ts";
import {
  PostgresQueryRepository,
  QueryJoinConflictError,
} from "./query-repository.ts";

const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const CREATE_QUERY_OPERATION = "query.create";
const JOIN_QUERY_OPERATION = "query.join";
const LEAVE_QUERY_OPERATION = "query.leave";
const CAST_VOTE_OPERATION = "query.vote";
const INSPECT_QUERY_OPERATION = "query.inspect";
const ADVANCE_BATCH_LIMIT = 50;

export class PostgresQueryCommands {
  private readonly outbox = new PostgresOutbox();

  constructor(
    private readonly repository: PostgresQueryRepository,
    private readonly receipts: PostgresCommandReceipts,
    private readonly gameplayReleases: GameplayReleaseReader,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly randomSource: RandomSource = cryptoRandomSource,
    private readonly playerFactions: PlayerFactionReader = {
      getFactionId: async () => null,
    },
  ) {}

  async create(
    actor: PlayerActor,
    input: CreateQueryRequest,
    idempotencyKey: string,
    traceId?: string,
  ): Promise<CommandExecution<CreateQueryResponse>> {
    const normalizedInput = createQueryRequestSchema.parse(input);
    const creatorFactionId = await this.requirePlayerFaction(actor.playerId);
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
        await requireGameplayRelease(
          this.gameplayReleases,
          transaction,
          normalizedInput.gameplayReleaseId,
          true,
        );
        const query = createQuery(
          this.idGenerator.next(),
          actor.playerId,
          normalizedInput.gameplayReleaseId,
          nowMs,
          creatorFactionId,
        );
        await this.repository.createInTransaction(transaction, query);
        await this.appendEvent(
          transaction,
          query,
          "QueryCreated",
          {
            queryId: query.queryId,
            createdByPlayerId: query.createdByPlayerId,
            gameplayReleaseId: query.gameplayReleaseId,
          },
          nowMs,
          traceId,
        );
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

  async join(
    actor: PlayerActor,
    queryId: string,
    idempotencyKey: string,
    traceId?: string,
  ): Promise<
    CommandExecution<{
      readonly queryId: string;
      readonly aggregateVersion: number;
      readonly phase: "waiting" | "exploring";
    }>
  > {
    const factionId = await this.requirePlayerFaction(actor.playerId);
    const now = this.clock.now();
    const nowMs = now.getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError("Clock returned an invalid timestamp");
    }
    const digest = requestDigest(JOIN_QUERY_OPERATION, actor, { queryId });
    const reservationExecution = await this.receipts.execute(
      {
        actorScope: `player:${actor.accountId}:${actor.playerId}`,
        operation: JOIN_QUERY_OPERATION,
        idempotencyKey,
        requestDigest: digest,
        expiresAt: new Date(nowMs + RECEIPT_RETENTION_MS),
      },
      (value) => {
        const result = writeReceiptSchema.parse(value);
        if (!result.resourceId)
          throw new TypeError("Join receipt has no reservation ID");
        return { resourceId: result.resourceId };
      },
      async (transaction) => {
        const reservationId = this.idGenerator.next();
        await this.repository.reserveJoinSeatInTransaction(
          transaction,
          reservationId,
          queryId,
          actor.playerId,
          factionId,
          nowMs,
        );
        return {
          result: { resourceId: reservationId },
          resourceId: reservationId,
          operationId: reservationId,
        };
      },
    );

    try {
      await this.repository.claimParticipationSlot(
        reservationExecution.result.resourceId,
        nowMs,
      );
    } catch (error: unknown) {
      if (error instanceof QueryJoinConflictError) {
        await this.repository.releaseJoinSeat(
          reservationExecution.result.resourceId,
        );
      }
      throw error;
    }

    try {
      const confirmation = await this.repository.confirmJoin(
        reservationExecution.result.resourceId,
        nowMs,
        factionId,
        (transaction, query) => this.createScenario(transaction, query),
        (transaction, query) =>
          this.appendEvent(
            transaction,
            query,
            "QueryParticipantJoined",
            { queryId: query.queryId, playerId: actor.playerId },
            nowMs,
            traceId,
          ),
      );
      const result = joinQueryResponseSchema.parse({
        queryId: confirmation.query.queryId,
        aggregateVersion: confirmation.query.version,
        phase: confirmation.query.phase,
      });
      return {
        result,
        replayed: reservationExecution.replayed || confirmation.replayed,
      };
    } catch (error: unknown) {
      // Release is status-guarded and a no-op once the reservation is confirmed.
      await this.releaseReservation(reservationExecution.result.resourceId);
      throw error;
    }
  }

  private async requirePlayerFaction(
    playerId: string,
  ): Promise<
    | "faction_1"
    | "faction_2"
    | "faction_3"
    | "faction_4"
    | "faction_5"
    | "faction_6"
  > {
    const factionId = await this.playerFactions.getFactionId(playerId);
    if (factionId === null) throw new Error("Player profile is unavailable");
    return factionId;
  }

  async releaseExpiredJoinReservations(limit = 50): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("Recovery limit must be a positive integer");
    }
    const nowMs = this.clock.now().getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError("Clock returned an invalid timestamp");
    }
    const reservationIds = await this.repository.listExpiredJoinReservationIds(
      nowMs,
      limit,
    );
    for (const reservationId of reservationIds) {
      await this.releaseReservation(reservationId);
    }
    return reservationIds.length;
  }

  /**
   * Moves due rooms forward by at most one phase each. Every step is a CAS
   * save plus an outbox event in one transaction, so concurrent workers or
   * player commands cannot skip or duplicate a transition.
   */
  async advanceDueQueries(limit = ADVANCE_BATCH_LIMIT): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("Advance limit must be a positive integer");
    }
    const nowMs = this.clock.now().getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError("Clock returned an invalid timestamp");
    }
    const queryIds = await this.repository.listDueQueryIds(nowMs, limit);
    let advanced = 0;
    for (const queryId of queryIds) {
      if (await this.advanceOne(queryId, nowMs)) advanced += 1;
    }
    return advanced;
  }

  private advanceOne(queryId: string, nowMs: number): Promise<boolean> {
    return this.repository.runInTransaction(async (transaction) => {
      const query = await this.repository.getInTransaction(
        transaction,
        queryId,
      );
      if (query === null) return false;
      const next = advanceQuery(query, nowMs);
      if (next === query) return false;
      const saved = await this.repository.saveInTransaction(
        transaction,
        next,
        query.version,
      );
      if (!saved) return false;
      await this.appendEvent(
        transaction,
        next,
        "QueryPhaseAdvanced",
        {
          queryId: next.queryId,
          phase: next.phase,
          aggregateVersion: next.version,
        },
        nowMs,
      );
      return true;
    });
  }

  finalizeSettlement(
    queryId: string,
    confirmations: readonly SettlementConfirmation[],
    traceId?: string,
  ): Promise<{
    readonly replayed: boolean;
    readonly aggregateVersion: number;
  }> {
    const nowMs = this.clock.now().getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError("Clock returned an invalid timestamp");
    }
    return this.repository.runInTransaction(async (transaction) => {
      const query = await this.repository.getInTransaction(
        transaction,
        queryId,
        true,
      );
      if (query === null) {
        const error = new Error("Query not found");
        error.name = "QueryNotFoundError";
        throw error;
      }
      if (query.phase === "completed") {
        const persisted =
          await this.repository.getSettlementConfirmationsInTransaction(
            transaction,
            queryId,
          );
        const persistedByKey = new Map(
          persisted.map(({ effectKey, resultReference }) => [
            effectKey,
            resultReference,
          ]),
        );
        if (
          persistedByKey.size !== confirmations.length ||
          new Set(confirmations.map(({ effectKey }) => effectKey)).size !==
            confirmations.length ||
          confirmations.some(
            ({ effectKey, resultReference }) =>
              persistedByKey.get(effectKey) !== resultReference,
          )
        ) {
          throw new QueryRuleError("SETTLEMENT_PLAN_MISMATCH");
        }
        return { replayed: true, aggregateVersion: query.version };
      }

      const persisted =
        await this.repository.getSettlementConfirmationsInTransaction(
          transaction,
          queryId,
        );
      const persistedByKey = new Map(
        persisted.map(({ effectKey, resultReference }) => [
          effectKey,
          resultReference,
        ]),
      );
      const alreadyConfirmedKeys = new Set(persistedByKey.keys());
      for (const { effectKey, resultReference } of confirmations) {
        const previous = persistedByKey.get(effectKey);
        if (previous !== undefined && previous !== resultReference) {
          throw new QueryRuleError("SETTLEMENT_PLAN_MISMATCH");
        }
        persistedByKey.set(effectKey, resultReference);
      }
      const allConfirmations = [...persistedByKey].map(
        ([effectKey, resultReference]) => ({ effectKey, resultReference }),
      );
      const updated = finalizeSettlement(query, allConfirmations);
      const plan = updated.settlementPlan;
      if (plan === null) {
        throw new QueryRuleError("SETTLEMENT_PLAN_MISMATCH");
      }
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
      await this.repository.recordSettlementConfirmationsInTransaction(
        transaction,
        queryId,
        confirmations.filter(
          ({ effectKey }) => !alreadyConfirmedKeys.has(effectKey),
        ),
        nowMs,
      );
      await transaction.query(
        'DELETE FROM "query"."ParticipationSlots" WHERE "queryId" = @queryId;',
        { queryId },
      );
      await this.appendEvent(
        transaction,
        updated,
        "QuerySettlementCompleted",
        {
          queryId: updated.queryId,
          settlementId: plan.settlementId,
          gameplayReleaseId: updated.gameplayReleaseId,
          selectedCorrect:
            updated.selectedChoice !== null &&
            updated.selectedChoice === updated.scenario?.correctChoice,
          participantIds: updated.participants.map(({ playerId }) => playerId),
        },
        nowMs,
        traceId,
      );
      return { replayed: false, aggregateVersion: updated.version };
    });
  }

  async confirmSettlementEffects(
    queryId: string,
    confirmations: readonly SettlementConfirmation[],
  ): Promise<readonly SettlementConfirmation[]> {
    const nowMs = this.clock.now().getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError("Clock returned an invalid timestamp");
    }
    return this.repository.runInTransaction((transaction) =>
      this.repository.confirmSettlementEffectsInTransaction(
        transaction,
        queryId,
        confirmations,
        nowMs,
      ),
    );
  }

  private async releaseReservation(reservationId: string): Promise<void> {
    await this.repository.releaseParticipationSlot(reservationId);
    await this.repository.releaseJoinSeat(reservationId);
  }

  private async createScenario(
    transaction: QueryExecutor,
    query: QueryAggregate,
  ): Promise<QueryScenario> {
    const release = await this.gameplayReleases.getGameplayReleaseById(
      transaction,
      query.gameplayReleaseId,
    );
    if (!release?.queryEnabled || !release.trial1) {
      throw new Error("Pinned gameplay release is unavailable");
    }
    const randomSeed = this.randomSource.bytes(32);
    if (randomSeed.byteLength !== 32) {
      throw new TypeError("Random source returned an invalid scenario seed");
    }
    const variantIndex = randomSeed[0]! & 1;
    const variant = release.trial1.variants[variantIndex];
    if (!variant)
      throw new Error("Pinned trial release has no selected variant");
    return {
      variantId: variant.variantId,
      randomSeed: Buffer.from(randomSeed).toString("base64url"),
      correctChoice: variant.correctChoiceId,
    };
  }

  inspect(
    actor: PlayerActor,
    queryId: string,
    input: SubmitActionRequest,
    idempotencyKey: string,
    traceId?: string,
  ): Promise<
    CommandExecution<{
      readonly resourceId: string;
      readonly aggregateVersion: number;
    }>
  > {
    const normalizedInput = submitActionRequestSchema.parse(input);
    return this.executeMutation(
      actor,
      queryId,
      INSPECT_QUERY_OPERATION,
      normalizedInput,
      idempotencyKey,
      async (query, now, transaction) => {
        // Rule violations (phase, deadline, membership, limits) are reported
        // before any evidence lookup so they map to 409/404, not 500.
        assertCanInspect(query, actor.playerId, normalizedInput.siteId, now);
        if (query.scenario === null) {
          throw new QueryRuleError("INVALID_SCENARIO");
        }
        const evidence = await this.pinnedEvidence(
          transaction,
          query,
          normalizedInput.siteId,
        );
        return inspectQuery(
          query,
          actor.playerId,
          normalizedInput.siteId,
          now,
          () =>
            ({
              cardId: this.idGenerator.next(),
              playerId: actor.playerId,
              siteId: normalizedInput.siteId,
              text: evidence.text,
              isTruth: evidence.isTruth,
            }) satisfies PrivateEvidenceCard,
        );
      },
      "QueryEvidenceInspected",
      (updated) => ({
        queryId: updated.queryId,
        playerId: actor.playerId,
        siteId: normalizedInput.siteId,
      }),
      traceId,
    );
  }

  private async pinnedEvidence(
    transaction: QueryExecutor,
    query: QueryAggregate,
    siteId: SubmitActionRequest["siteId"],
  ): Promise<{ readonly text: string; readonly isTruth: boolean }> {
    const release = await this.gameplayReleases.getGameplayReleaseById(
      transaction,
      query.gameplayReleaseId,
    );
    const variant = release?.trial1?.variants.find(
      (item) => item.variantId === query.scenario?.variantId,
    );
    const item = variant?.evidence.find((entry) => entry.siteId === siteId);
    if (!release?.queryEnabled || !item) {
      throw new Error("Pinned gameplay release has no evidence for site");
    }
    return {
      text: renderGlossaryMessage(item.messageKey, item.args),
      isTruth: item.isTruth,
    };
  }

  leave(
    actor: PlayerActor,
    queryId: string,
    input: LeaveQueryRequest,
    idempotencyKey: string,
    traceId?: string,
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
      "QueryParticipantLeft",
      (updated) => ({
        queryId: updated.queryId,
        playerId: actor.playerId,
        phase: updated.phase,
      }),
      traceId,
    );
  }

  vote(
    actor: PlayerActor,
    queryId: string,
    input: CastVoteRequest,
    idempotencyKey: string,
    traceId?: string,
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
      "QueryVoteCast",
      (updated) => ({
        queryId: updated.queryId,
        playerId: actor.playerId,
      }),
      traceId,
    );
  }

  private executeMutation<Input extends object>(
    actor: PlayerActor,
    queryId: string,
    operation: string,
    input: Input,
    idempotencyKey: string,
    mutate: (
      query: QueryAggregate,
      now: number,
      transaction: QueryExecutor,
    ) => QueryAggregate | Promise<QueryAggregate>,
    eventType: string,
    eventPayload: (updated: QueryAggregate) => Record<string, unknown>,
    traceId?: string,
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
        const updated = await mutate(query, nowMs, transaction);
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
        await this.appendEvent(
          transaction,
          updated,
          eventType,
          eventPayload(updated),
          nowMs,
          traceId,
        );
        const result = {
          resourceId: queryId,
          aggregateVersion: updated.version,
        };
        return { result, resourceId: queryId };
      },
    );
  }

  private async appendEvent(
    transaction: QueryExecutor,
    query: QueryAggregate,
    type: string,
    payload: Record<string, unknown>,
    occurredAt: number,
    traceId?: string,
  ): Promise<void> {
    const eventId = this.idGenerator.next();
    const eventTraceId = traceId ?? this.idGenerator.next();
    await this.outbox.append(transaction, {
      eventId,
      type,
      schemaVersion: 1,
      source: "query",
      aggregateId: query.queryId,
      aggregateVersion: query.version,
      streamId: query.queryId,
      releaseVersion: query.gameplayReleaseId,
      occurredAt: new Date(occurredAt).toISOString(),
      traceId: eventTraceId,
      correlationId: eventTraceId,
      causationId: null,
      rootEventId: eventId,
      depth: 0,
      payload,
    });
  }
}

const glossaryEntries: Readonly<Record<string, string>> =
  trial1GlossarySnapshot.entries;

function renderGlossaryMessage(
  messageKey: string,
  args: Readonly<Record<string, string | number | boolean>>,
): string {
  const template = glossaryEntries[messageKey];
  if (template === undefined) {
    throw new Error(`Glossary entry is missing: ${messageKey}`);
  }
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = args[name];
    if (value === undefined) {
      throw new Error(`Glossary argument is missing: ${messageKey}.${name}`);
    }
    return String(value);
  });
}
