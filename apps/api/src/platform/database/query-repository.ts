import { joinQuery, QueryRuleError } from "../../modules/query/public.ts";
import type {
  PrivateEvidenceCard,
  QueryAggregate,
  QueryChoice,
  QueryPhase,
  QueryRepository,
  QueryScenario,
  QuerySite,
  QueryVote,
  BoardDelta,
  BoardFactionId,
  SettlementConfirmation,
  SettlementPlan,
} from "../../modules/query/public.ts";
import type {
  QueryExecutor,
  UnitOfWork,
} from "../transactions/unit-of-work.ts";

interface QueryRoomRow {
  readonly queryId: string;
  readonly createdByPlayerId: string;
  readonly gameplayReleaseId: string;
  readonly phase: QueryPhase;
  readonly aggregateVersion: number | string;
  readonly createdAt: Date;
  readonly deadline: Date | null;
  readonly explorationStartedAt: Date | null;
  readonly scenarioVariantId: string | null;
  readonly randomSeed: Uint8Array | null;
  readonly correctChoice: QueryChoice | null;
  readonly selectedChoice: QueryChoice | null;
}

interface ParticipantRow {
  readonly playerId: string;
  readonly factionId: BoardFactionId;
  readonly joinedAt: Date;
}

interface ActionRow {
  readonly playerId: string;
  readonly siteId: QuerySite;
  readonly cardId: string;
  readonly evidenceText: string;
  readonly isTruth: boolean;
  readonly acceptedAt: Date;
}

interface VoteRow {
  readonly playerId: string;
  readonly choice: QueryVote;
}

interface JoinReservationRow {
  readonly reservationId: string;
  readonly queryId: string;
  readonly playerId: string;
  readonly status:
    "reserved" | "slot_claimed" | "confirmed" | "released" | "expired";
  readonly expiresAt: Date;
}

export class QueryJoinConflictError extends Error {
  constructor(
    readonly code:
      | "QUERY_JOIN_PLAYER_ALREADY_IN_QUERY"
      | "QUERY_JOIN_RESERVATION_EXPIRED"
      | "QUERY_JOIN_RESERVATION_NOT_READY",
  ) {
    super(code);
    this.name = "QueryJoinConflictError";
  }
}

