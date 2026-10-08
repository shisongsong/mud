import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlayerActor } from "../../kernel/actor.ts";
import type { Clock, IdGenerator } from "../../kernel/ports.ts";
import { IdempotencyConflictError } from "../transactions/command-receipts.ts";
import type {
  QueryExecutor,
  SqlParameters,
  UnitOfWork,
} from "../transactions/unit-of-work.ts";
import { SqlServerCommandReceipts } from "../transactions/command-receipts.ts";
import { SqlServerQueryCommands } from "./query-commands.ts";
import { SqlServerQueryRepository } from "./query-repository.ts";

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
        if (statement.includes("sys.sp_getapplock")) return [];
        if (statement.includes("FROM platform.CommandReceipts")) {
          const key = receiptKey(parameters);
          const receipt = receipts.get(key);
          return (receipt ? [receipt] : []) as unknown as readonly Row[];
        }
        if (statement.includes("INSERT INTO platform.CommandReceipts")) {
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

const clock: Clock = {
  now: () => new Date("2026-09-30T12:00:00.000Z"),
};

class SequentialIds implements IdGenerator {
  calls = 0;

  next(): string {
    this.calls += 1;
    return `33333333-3333-4333-8333-${String(this.calls).padStart(12, "0")}`;
  }
}

test("create-query command atomically persists and replays its idempotent receipt", async () => {
  const database = new MemoryCommandDatabase();
  const ids = new SequentialIds();
  const repository = new SqlServerQueryRepository(database);
  const receipts = new SqlServerCommandReceipts(database);
  const commands = new SqlServerQueryCommands(repository, receipts, ids, clock);
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
      statement.includes("INSERT INTO [query].QueryRooms"),
    ).length,
    1,
  );
  assert.equal(
    database.statements.filter((statement) =>
      statement.includes("INSERT INTO platform.CommandReceipts"),
    ).length,
    1,
  );
});

test("create-query command rejects reuse of its key for different normalized input", async () => {
  const database = new MemoryCommandDatabase();
  const ids = new SequentialIds();
  const commands = new SqlServerQueryCommands(
    new SqlServerQueryRepository(database),
    new SqlServerCommandReceipts(database),
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
