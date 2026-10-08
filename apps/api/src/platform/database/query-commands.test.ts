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
import { PostgresQueryRepository } from "./query-repository.ts";

interface MemoryReceipt {
  readonly requestDigest: string;
  readonly status: "completed";
  readonly responseJson: string;
}

class MemoryCommandDatabase implements UnitOfWork {
  readonly statements: string[] = [];
  transactionCount = 0;
  private receipts = new Map<string, MemoryReceipt>();

  async transaction<T>(
    work: (executor: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    const receipts = new Map(this.receipts);
    const executor: QueryExecutor = {
      query: async <Row extends object>(
        statement: string,
        parameters: SqlParameters = {},
      ): Promise<readonly Row[]> => {
        this.statements.push(statement);
        if (statement.includes("pg_advisory_xact_lock")) return [];
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

class SequentialIds implements IdGenerator {
  calls = 0;

  next(): string {
    this.calls += 1;
    return `33333333-3333-4333-8333-${String(this.calls).padStart(12, "0")}`;
  }
}

function commandsForAggregate(initialQuery: QueryAggregate) {
  let aggregate = initialQuery;
  let saveCalls = 0;
  const repository = {
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
  const database = new MemoryCommandDatabase();
  const commands = new PostgresQueryCommands(
    repository,
    new PostgresCommandReceipts(database),
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
  const commands = new PostgresQueryCommands(repository, receipts, ids, clock);
  const idempotencyKey = "create-query-key-0001";

  const first = await commands.create(actor, input, idempotencyKey);
  const replay = await commands.create(actor, input, idempotencyKey);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(ids.calls, 1);
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
});

test("create-query command rejects reuse of its key for different normalized input", async () => {
  const database = new MemoryCommandDatabase();
  const ids = new SequentialIds();
  const commands = new PostgresQueryCommands(
    new PostgresQueryRepository(database),
    new PostgresCommandReceipts(database),
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
  assert.equal(ids.calls, 1);
  assert.equal(database.transactionCount, 2);
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
});