export class PostgresQueryRepository implements QueryRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async create(query: QueryAggregate): Promise<void> {
    await this.unitOfWork.transaction((transaction) =>
      this.createInTransaction(transaction, query),
    );
  }

  async createInTransaction(
    transaction: QueryExecutor,
    query: QueryAggregate,
  ): Promise<void> {
    await transaction.query(
      `
INSERT INTO "query"."QueryRooms"
  ("queryId", "createdByPlayerId", "gameplayReleaseId", "phase", "aggregateVersion",
   "createdAt", "deadline", "explorationStartedAt", "scenarioVariantId", "randomSeed",
   "correctChoice", "selectedChoice")
VALUES
  (@queryId, @createdByPlayerId, @gameplayReleaseId, @phase, @aggregateVersion,
   @createdAt, @deadline, @explorationStartedAt, @scenarioVariantId, @randomSeed,
   @correctChoice, @selectedChoice);
`,
      roomParameters(query),
    );
    await insertChildren(transaction, query);
  }

  async reserveJoinSeatInTransaction(
    transaction: QueryExecutor,
    reservationId: string,
    queryId: string,
    playerId: string,
    factionId: BoardFactionId,
    now: number,
  ): Promise<{ readonly expiresAt: Date }> {
    const rooms = await transaction.query<{
      readonly phase: QueryPhase;
      readonly deadline: Date | null;
    }>(
      `
SELECT "phase" AS "phase", "deadline" AS "deadline"
FROM "query"."QueryRooms"
WHERE "queryId" = @queryId
FOR UPDATE;
`,
      { queryId },
    );
    const room = rooms[0];
    if (!room) {
      const error = new Error("Query not found");
      error.name = "QueryNotFoundError";
      throw error;
    }
    if (room.phase !== "waiting") {
      throw new QueryRuleError("QUERY_NOT_WAITING");
    }
    if (room.deadline === null || room.deadline.getTime() <= now) {
      throw new QueryRuleError("QUERY_EXPIRED");
    }

    const seatRows = await transaction.query<{
      readonly seatCount: number;
      readonly alreadyMember: boolean;
    }>(
      `
SELECT COUNT(*)::integer AS "seatCount",
       COALESCE(BOOL_OR("playerId" = @playerId), FALSE) AS "alreadyMember"
FROM "query"."QueryParticipants"
WHERE "queryId" = @queryId
  AND "participationStatus" IN ('reserved', 'confirmed');
`,
      { queryId, playerId },
    );
    const seats = seatRows[0];
    if (!seats || seats.alreadyMember) {
      throw new QueryRuleError("QUERY_ALREADY_MEMBER");
    }
    if (seats.seatCount >= 4) {
      throw new QueryRuleError("QUERY_FULL");
    }

    const expiresAt = room.deadline;
    await transaction.query(
      `
INSERT INTO "query"."JoinReservations"
  ("reservationId", "queryId", "playerId", "status", "createdAt", "expiresAt")
VALUES
  (@reservationId, @queryId, @playerId, 'reserved', @createdAt, @expiresAt);
`,
      {
        reservationId,
        queryId,
        playerId,
        createdAt: new Date(now),
        expiresAt,
      },
    );
    await transaction.query(
      `
INSERT INTO "query"."QueryParticipants"
  ("queryId", "playerId", "factionId", "joinedAt", "participationStatus")
VALUES
  (@queryId, @playerId, @factionId, @joinedAt, 'reserved');
`,
      { queryId, playerId, factionId, joinedAt: new Date(now) },
    );
    return { expiresAt };
  }

  async claimParticipationSlot(
    reservationId: string,
    now: number,
  ): Promise<void> {
    await this.unitOfWork.transaction(async (transaction) => {
      const reservations = await transaction.query<JoinReservationRow>(
        `
SELECT "reservationId" AS "reservationId", "queryId" AS "queryId",
       "playerId" AS "playerId", "status" AS "status", "expiresAt" AS "expiresAt"
FROM "query"."JoinReservations"
WHERE "reservationId" = @reservationId
FOR UPDATE;
`,
        { reservationId },
      );
      const reservation = reservations[0];
      if (!reservation) {
        throw new QueryJoinConflictError("QUERY_JOIN_RESERVATION_EXPIRED");
      }
      if (
        reservation.status === "slot_claimed" ||
        reservation.status === "confirmed"
      ) {
        return;
      }
      if (
        reservation.status !== "reserved" ||
        reservation.expiresAt.getTime() <= now
      ) {
        throw new QueryJoinConflictError("QUERY_JOIN_RESERVATION_EXPIRED");
      }

      const inserted = await transaction.query<{ readonly playerId: string }>(
        `
INSERT INTO "query"."ParticipationSlots" ("playerId", "queryId", "status", "claimedAt")
VALUES (@playerId, @queryId, 'active', @claimedAt)
ON CONFLICT ("playerId") DO NOTHING
RETURNING "playerId" AS "playerId";
`,
        {
          playerId: reservation.playerId,
          queryId: reservation.queryId,
          claimedAt: new Date(now),
        },
      );
      if (inserted.length === 0) {
        const slots = await transaction.query<{ readonly queryId: string }>(
          `
SELECT "queryId" AS "queryId"
FROM "query"."ParticipationSlots"
WHERE "playerId" = @playerId;
`,
          { playerId: reservation.playerId },
        );
        if (slots[0]?.queryId !== reservation.queryId) {
          throw new QueryJoinConflictError(
            "QUERY_JOIN_PLAYER_ALREADY_IN_QUERY",
          );
        }
      }

      await transaction.query(
        `
UPDATE "query"."JoinReservations"
SET "status" = 'slot_claimed'
WHERE "reservationId" = @reservationId AND "status" = 'reserved';
`,
        { reservationId },
      );
    });
  }

  async releaseParticipationSlot(reservationId: string): Promise<void> {
    await this.unitOfWork.transaction(async (transaction) => {
      const reservations = await transaction.query<JoinReservationRow>(
        `
SELECT "reservationId" AS "reservationId", "queryId" AS "queryId",
       "playerId" AS "playerId", "status" AS "status", "expiresAt" AS "expiresAt"
FROM "query"."JoinReservations"
WHERE "reservationId" = @reservationId
FOR UPDATE;
`,
        { reservationId },
      );
      const reservation = reservations[0];
      if (!reservation || reservation.status !== "slot_claimed") return;
      await transaction.query(
        `DELETE FROM "query"."ParticipationSlots"
WHERE "playerId" = @playerId AND "queryId" = @queryId AND "status" = 'active';`,
        { playerId: reservation.playerId, queryId: reservation.queryId },
      );
    });
  }

  async releaseJoinSeat(reservationId: string): Promise<void> {
    await this.unitOfWork.transaction(async (transaction) => {
      const reservations = await transaction.query<JoinReservationRow>(
        `
SELECT "reservationId" AS "reservationId", "queryId" AS "queryId",
       "playerId" AS "playerId", "status" AS "status", "expiresAt" AS "expiresAt"
FROM "query"."JoinReservations"
WHERE "reservationId" = @reservationId
FOR UPDATE;
`,
        { reservationId },
      );
      const reservation = reservations[0];
      if (!reservation || reservation.status === "confirmed") return;
      await transaction.query(
        `DELETE FROM "query"."QueryParticipants"
WHERE "queryId" = @queryId AND "playerId" = @playerId
  AND "participationStatus" = 'reserved';`,
        { queryId: reservation.queryId, playerId: reservation.playerId },
      );
      await transaction.query(
        `UPDATE "query"."JoinReservations" SET "status" = 'released'
WHERE "reservationId" = @reservationId
  AND "status" IN ('reserved', 'slot_claimed');`,
        { reservationId },
      );
    });
  }

  async listExpiredJoinReservationIds(
    now: number,
    limit: number,
  ): Promise<readonly string[]> {
    return this.unitOfWork.transaction(async (transaction) => {
      const rows = await transaction.query<{
        readonly reservationId: string;
      }>(
        `
SELECT "reservationId" AS "reservationId"
FROM "query"."JoinReservations"
WHERE "status" IN ('reserved', 'slot_claimed') AND "expiresAt" <= @now
ORDER BY "expiresAt", "reservationId"
LIMIT @limit;
`,
        { now: new Date(now), limit },
      );
      return rows.map(({ reservationId }) => reservationId);
    });
  }

  async runInTransaction<T>(
    work: (transaction: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    return this.unitOfWork.transaction(work);
  }

  async listDueQueryIds(
    now: number,
    limit: number,
  ): Promise<readonly string[]> {
    return this.unitOfWork.transaction(async (transaction) => {
      const rows = await transaction.query<{ readonly queryId: string }>(
        `
SELECT "queryId" AS "queryId"
FROM "query"."QueryRooms"
WHERE "phase" IN ('waiting', 'exploring', 'voting') AND "deadline" <= @now
ORDER BY "deadline", "queryId"
LIMIT @limit;
`,
        { now: new Date(now), limit },
      );
      return rows.map(({ queryId }) => queryId);
    });
  }

  async listSettlingQueryIds(limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("Settlement limit must be a positive integer");
    }
    return this.unitOfWork.transaction(async (transaction) => {
      const rows = await transaction.query<{ readonly queryId: string }>(
        `
SELECT "queryId" AS "queryId"
FROM "query"."QueryRooms"
WHERE "phase" = 'settling'
ORDER BY "createdAt", "queryId"
LIMIT @limit;
`,
        { limit },
      );
      return rows.map(({ queryId }) => queryId);
    });
  }

  async confirmJoinInTransaction(
    transaction: QueryExecutor,
    reservationId: string,
    now: number,
    factionId: BoardFactionId,
    createScenario: (
      transaction: QueryExecutor,
      query: QueryAggregate,
    ) => Promise<QueryScenario>,
    afterConfirmed: (
      transaction: QueryExecutor,
      query: QueryAggregate,
    ) => Promise<void>,
  ): Promise<{ readonly query: QueryAggregate; readonly replayed: boolean }> {
    const reservations = await transaction.query<JoinReservationRow>(
      `
SELECT "reservationId" AS "reservationId", "queryId" AS "queryId",
       "playerId" AS "playerId", "status" AS "status", "expiresAt" AS "expiresAt"
FROM "query"."JoinReservations"
WHERE "reservationId" = @reservationId
FOR UPDATE;
`,
      { reservationId },
    );
    const reservation = reservations[0];
    if (!reservation) {
      throw new QueryJoinConflictError("QUERY_JOIN_RESERVATION_EXPIRED");
    }
    const current = await this.getInTransaction(
      transaction,
      reservation.queryId,
    );
    if (!current) {
      const error = new Error("Query not found");
      error.name = "QueryNotFoundError";
      throw error;
    }
    if (reservation.status === "confirmed") {
      return { query: current, replayed: true };
    }
    if (
      reservation.status !== "slot_claimed" ||
      reservation.expiresAt.getTime() <= now
    ) {
      throw new QueryJoinConflictError("QUERY_JOIN_RESERVATION_NOT_READY");
    }

    const slots = await transaction.query<{ readonly queryId: string }>(
      `
SELECT "queryId" AS "queryId"
FROM "query"."ParticipationSlots"
WHERE "playerId" = @playerId AND "status" = 'active';
`,
      { playerId: reservation.playerId },
    );
    if (slots[0]?.queryId !== reservation.queryId) {
      throw new QueryJoinConflictError("QUERY_JOIN_RESERVATION_NOT_READY");
    }
    if (
      current.participants.some(
        ({ playerId }) => playerId === reservation.playerId,
      )
    ) {
      await transaction.query(
        `UPDATE "query"."JoinReservations" SET "status" = 'confirmed'
WHERE "reservationId" = @reservationId;`,
        { reservationId },
      );
      return { query: current, replayed: true };
    }

    const scenario =
      current.participants.length === 3
        ? await createScenario(transaction, current)
        : null;
    const updated = joinQuery(
      current,
      reservation.playerId,
      now,
      () => {
        if (!scenario) throw new QueryRuleError("INVALID_SCENARIO");
        return scenario;
      },
      factionId,
    );
    await transaction.query(
      `DELETE FROM "query"."QueryParticipants"
WHERE "queryId" = @queryId AND "playerId" = @playerId
  AND "participationStatus" = 'reserved';`,
      { queryId: reservation.queryId, playerId: reservation.playerId },
    );
    const saved = await this.saveInTransaction(
      transaction,
      updated,
      current.version,
    );
    if (!saved) {
      const error = new Error("Query aggregate version changed");
      error.name = "QueryConcurrencyError";
      throw error;
    }
    await transaction.query(
      `UPDATE "query"."JoinReservations" SET "status" = 'confirmed'
WHERE "reservationId" = @reservationId;`,
      { reservationId },
    );
    await afterConfirmed(transaction, updated);
    return { query: updated, replayed: false };
  }

  async confirmJoin(
    reservationId: string,
    now: number,
    factionId: BoardFactionId,
    createScenario: (
      transaction: QueryExecutor,
      query: QueryAggregate,
    ) => Promise<QueryScenario>,
    afterConfirmed: (
      transaction: QueryExecutor,
      query: QueryAggregate,
    ) => Promise<void>,
  ): Promise<{ readonly query: QueryAggregate; readonly replayed: boolean }> {
    return this.unitOfWork.transaction((transaction) =>
      this.confirmJoinInTransaction(
        transaction,
        reservationId,
        now,
        factionId,
        createScenario,
        afterConfirmed,
      ),
    );
  }

  async get(queryId: string): Promise<QueryAggregate | null> {
    return this.unitOfWork.transaction((transaction) =>
      this.getInTransaction(transaction, queryId),
    );
  }

  async getInTransaction(
    transaction: QueryExecutor,
    queryId: string,
    forUpdate = false,
  ): Promise<QueryAggregate | null> {
    const rooms = await transaction.query<QueryRoomRow>(
      `
SELECT "queryId" AS "queryId", "createdByPlayerId" AS "createdByPlayerId",
       "gameplayReleaseId" AS "gameplayReleaseId", "phase" AS "phase",
       "aggregateVersion" AS "aggregateVersion", "createdAt" AS "createdAt",
       "deadline" AS "deadline", "explorationStartedAt" AS "explorationStartedAt",
       "scenarioVariantId" AS "scenarioVariantId", "randomSeed" AS "randomSeed",
       "correctChoice" AS "correctChoice", "selectedChoice" AS "selectedChoice"
FROM "query"."QueryRooms"
WHERE "queryId" = @queryId${forUpdate ? " FOR UPDATE" : ""};
`,
      { queryId },
    );
    const room = rooms[0];
    if (!room) return null;

    const participants = await transaction.query<ParticipantRow>(
      `
SELECT "playerId" AS "playerId", "factionId" AS "factionId",
       "joinedAt" AS "joinedAt"
FROM "query"."QueryParticipants"
WHERE "queryId" = @queryId AND "participationStatus" = 'confirmed'
ORDER BY "joinedAt", "playerId";
`,
      { queryId },
    );
    const actions = await transaction.query<ActionRow>(
      `
SELECT "playerId" AS "playerId", "siteId" AS "siteId", "cardId" AS "cardId",
       "evidenceText" AS "evidenceText", "isTruth" AS "isTruth", "acceptedAt" AS "acceptedAt"
FROM "query"."QueryActions"
WHERE "queryId" = @queryId
ORDER BY "playerId", "actionOrdinal";
`,
      { queryId },
    );
    const votes = await transaction.query<VoteRow>(
      `
SELECT "playerId" AS "playerId", "choice" AS "choice"
FROM "query"."QueryVotes"
WHERE "queryId" = @queryId
ORDER BY "playerId";
`,
      { queryId },
    );
    const planRows = await transaction.query<{
      readonly settlementId: string;
      readonly boardDelta: BoardDelta | string;
    }>(
      `
SELECT "settlementId" AS "settlementId",
       "boardDeltaJson" AS "boardDelta"
FROM "query"."SettlementPlans"
WHERE "queryId" = @queryId;
`,
      { queryId },
    );
    const targetRows = await transaction.query<{
      readonly effectKey: string;
    }>(
      `
SELECT "effectKey" AS "effectKey"
FROM "query"."SettlementTargets"
WHERE "queryId" = @queryId
ORDER BY "effectKey" COLLATE "C";
`,
      { queryId },
    );
    const pointAwardRows = await transaction.query<{
      readonly playerId: string;
      readonly requestedDelta: number;
    }>(
      `
SELECT "playerId" AS "playerId", "requestedDelta" AS "requestedDelta"
FROM "query"."SettlementPointAwards"
WHERE "queryId" = @queryId
ORDER BY "playerId";
`,
      { queryId },
    );
    const settlementPlan: SettlementPlan | null =
      planRows[0] === undefined
        ? null
        : {
            settlementId: planRows[0].settlementId,
            targets: targetRows.map(({ effectKey }) => effectKey),
            boardDelta: parseJson(planRows[0].boardDelta),
            pointAwards: pointAwardRows,
          };
    return hydrateQuery(room, participants, actions, votes, settlementPlan);
  }

  async save(query: QueryAggregate, expectedVersion: number): Promise<boolean> {
    if (query.version !== expectedVersion + 1) {
      throw new TypeError(
        "A saved query must advance exactly one aggregate version",
      );
    }

    return this.unitOfWork.transaction((transaction) =>
      this.saveInTransaction(transaction, query, expectedVersion),
    );
  }

  async saveInTransaction(
    transaction: QueryExecutor,
    query: QueryAggregate,
    expectedVersion: number,
  ): Promise<boolean> {
    if (query.version !== expectedVersion + 1) {
      throw new TypeError(
        "A saved query must advance exactly one aggregate version",
      );
    }

    const updated = await transaction.query<{ readonly queryId: string }>(
      `
UPDATE "query"."QueryRooms"
SET "createdByPlayerId" = @createdByPlayerId,
    "gameplayReleaseId" = @gameplayReleaseId,
    "phase" = @phase,
    "aggregateVersion" = @aggregateVersion,
    "createdAt" = @createdAt,
    "deadline" = @deadline,
    "explorationStartedAt" = @explorationStartedAt,
    "scenarioVariantId" = @scenarioVariantId,
    "randomSeed" = @randomSeed,
    "correctChoice" = @correctChoice,
    "selectedChoice" = @selectedChoice
WHERE "queryId" = @queryId AND "aggregateVersion" = @expectedVersion
RETURNING "queryId" AS "queryId";
`,
      { ...roomParameters(query), expectedVersion },
    );
    if (updated.length === 0) return false;

    await transaction.query(
      'DELETE FROM "query"."QueryVotes" WHERE "queryId" = @queryId;',
      { queryId: query.queryId },
    );
    const retainedParticipantParameters = Object.fromEntries(
      query.participants.map(({ playerId }, index) => [
        `retainedPlayerId${index}`,
        playerId,
      ]),
    );
    const retainedParticipants = query.participants
      .map((_, index) => `@retainedPlayerId${index}`)
      .join(", ");
    await transaction.query(
      `DELETE FROM "query"."QueryParticipants"
WHERE "queryId" = @queryId AND "participationStatus" = 'confirmed'${
        retainedParticipants.length === 0
          ? ""
          : ` AND "playerId" NOT IN (${retainedParticipants})`
      };`,
      { queryId: query.queryId, ...retainedParticipantParameters },
    );
    await insertChildren(transaction, query);
    if (query.settlementPlan !== null) {
      await insertSettlementPlan(
        transaction,
        query.queryId,
        query.settlementPlan,
      );
    }
    return true;
  }

  async recordSettlementConfirmationsInTransaction(
    transaction: QueryExecutor,
    queryId: string,
    confirmations: readonly SettlementConfirmation[],
    confirmedAt: number,
  ): Promise<void> {
    for (const { effectKey, resultReference } of confirmations) {
      await transaction.query(
        `
INSERT INTO "query"."SettlementConfirmations"
  ("queryId", "effectKey", "resultReference", "confirmedAt")
VALUES (@queryId, @effectKey, @resultReference, @confirmedAt)
ON CONFLICT ("queryId", "effectKey") DO NOTHING;
`,
        {
          queryId,
          effectKey,
          resultReference,
          confirmedAt: new Date(confirmedAt),
        },
      );
    }
  }

  async getSettlementConfirmationsInTransaction(
    transaction: QueryExecutor,
    queryId: string,
  ): Promise<readonly SettlementConfirmation[]> {
    return transaction.query<SettlementConfirmation>(
      `
SELECT "effectKey" AS "effectKey",
       "resultReference" AS "resultReference"
FROM "query"."SettlementConfirmations"
WHERE "queryId" = @queryId
ORDER BY "effectKey";
`,
      { queryId },
    );
  }

  async getSettlementConfirmations(
    queryId: string,
  ): Promise<readonly SettlementConfirmation[]> {
    return this.unitOfWork.transaction((transaction) =>
      this.getSettlementConfirmationsInTransaction(transaction, queryId),
    );
  }

  async confirmSettlementEffectsInTransaction(
    transaction: QueryExecutor,
    queryId: string,
    confirmations: readonly SettlementConfirmation[],
    confirmedAt: number,
  ): Promise<readonly SettlementConfirmation[]> {
    const query = await this.getInTransaction(transaction, queryId, true);
    if (!query) throw new Error("Query not found");
    if (query.phase !== "settling" || query.settlementPlan === null) {
      throw new QueryRuleError("QUERY_NOT_SETTLING");
    }
    if (
      new Set(confirmations.map(({ effectKey }) => effectKey)).size !==
        confirmations.length ||
      confirmations.some(
        ({ effectKey, resultReference }) =>
          effectKey.trim().length === 0 ||
          resultReference.trim().length === 0 ||
          resultReference.length > 512 ||
          !query.settlementPlan!.targets.includes(effectKey),
      )
    ) {
      throw new QueryRuleError("SETTLEMENT_PLAN_MISMATCH");
    }

    const existing = await this.getSettlementConfirmationsInTransaction(
      transaction,
      queryId,
    );
    const existingByKey = new Map(
      existing.map(({ effectKey, resultReference }) => [
        effectKey,
        resultReference,
      ]),
    );
    for (const confirmation of confirmations) {
      const previous = existingByKey.get(confirmation.effectKey);
      if (previous !== undefined && previous !== confirmation.resultReference) {
        throw new QueryRuleError("SETTLEMENT_PLAN_MISMATCH");
      }
      if (previous === undefined) {
        await this.recordSettlementConfirmationsInTransaction(
          transaction,
          queryId,
          [confirmation],
          confirmedAt,
        );
        existingByKey.set(confirmation.effectKey, confirmation.resultReference);
      }
    }
    return [...existingByKey].map(([effectKey, resultReference]) => ({
      effectKey,
      resultReference,
    }));
  }
}

