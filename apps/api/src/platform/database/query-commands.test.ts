import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlayerActor } from "../../kernel/actor.ts";
import type { Clock, IdGenerator } from "../../kernel/ports.ts";
import {
  advanceQuery,
  createQuery,
  joinQuery,
  QueryRuleError,
} from "../../modules/query/public.ts";
import type { QueryAggregate } from "../../modules/query/public.ts";
import {
  IdempotencyConflictError,
  PostgresCommandReceipts,
} from "../transactions/command-receipts.ts";
import type {
  QueryExecutor,
  SqlParameters,
  UnitOfWork,
} from "../transactions/unit-of-work.ts";
import { PostgresQueryCommands } from "./query-commands.ts";
import {
  PostgresQueryRepository,
  QueryJoinConflictError,
} from "./query-repository.ts";
import type {
  ActiveGameplayRelease,
  GameplayReleaseReader,
} from "./gameplay-release-repository.ts";
import { GameplayNotReadyError } from "./gameplay-release-repository.ts";

interface MemoryReceipt {
  readonly requestDigest: string;
  readonly status: "completed";
  readonly responseJson: string;
}

class MemoryCommandDatabase implements UnitOfWork {
  readonly statements: string[] = [];
  readonly transactionStatements: string[][] = [];
  readonly outboxEvents: SqlParameters[] = [];
  transactionCount = 0;
  private receipts = new Map<string, MemoryReceipt>();
  private outboxStreams = new Map<string, number>();

  async transaction<T>(
    work: (executor: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    const receipts = new Map(this.receipts);
    const outboxStreams = new Map(this.outboxStreams);
    const outboxEvents = [...this.outboxEvents];
    const transactionStatements: string[] = [];
    const executor: QueryExecutor = {
      query: async <Row extends object>(
        statement: string,
        parameters: SqlParameters = {},
      ): Promise<readonly Row[]> => {
        this.statements.push(statement);
        transactionStatements.push(statement);
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes('INSERT INTO "platform"."OutboxStreams"')) {
          const streamId = String(parameters["streamId"]);
          if (!outboxStreams.has(streamId)) outboxStreams.set(streamId, 1);
          return [];
        }
        if (statement.includes('UPDATE "platform"."OutboxStreams"')) {
          const streamId = String(parameters["streamId"]);
          const sequence = outboxStreams.get(streamId);
          if (sequence === undefined) throw new Error("Missing outbox stream");
          outboxStreams.set(streamId, sequence + 1);
          return [{ sequence }] as unknown as readonly Row[];
        }
        if (statement.includes('INSERT INTO "platform"."OutboxEvents"')) {
          outboxEvents.push(parameters);
          return [];
        }
        if (statement.includes('FROM "platform"."CommandReceipts"')) {
          const key = receiptKey(parameters);
          const receipt = receipts.get(key);
          return (receipt ? [receipt] : []) as unknown as readonly Row[];
        }
        if (statement.includes('INSERT INTO "platform"."CommandReceipts"')) {
          receipts.set(receiptKey(parameters), {
            requestDigest: String(parameters["requestDigest"]),
            status: "completed",
            responseJson: String(parameters["responseJson"]),
          });
          return [];
        }
        return [];
      },
    };

    const result = await work(executor);
    this.receipts = receipts;
    this.outboxStreams = outboxStreams;
    this.outboxEvents.splice(0, this.outboxEvents.length, ...outboxEvents);
    this.transactionStatements.push(transactionStatements);
    return result;
  }
}

function receiptKey(parameters: SqlParameters): string {
  return [
    parameters["actorScope"],
    parameters["operation"],
    parameters["idempotencyKey"],
  ].join("|");
}

const actor: PlayerActor = {
  kind: "player",
  accountId: "11111111-1111-4111-8111-111111111111",
  playerId: "22222222-2222-4222-8222-222222222222",
};
const input = {
  templateId: "trial_1" as const,
  gameplayReleaseId: "gameplay_v1",
};

