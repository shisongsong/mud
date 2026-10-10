import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createQuery,
  getAuthorizedQueryView,
  inspectQuery,
  joinQuery,
} from "../../modules/query/public.ts";
import type {
  QueryAggregate,
  QueryScenario,
} from "../../modules/query/public.ts";
import type {
  QueryExecutor,
  SqlParameters,
  UnitOfWork,
} from "../transactions/unit-of-work.ts";
import { PostgresQueryRepository } from "./query-repository.ts";

const playerIds = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];
const queryId = "10000000-0000-4000-8000-000000000001";
const cardId = "20000000-0000-4000-8000-000000000001";
const scenario: QueryScenario = {
  variantId: "trial_1_variant_a",
  randomSeed: "audit-seed-01",
  correctChoice: "choice_2",
};

function exploringQuery(): QueryAggregate {
  let query = createQuery(
    queryId,
    playerIds[0]!,
    "gameplay_release_1",
    1_000,
    "faction_1",
  );
  query = joinQuery(query, playerIds[1]!, 1_001, () => scenario, "faction_2");
  query = joinQuery(query, playerIds[2]!, 1_002, () => scenario, "faction_3");
  return joinQuery(query, playerIds[3]!, 1_003, () => scenario, "faction_4");
}

class RecordingUnitOfWork implements UnitOfWork {
  readonly statements: { statement: string; parameters?: SqlParameters }[] = [];
  allowUpdate = true;

  constructor(
    private readonly aggregate: QueryAggregate | null = null,
    private readonly reservation?: {
      readonly phase: "waiting";
      readonly deadline: Date | null;
      readonly seatCount: number;
      readonly alreadyMember: boolean;
    },
  ) {}

  async transaction<T>(
    work: (executor: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    return work({
      query: async <Row extends object>(
        statement: string,
        parameters?: SqlParameters,
      ): Promise<readonly Row[]> => {
        this.statements.push(
          parameters === undefined ? { statement } : { statement, parameters },
        );
        const rows = this.rowsFor(statement);
        return rows as readonly Row[];
      },
    });
  }

  private rowsFor(statement: string): readonly object[] {
    if (
      statement.includes('FROM "query"."QueryRooms"') &&
      statement.includes("FOR UPDATE")
    ) {
      return this.reservation ? [this.reservation] : [];
    }
    if (statement.includes('COUNT(*)::integer AS "seatCount"')) {
      return this.reservation
        ? [
            {
              seatCount: this.reservation.seatCount,
              alreadyMember: this.reservation.alreadyMember,
            },
          ]
        : [];
    }
    const aggregate = this.aggregate;
    if (!aggregate) return [];
    if (statement.includes('RETURNING "queryId"')) {
      return this.allowUpdate ? [{ queryId: aggregate.queryId }] : [];
    }
    if (statement.includes('FROM "query"."QueryRooms"')) {
      return [
        {
          queryId: aggregate.queryId,
          createdByPlayerId: aggregate.createdByPlayerId,
          gameplayReleaseId: aggregate.gameplayReleaseId,
          phase: aggregate.phase,
          aggregateVersion: aggregate.version,
          createdAt: new Date(aggregate.createdAt),
          deadline:
            aggregate.deadline === null ? null : new Date(aggregate.deadline),
          explorationStartedAt:
            aggregate.explorationStartedAt === null
              ? null
              : new Date(aggregate.explorationStartedAt),
          scenarioVariantId: aggregate.scenario?.variantId ?? null,
          randomSeed: aggregate.scenario
            ? new TextEncoder().encode(aggregate.scenario.randomSeed)
            : null,
          correctChoice: aggregate.scenario?.correctChoice ?? null,
          selectedChoice: aggregate.selectedChoice,
        },
      ];
    }
    if (statement.includes('FROM "query"."QueryParticipants"')) {
      return aggregate.participants.map(
        ({ playerId, factionId, joinedAt }) => ({
          playerId,
          factionId,
          joinedAt: new Date(joinedAt),
        }),
      );
    }
    if (statement.includes('FROM "query"."QueryActions"')) {
      return aggregate.actions.map(
        ({ playerId, siteId, card, acceptedAt }) => ({
          playerId,
          siteId,
          cardId: card.cardId,
          evidenceText: card.text,
          isTruth: card.isTruth,
          acceptedAt: new Date(acceptedAt),
        }),
      );
    }
    if (statement.includes('FROM "query"."QueryVotes"')) {
      return aggregate.votes.map(({ playerId, choice }) => ({
        playerId,
        choice,
      }));
    }
    return [];
  }
}

class SlotClaimUnitOfWork implements UnitOfWork {
  readonly statements: string[] = [];
  status: "reserved" | "slot_claimed" = "reserved";
  slotQueryId: string | null;