function roomParameters(query: QueryAggregate) {
  return {
    queryId: query.queryId,
    createdByPlayerId: query.createdByPlayerId,
    gameplayReleaseId: query.gameplayReleaseId,
    phase: query.phase,
    aggregateVersion: query.version,
    createdAt: new Date(query.createdAt),
    deadline: query.deadline === null ? null : new Date(query.deadline),
    explorationStartedAt:
      query.explorationStartedAt === null
        ? null
        : new Date(query.explorationStartedAt),
    scenarioVariantId: query.scenario?.variantId ?? null,
    randomSeed: query.scenario
      ? Buffer.from(query.scenario.randomSeed, "utf8")
      : null,
    correctChoice: query.scenario?.correctChoice ?? null,
    selectedChoice: query.selectedChoice,
  };
}

async function insertChildren(
  transaction: QueryExecutor,
  query: QueryAggregate,
): Promise<void> {
  for (const participant of query.participants) {
    await transaction.query(
      `
INSERT INTO "query"."QueryParticipants"
  ("queryId", "playerId", "factionId", "joinedAt", "participationStatus")
VALUES (@queryId, @playerId, @factionId, @joinedAt, 'confirmed')
ON CONFLICT ("queryId", "playerId") DO NOTHING;
`,
      {
        queryId: query.queryId,
        playerId: participant.playerId,
        factionId: participant.factionId,
        joinedAt: new Date(participant.joinedAt),
      },
    );
  }

  const actionOrdinals = new Map<string, number>();
  for (const action of query.actions) {
    const actionOrdinal = (actionOrdinals.get(action.playerId) ?? 0) + 1;
    actionOrdinals.set(action.playerId, actionOrdinal);
    await transaction.query(
      `
INSERT INTO "query"."QueryActions"
  ("queryId", "playerId", "actionOrdinal", "siteId", "cardId", "evidenceText", "isTruth", "acceptedAt")
VALUES
  (@queryId, @playerId, @actionOrdinal, @siteId, @cardId, @evidenceText, @isTruth, @acceptedAt)
ON CONFLICT ("queryId", "playerId", "actionOrdinal") DO NOTHING;
`,
      {
        queryId: query.queryId,
        playerId: action.playerId,
        actionOrdinal,
        siteId: action.siteId,
        cardId: action.card.cardId,
        evidenceText: action.card.text,
        isTruth: action.card.isTruth,
        acceptedAt: new Date(action.acceptedAt),
      },
    );
    const persistedActions = await transaction.query<ActionRow>(
      `SELECT "playerId" AS "playerId", "siteId" AS "siteId",
              "cardId" AS "cardId", "evidenceText" AS "evidenceText",
              "isTruth" AS "isTruth", "acceptedAt" AS "acceptedAt"
       FROM "query"."QueryActions"
       WHERE "queryId" = @queryId AND "playerId" = @playerId
         AND "actionOrdinal" = @actionOrdinal;`,
      {
        queryId: query.queryId,
        playerId: action.playerId,
        actionOrdinal,
      },
    );
    const persistedAction = persistedActions[0];
    if (
      !persistedAction ||
      persistedAction.siteId !== action.siteId ||
      persistedAction.cardId !== action.card.cardId ||
      persistedAction.evidenceText !== action.card.text ||
      persistedAction.isTruth !== action.card.isTruth ||
      persistedAction.acceptedAt.getTime() !== action.acceptedAt
    ) {
      throw new Error("Persisted Query actions are immutable");
    }
  }

  for (const vote of query.votes) {
    await transaction.query(
      `
INSERT INTO "query"."QueryVotes" ("queryId", "playerId", "choice", "updatedAt")
VALUES (@queryId, @playerId, @choice, CURRENT_TIMESTAMP);
`,
      {
        queryId: query.queryId,
        playerId: vote.playerId,
        choice: vote.choice,
      },
    );
  }
}