const clock: Clock = { now: () => new Date("2026-09-30T12:00:00.000Z") };
const now = clock.now().getTime();
const activeGameplayRelease: GameplayReleaseReader = {
  getActiveGameplayRelease: async () => ({
    releaseId: "gameplay_v1",
    queryEnabled: true,
    templates: ["trial_1"],
  }),
  getGameplayReleaseById: async () => ({
    releaseId: "gameplay_v1",
    queryEnabled: true,
    templates: ["trial_1"],
  }),
};

class SequentialIds implements IdGenerator {
  calls = 0;

  next(): string {
    this.calls += 1;
    return `33333333-3333-4333-8333-${String(this.calls).padStart(12, "0")}`;
  }
}

function commandsForAggregate(
  initialQuery: QueryAggregate,
  release: GameplayReleaseReader = activeGameplayRelease,
) {
  let aggregate = initialQuery;
  let saveCalls = 0;
  const database = new MemoryCommandDatabase();
  const repository = {
    runInTransaction: <T>(work: (executor: QueryExecutor) => Promise<T>) =>
      database.transaction(work),
    listDueQueryIds: async () => [aggregate.queryId],
    getInTransaction: async (_transaction: QueryExecutor, queryId: string) =>
      aggregate.queryId === queryId ? aggregate : null,
    saveInTransaction: async (
      _transaction: QueryExecutor,
      updated: QueryAggregate,
      expectedVersion: number,
    ) => {
      if (aggregate.version !== expectedVersion) return false;
      aggregate = updated;
      saveCalls += 1;
      return true;
    },
  } as unknown as PostgresQueryRepository;
  const commands = new PostgresQueryCommands(
    repository,
    new PostgresCommandReceipts(database),
    release,
    new SequentialIds(),
    clock,
  );
  return {
    commands,
    database,
    get aggregate() {
      return aggregate;
    },
    get saveCalls() {
      return saveCalls;
    },
  };
}

function votingQuery(): QueryAggregate {
  const scenario = {
    variantId: "trial_1_variant_a",
    randomSeed: "seed_audit_1",
    correctChoice: "choice_2" as const,
  };
  let query = createQuery(
    "33333333-3333-4333-8333-333333333333",
    actor.playerId,
    "gameplay_v1",
    now - 200_000,
  );
  query = joinQuery(query, "player_2", now - 190_000, () => scenario);
  query = joinQuery(query, "player_3", now - 180_000, () => scenario);
  query = joinQuery(query, "player_4", now - 170_000, () => scenario);
  return advanceQuery(query, now - 49_000);
}

test("create-query command atomically persists and replays its idempotent receipt", async () => {
  const database = new MemoryCommandDatabase();
  const ids = new SequentialIds();
  const repository = new PostgresQueryRepository(database);
  const receipts = new PostgresCommandReceipts(database);
  const commands = new PostgresQueryCommands(
    repository,
    receipts,
    activeGameplayRelease,
    ids,
    clock,
  );
  const idempotencyKey = "create-query-key-0001";
  const traceId = "77777777-7777-4777-8777-777777777777";

  const first = await commands.create(actor, input, idempotencyKey, traceId);
  const replay = await commands.create(actor, input, idempotencyKey, traceId);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(ids.calls, 2);
  assert.equal(database.transactionCount, 2);
  assert.equal(
    database.statements.filter((statement) =>
      statement.includes('INSERT INTO "query"."QueryRooms"'),
    ).length,
    1,
  );
  assert.equal(
    database.statements.filter((statement) =>
      statement.includes('INSERT INTO "platform"."CommandReceipts"'),
    ).length,
    1,
  );
  assert.equal(database.outboxEvents.length, 1);
  assert.equal(database.outboxEvents[0]?.["eventType"], "QueryCreated");
  assert.equal(database.outboxEvents[0]?.["streamId"], first.result.queryId);
  assert.equal(database.outboxEvents[0]?.["traceId"], traceId);
  assert.equal(database.outboxEvents[0]?.["correlationId"], traceId);
  assert.ok(
    [
      'INSERT INTO "query"."QueryRooms"',
      'INSERT INTO "platform"."OutboxEvents"',
      'INSERT INTO "platform"."CommandReceipts"',
    ].every((fragment) =>
      database.transactionStatements[0]?.some((statement) =>
        statement.includes(fragment),
      ),
    ),
  );
});