  constructor(existingSlotQueryId: string | null = null) {
    this.slotQueryId = existingSlotQueryId;
  }

  async transaction<T>(
    work: (executor: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    return work({
      query: async <Row extends object>(statement: string) => {
        this.statements.push(statement);
        if (statement.includes('FROM "query"."JoinReservations"')) {
          return [
            {
              reservationId: "30000000-0000-4000-8000-000000000001",
              queryId,
              playerId: playerIds[1],
              status: this.status,
              expiresAt: new Date(10_000),
            },
          ] as unknown as readonly Row[];
        }
        if (statement.includes('INSERT INTO "query"."ParticipationSlots"')) {
          if (this.slotQueryId !== null) return [];
          this.slotQueryId = queryId;
          return [{ playerId: playerIds[1] }] as unknown as readonly Row[];
        }
        if (statement.includes('FROM "query"."ParticipationSlots"')) {
          return this.slotQueryId === null
            ? []
            : ([{ queryId: this.slotQueryId }] as unknown as readonly Row[]);
        }
        if (statement.includes('UPDATE "query"."JoinReservations"')) {
          this.status = "slot_claimed";
        }
        return [];
      },
    });
  }
}

class JoinConfirmationUnitOfWork implements UnitOfWork {
  readonly statements: string[] = [];

  constructor(private readonly query: QueryAggregate) {}