async function insertSettlementPlan(
  transaction: QueryExecutor,
  queryId: string,
  plan: SettlementPlan,
): Promise<void> {
  await transaction.query(
    `
INSERT INTO "query"."SettlementPlans"
  ("queryId", "settlementId", "boardDeltaJson")
VALUES (@queryId, @settlementId, @boardDeltaJson)
ON CONFLICT ("queryId") DO NOTHING;
`,
    {
      queryId,
      settlementId: plan.settlementId,
      boardDeltaJson: JSON.stringify(plan.boardDelta),
    },
  );
  for (const effectKey of plan.targets) {
    await transaction.query(
      `
INSERT INTO "query"."SettlementTargets" ("queryId", "effectKey")
VALUES (@queryId, @effectKey)
ON CONFLICT ("queryId", "effectKey") DO NOTHING;
`,
      { queryId, effectKey },
    );
  }
  for (const { playerId, requestedDelta } of plan.pointAwards) {
    await transaction.query(
      `
INSERT INTO "query"."SettlementPointAwards"
  ("queryId", "playerId", "requestedDelta")
VALUES (@queryId, @playerId, @requestedDelta)
ON CONFLICT ("queryId", "playerId") DO NOTHING;
`,
      { queryId, playerId, requestedDelta },
    );
  }
}