test("create-query refuses the bootstrap release without writing anything", async () => {
  const database = new MemoryCommandDatabase();
  const bootstrapRelease: GameplayReleaseReader = {
    getActiveGameplayRelease: async () => ({
      releaseId: "gameplay_bootstrap_v1",
      queryEnabled: false,
      templates: ["trial_1"],
    }),
    getGameplayReleaseById: async () => ({
      releaseId: "gameplay_bootstrap_v1",
      queryEnabled: false,
      templates: ["trial_1"],
    }),
  };
  const commands = new PostgresQueryCommands(
    new PostgresQueryRepository(database),
    new PostgresCommandReceipts(database),
    bootstrapRelease,
    new SequentialIds(),
    clock,
  );

  await assert.rejects(
    commands.create(
      actor,
      { ...input, gameplayReleaseId: "gameplay_bootstrap_v1" },
      "create-query-key-bootstrap",
    ),
    GameplayNotReadyError,
  );
  assert.equal(
    database.statements.some((statement) =>
      statement.includes('INSERT INTO "query"."QueryRooms"'),
    ),
    false,
  );
  assert.equal(database.outboxEvents.length, 0);
});

test("create-query command rejects reuse of its key for different normalized input", async () => {
  const database = new MemoryCommandDatabase();
  const ids = new SequentialIds();
  const commands = new PostgresQueryCommands(
    new PostgresQueryRepository(database),
    new PostgresCommandReceipts(database),
    activeGameplayRelease,
    ids,
    clock,
  );
  const idempotencyKey = "create-query-key-0002";

  await commands.create(actor, input, idempotencyKey);
  await assert.rejects(
    commands.create(
      actor,
      { ...input, gameplayReleaseId: "gameplay_v2" },
      idempotencyKey,
    ),
    IdempotencyConflictError,
  );
  assert.equal(ids.calls, 3);
});

test("create-query rolls back when its Outbox event envelope is invalid", async () => {
  const database = new MemoryCommandDatabase();
  const commands = new PostgresQueryCommands(
    new PostgresQueryRepository(database),
    new PostgresCommandReceipts(database),
    activeGameplayRelease,
    new SequentialIds(),
    clock,
  );

  await assert.rejects(
    commands.create(actor, input, "create-query-key-0003", "invalid-trace-id"),
    /Invalid outbox event envelope/,
  );
  assert.ok(
    database.statements.some((statement) =>
      statement.includes('INSERT INTO "query"."QueryRooms"'),
    ),
  );
  assert.equal(database.transactionStatements.length, 0);
  assert.equal(database.outboxEvents.length, 0);
  assert.equal(
    database.statements.some((statement) =>
      statement.includes('INSERT INTO "platform"."CommandReceipts"'),
    ),
    false,
  );
});

test("leave-query command commits one versioned mutation and replays its receipt", async () => {
  const query = createQuery(
    "33333333-3333-4333-8333-333333333333",
    actor.playerId,
    "gameplay_v1",
    now,
  );
  const fixture = commandsForAggregate(query);
  const key = "leave-query-key-0001";

  const first = await fixture.commands.leave(
    actor,
    query.queryId,
    { expectedVersion: query.version },
    key,
  );
  const replay = await fixture.commands.leave(
    actor,
    query.queryId,
    { expectedVersion: query.version },
    key,
  );

  assert.equal(first.result.aggregateVersion, 2);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(fixture.aggregate.phase, "cancelled");
  assert.equal(fixture.saveCalls, 1);
  assert.equal(fixture.database.outboxEvents.length, 1);
  assert.equal(
    fixture.database.outboxEvents[0]?.["eventType"],
    "QueryParticipantLeft",
  );
});