  async transaction<T>(
    work: (executor: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    return work({
      query: async <Row extends object>(statement: string) => {
        this.statements.push(statement);
        if (statement.includes('FROM "query"."JoinReservations"')) {
          return [
            {
              reservationId: "30000000-0000-4000-8000-000000000001",
              queryId: this.query.queryId,
              playerId: playerIds[3],
              status: "slot_claimed",
              expiresAt: new Date(this.query.deadline!),
            },
          ] as unknown as readonly Row[];
        }
        if (statement.includes('FROM "query"."QueryRooms"')) {
          return [
            {
              queryId: this.query.queryId,
              createdByPlayerId: this.query.createdByPlayerId,
              gameplayReleaseId: this.query.gameplayReleaseId,
              phase: this.query.phase,
              aggregateVersion: this.query.version,
              createdAt: new Date(this.query.createdAt),
              deadline: new Date(this.query.deadline!),
              explorationStartedAt: null,
              scenarioVariantId: null,
              randomSeed: null,
              correctChoice: null,
              selectedChoice: null,
            },
          ] as unknown as readonly Row[];
        }
        if (statement.includes('FROM "query"."QueryParticipants"')) {
          return this.query.participants.map(
            ({ playerId, factionId, joinedAt }) => ({
              playerId,
              factionId,
              joinedAt: new Date(joinedAt),
            }),
          ) as unknown as readonly Row[];
        }
        if (statement.includes('FROM "query"."ParticipationSlots"')) {
          return [{ queryId: this.query.queryId }] as unknown as readonly Row[];
        }
        if (statement.includes('UPDATE "query"."QueryRooms"')) {
          return [{ queryId: this.query.queryId }] as unknown as readonly Row[];
        }
        return [];
      },
    });
  }
}

test("Query repository creates the aggregate and its initial participants atomically", async () => {
  const unitOfWork = new RecordingUnitOfWork();
  const repository = new PostgresQueryRepository(unitOfWork);
  const query = createQuery(
    queryId,
    playerIds[0]!,
    "gameplay_release_1",
    1_000,
    "faction_1",
  );

  await repository.create(query);

  assert.equal(unitOfWork.statements.length, 2);
  assert.match(
    unitOfWork.statements[0]!.statement,
    /INSERT INTO "query"\."QueryRooms"/,
  );
  assert.match(
    unitOfWork.statements[1]!.statement,
    /INSERT INTO "query"\."QueryParticipants"/,
  );
  assert.deepEqual(unitOfWork.statements[1]!.parameters, {
    queryId,
    playerId: playerIds[0],
    factionId: "faction_1",
    joinedAt: new Date(1_000),
  });
});

test("join seat reservation locks capacity and writes only reserved state", async () => {
  const unitOfWork = new RecordingUnitOfWork(null, {
    phase: "waiting",
    deadline: new Date(10_000),
    seatCount: 3,
    alreadyMember: false,
  });
  const repository = new PostgresQueryRepository(unitOfWork);
  const reservationId = "30000000-0000-4000-8000-000000000001";

  const result = await unitOfWork.transaction((transaction) =>
    repository.reserveJoinSeatInTransaction(
      transaction,
      reservationId,
      queryId,
      playerIds[1]!,
      "faction_2",
      2_000,
    ),
  );

  assert.deepEqual(result, { expiresAt: new Date(10_000) });
  assert.match(unitOfWork.statements[0]!.statement, /FOR UPDATE/);
  assert.match(
    unitOfWork.statements[1]!.statement,
    /"participationStatus" IN \('reserved', 'confirmed'\)/,
  );
  assert.match(
    unitOfWork.statements[2]!.statement,
    /INSERT INTO "query"\."JoinReservations"/,
  );
  assert.match(unitOfWork.statements[3]!.statement, /'reserved'/);
  assert.doesNotMatch(
    unitOfWork.statements.map(({ statement }) => statement).join("\n"),
    /ParticipationSlots/,
  );
  assert.deepEqual(unitOfWork.statements[3]!.parameters, {
    queryId,
    playerId: playerIds[1],
    factionId: "faction_2",
    joinedAt: new Date(2_000),
  });
});

test("join seat reservation rejects a room whose confirmed and reserved seats are full", async () => {
  const unitOfWork = new RecordingUnitOfWork(null, {
    phase: "waiting",
    deadline: new Date(10_000),
    seatCount: 4,
    alreadyMember: false,
  });
  const repository = new PostgresQueryRepository(unitOfWork);

  await assert.rejects(
    unitOfWork.transaction((transaction) =>
      repository.reserveJoinSeatInTransaction(
        transaction,
        "30000000-0000-4000-8000-000000000002",
        queryId,
        playerIds[1]!,
        "faction_2",
        2_000,
      ),
    ),
    (error: unknown) =>
      error instanceof Error && error.message === "QUERY_FULL",
  );
  assert.equal(unitOfWork.statements.length, 2);
});

test("ParticipationSlot claim is idempotent for the same room", async () => {
  const unitOfWork = new SlotClaimUnitOfWork(queryId);
  const repository = new PostgresQueryRepository(unitOfWork);

  await repository.claimParticipationSlot(
    "30000000-0000-4000-8000-000000000001",
    2_000,
  );

  assert.equal(unitOfWork.status, "slot_claimed");
  assert.ok(
    unitOfWork.statements.some((statement) =>
      statement.includes('ON CONFLICT ("playerId") DO NOTHING'),
    ),
  );
});

test("ParticipationSlot claim rejects a concurrent reservation for another room", async () => {
  const unitOfWork = new SlotClaimUnitOfWork(
    "10000000-0000-4000-8000-000000000099",
  );
  const repository = new PostgresQueryRepository(unitOfWork);

  await assert.rejects(
    repository.claimParticipationSlot(
      "30000000-0000-4000-8000-000000000001",
      2_000,
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "QUERY_JOIN_PLAYER_ALREADY_IN_QUERY",
  );
  assert.equal(unitOfWork.status, "reserved");
});

test("expired join reservation query selects only unconfirmed reservations past their deadline", async () => {
  const unitOfWork = new RecordingUnitOfWork();
  const repository = new PostgresQueryRepository(unitOfWork);

  const ids = await repository.listExpiredJoinReservationIds(5_000, 25);

  assert.deepEqual(ids, []);
  assert.equal(unitOfWork.statements.length, 1);
  assert.match(
    unitOfWork.statements[0]!.statement,
    /"status" IN \('reserved', 'slot_claimed'\) AND "expiresAt" <= @now/,
  );
  assert.match(unitOfWork.statements[0]!.statement, /LIMIT @limit/);
  assert.deepEqual(unitOfWork.statements[0]!.parameters, {
    now: new Date(5_000),
    limit: 25,
  });
});

test("fourth confirmed join starts exploration and emits within the confirmation transaction", async () => {
  let query = createQuery(
    queryId,
    playerIds[0]!,
    "gameplay_release_1",
    1_000,
    "faction_1",
  );
  query = joinQuery(query, playerIds[1]!, 1_001, () => scenario, "faction_2");
  query = joinQuery(query, playerIds[2]!, 1_002, () => scenario, "faction_3");
  const unitOfWork = new JoinConfirmationUnitOfWork(query);
  const repository = new PostgresQueryRepository(unitOfWork);
  const emittedVersions: number[] = [];

  const result = await unitOfWork.transaction((transaction) =>
    repository.confirmJoinInTransaction(
      transaction,
      "30000000-0000-4000-8000-000000000001",
      2_000,
      "faction_4",
      async () => scenario,
      async (_transaction, confirmed) => {
        emittedVersions.push(confirmed.version);
      },
    ),
  );

  assert.equal(result.query.phase, "exploring");
  assert.equal(result.query.participants.length, 4);
  assert.deepEqual(emittedVersions, [result.query.version]);
  assert.ok(
    unitOfWork.statements.some(
      (statement) =>
        statement.includes("participationStatus") &&
        statement.includes("reserved"),
    ),
  );
});

test("Query repository writes scenario seeds as bounded UTF-8 bytes", async () => {
  const unitOfWork = new RecordingUnitOfWork();
  const repository = new PostgresQueryRepository(unitOfWork);

  await repository.create(exploringQuery());

  assert.deepEqual(
    unitOfWork.statements[0]!.parameters?.["randomSeed"],
    Buffer.from(scenario.randomSeed, "utf8"),
  );
});

test("Query repository rehydrates scenario and keeps evidence truth private", async () => {
  let query = exploringQuery();
  query = inspectQuery(query, playerIds[0]!, "site_1", 1_004, () => ({
    cardId,
    playerId: playerIds[0]!,
    siteId: "site_1",
    text: "A clue known only to its finder.",
    isTruth: true,
  }));
  const repository = new PostgresQueryRepository(
    new RecordingUnitOfWork(query),
  );

  const rehydrated = await repository.get(queryId);

  assert.deepEqual(rehydrated, query);
  assert.equal(
    getAuthorizedQueryView(rehydrated!, playerIds[0]!).ownEvidenceCards[0]
      ?.text,
    "A clue known only to its finder.",
  );
  assert.equal(
    "isTruth" in
      getAuthorizedQueryView(rehydrated!, playerIds[0]!).ownEvidenceCards[0]!,
    false,
  );
});

test("Query repository uses aggregate-version compare-and-swap before synchronizing children", async () => {
  const current = exploringQuery();
  const changed = inspectQuery(current, playerIds[0]!, "site_1", 1_004, () => ({
    cardId,
    playerId: playerIds[0]!,
    siteId: "site_1",
    text: "Private evidence",
    isTruth: false,
  }));
  const unitOfWork = new RecordingUnitOfWork(changed);
  const repository = new PostgresQueryRepository(unitOfWork);

  unitOfWork.allowUpdate = false;
  assert.equal(await repository.save(changed, current.version), false);
  assert.equal(
    unitOfWork.statements.some(({ statement }) =>
      statement.startsWith('DELETE FROM "query".'),
    ),
    false,
  );

  unitOfWork.statements.length = 0;
  unitOfWork.allowUpdate = true;
  assert.equal(await repository.save(changed, current.version), true);
  assert.match(
    unitOfWork.statements[0]!.statement,
    /"aggregateVersion" = @expectedVersion/,
  );
  assert.ok(
    unitOfWork.statements.some(({ statement }) =>
      statement.includes('INSERT INTO "query"."QueryActions"'),
    ),
  );
  assert.equal(
    unitOfWork.statements.some(({ statement }) =>
      statement.startsWith('DELETE FROM "query"."QueryActions"'),
    ),
    false,
  );
});