function hydrateQuery(
  room: QueryRoomRow,
  participantRows: readonly ParticipantRow[],
  actionRows: readonly ActionRow[],
  voteRows: readonly VoteRow[],
  settlementPlan: SettlementPlan | null,
): QueryAggregate {
  const scenario = hydrateScenario(room);
  return {
    queryId: room.queryId,
    createdByPlayerId: room.createdByPlayerId,
    gameplayReleaseId: room.gameplayReleaseId,
    phase: room.phase,
    version: Number(room.aggregateVersion),
    createdAt: room.createdAt.getTime(),
    deadline: room.deadline?.getTime() ?? null,
    explorationStartedAt: room.explorationStartedAt?.getTime() ?? null,
    scenario,
    participants: participantRows.map(({ playerId, factionId, joinedAt }) => ({
      playerId,
      factionId,
      joinedAt: joinedAt.getTime(),
    })),
    actions: actionRows.map((row) => ({
      playerId: row.playerId,
      siteId: row.siteId,
      acceptedAt: row.acceptedAt.getTime(),
      card: hydrateCard(row),
    })),
    votes: voteRows.map(({ playerId, choice }) => ({ playerId, choice })),
    selectedChoice: room.selectedChoice,
    settlementPlan,
  };
}

function hydrateScenario(room: QueryRoomRow): QueryScenario | null {
  if (
    room.scenarioVariantId === null ||
    room.randomSeed === null ||
    room.correctChoice === null
  ) {
    if (
      room.scenarioVariantId !== null ||
      room.randomSeed !== null ||
      room.correctChoice !== null
    ) {
      throw new Error("Persisted query scenario is incomplete");
    }
    return null;
  }
  return {
    variantId: room.scenarioVariantId,
    randomSeed: new TextDecoder("utf-8", { fatal: true }).decode(
      room.randomSeed,
    ),
    correctChoice: room.correctChoice,
  };
}

function hydrateCard(row: ActionRow): PrivateEvidenceCard {
  return {
    cardId: row.cardId,
    playerId: row.playerId,
    siteId: row.siteId,
    text: row.evidenceText,
    isTruth: row.isTruth,
  };
}

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}