test("vote command enforces expected version and stores a receipt only on success", async () => {
  const query = votingQuery();
  const fixture = commandsForAggregate(query);
  const key = "cast-vote-key-0001";

  await assert.rejects(
    fixture.commands.vote(
      actor,
      query.queryId,
      { choiceId: "choice_1", expectedVersion: query.version - 1 },
      key,
    ),
    (error: unknown) =>
      error instanceof QueryRuleError &&
      error.code === "INVALID_EXPECTED_VERSION",
  );
  assert.equal(fixture.saveCalls, 0);
  assert.equal(fixture.database.outboxEvents.length, 0);

  const success = await fixture.commands.vote(
    actor,
    query.queryId,
    { choiceId: "choice_1", expectedVersion: query.version },
    key,
  );
  const replay = await fixture.commands.vote(
    actor,
    query.queryId,
    { choiceId: "choice_1", expectedVersion: query.version },
    key,
  );

  assert.equal(success.result.aggregateVersion, query.version + 1);
  assert.equal(replay.replayed, true);
  assert.equal(fixture.aggregate.votes[0]?.choice, "choice_1");
  assert.equal(fixture.saveCalls, 1);
  assert.equal(fixture.database.outboxEvents.length, 1);
  assert.equal(
    fixture.database.outboxEvents[0]?.["eventType"],
    "QueryVoteCast",
  );
  assert.deepEqual(
    fixture.database.outboxEvents[0]?.["payloadJson"],
    '{"playerId":"22222222-2222-4222-8222-222222222222","queryId":"33333333-3333-4333-8333-333333333333"}',
  );
});

class JoinRepositoryStub {
  readonly reservations: string[] = [];
  readonly claimed: string[] = [];
  readonly releasedSlots: string[] = [];
  readonly releasedSeats: string[] = [];
  readonly expiredReservationIds: string[] = [];
  readonly expiryQueries: { now: number; limit: number }[] = [];
  confirmCalls = 0;
  claimError: Error | null = null;
  confirmError: Error | null = null;

  constructor(private readonly query: QueryAggregate) {}

  async reserveJoinSeatInTransaction(
    _transaction: QueryExecutor,
    reservationId: string,
  ): Promise<void> {
    this.reservations.push(reservationId);
  }

  async claimParticipationSlot(reservationId: string): Promise<void> {
    if (this.claimError) throw this.claimError;
    this.claimed.push(reservationId);
  }

  async releaseParticipationSlot(reservationId: string): Promise<void> {
    this.releasedSlots.push(reservationId);
  }

  async releaseJoinSeat(reservationId: string): Promise<void> {
    this.releasedSeats.push(reservationId);
  }

  async listExpiredJoinReservationIds(
    now: number,
    limit: number,
  ): Promise<readonly string[]> {
    this.expiryQueries.push({ now, limit });
    return this.expiredReservationIds.slice(0, limit);
  }

  async confirmJoin(
    _reservationId: string,
    _now: number,
    createScenario: (
      transaction: QueryExecutor,
      query: QueryAggregate,
    ) => Promise<unknown>,
  ): Promise<{ readonly query: QueryAggregate; readonly replayed: boolean }> {
    this.confirmCalls += 1;
    if (this.confirmError) throw this.confirmError;
    await createScenario({} as QueryExecutor, this.query);
    return { query: this.query, replayed: false };
  }
}

const joinGameplayRelease: GameplayReleaseReader = {
  getActiveGameplayRelease: activeGameplayRelease.getActiveGameplayRelease,
  getGameplayReleaseById: async () =>
    ({
      releaseId: "gameplay_v1",
      queryEnabled: true,
      templates: ["trial_1"],
      trial1: {
        variants: [
          { variantId: "trial_1_variant_a", correctChoiceId: "choice_2" },
          { variantId: "trial_1_variant_b", correctChoiceId: "choice_1" },
        ],
      },
    }) as unknown as ActiveGameplayRelease,
};

function explorationQuery(): QueryAggregate {
  const scenario = {
    variantId: "trial_1_variant_a",
    randomSeed: "seed_audit_1",
    correctChoice: "choice_2" as const,
  };
  let query = createQuery(
    "33333333-3333-4333-8333-333333333333",
    actor.playerId,
    "gameplay_v1",
    now - 200_000,
  );
  query = joinQuery(query, "player_2", now - 190_000, () => scenario);
  query = joinQuery(query, "player_3", now - 180_000, () => scenario);
  return joinQuery(query, "player_4", now - 170_000, () => scenario);
}

function joinFixture(release: GameplayReleaseReader = joinGameplayRelease) {
  const repository = new JoinRepositoryStub(explorationQuery());
  const commands = new PostgresQueryCommands(
    repository as unknown as PostgresQueryRepository,
    new PostgresCommandReceipts(new MemoryCommandDatabase()),
    release,
    new SequentialIds(),
    clock,
  );
  return { commands, repository };
}

test("join command reserves, claims and confirms, then replays its receipt", async () => {
  const fixture = joinFixture();
  const key = "join-query-key-0001";

  const first = await fixture.commands.join(
    actor,
    "33333333-3333-4333-8333-333333333333",
    key,
  );
  const replay = await fixture.commands.join(
    actor,
    "33333333-3333-4333-8333-333333333333",
    key,
  );

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(first.result, {
    queryId: "33333333-3333-4333-8333-333333333333",
    aggregateVersion: 4,
    phase: "exploring",
  });
  assert.deepEqual(replay.result, first.result);
  assert.equal(fixture.repository.reservations.length, 1);
  assert.equal(fixture.repository.confirmCalls, 2);
});

test("join command releases its reserved seat when the participant slot is taken", async () => {
  const fixture = joinFixture();
  fixture.repository.claimError = new QueryJoinConflictError(
    "QUERY_JOIN_PLAYER_ALREADY_IN_QUERY",
  );

  await assert.rejects(
    fixture.commands.join(
      actor,
      "33333333-3333-4333-8333-333333333333",
      "join-query-key-0002",
    ),
    (error: unknown) =>
      error instanceof QueryJoinConflictError &&
      error.code === "QUERY_JOIN_PLAYER_ALREADY_IN_QUERY",
  );
  assert.deepEqual(
    fixture.repository.releasedSeats,
    fixture.repository.reservations,
  );
  assert.deepEqual(fixture.repository.releasedSlots, []);
  assert.equal(fixture.repository.confirmCalls, 0);
});

test("join command releases its slot and seat when the domain rejects confirmation", async () => {
  const fixture = joinFixture();
  fixture.repository.confirmError = new QueryRuleError("QUERY_EXPIRED");

  await assert.rejects(
    fixture.commands.join(
      actor,
      "33333333-3333-4333-8333-333333333333",
      "join-query-key-0003",
    ),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "QUERY_EXPIRED",
  );
  assert.deepEqual(
    fixture.repository.releasedSlots,
    fixture.repository.reservations,
  );
  assert.deepEqual(
    fixture.repository.releasedSeats,
    fixture.repository.reservations,
  );
});

test("join command fails closed when the pinned gameplay release is missing", async () => {
  const fixture = joinFixture({
    ...joinGameplayRelease,
    getGameplayReleaseById: async () => null,
  });

  await assert.rejects(
    fixture.commands.join(
      actor,
      "33333333-3333-4333-8333-333333333333",
      "join-query-key-0004",
    ),
    /Pinned gameplay release is unavailable/,
  );
  assert.equal(fixture.repository.confirmCalls, 1);
  assert.deepEqual(
    fixture.repository.releasedSlots,
    fixture.repository.reservations,
  );
  assert.deepEqual(
    fixture.repository.releasedSeats,
    fixture.repository.reservations,
  );
});

test("recovery sweep releases expired join reservations up to the limit", async () => {
  const fixture = joinFixture();
  const expired = [
    "40000000-0000-4000-8000-000000000001",
    "40000000-0000-4000-8000-000000000002",
  ];
  fixture.repository.expiredReservationIds.push(...expired);

  const released = await fixture.commands.releaseExpiredJoinReservations(1);

  assert.equal(released, 1);
  assert.deepEqual(fixture.repository.expiryQueries, [{ now, limit: 1 }]);
  assert.deepEqual(fixture.repository.releasedSlots, [expired[0]]);
  assert.deepEqual(fixture.repository.releasedSeats, [expired[0]]);
});

test("recovery sweep rejects a non-positive limit without touching reservations", async () => {
  const fixture = joinFixture();

  await assert.rejects(
    fixture.commands.releaseExpiredJoinReservations(0),
    TypeError,
  );
  assert.deepEqual(fixture.repository.expiryQueries, []);
});
