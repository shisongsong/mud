import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock, IdGenerator } from "../../kernel/ports.ts";
import {
  IdempotencyConflictError,
  PostgresCommandReceipts,
} from "../transactions/command-receipts.ts";
import type {
  QueryExecutor,
  SqlParameters,
  UnitOfWork,
} from "../transactions/unit-of-work.ts";
import { PostgresOutbox } from "../transactions/outbox.ts";
import type { GameplayReleaseReader } from "./gameplay-release-repository.ts";
import { PlayerAlreadyExistsError, PostgresPlayerCommands } from "./player-commands.ts";
import { PostgresPlayerRepository } from "./player-repository.ts";

interface Receipt {
  readonly requestDigest: string;
  readonly status: "completed";
  readonly responseJson: string;
}

class MemoryPlayerDatabase implements UnitOfWork {
  players = new Map<string, SqlParameters>();
  receipts = new Map<string, Receipt>();
  streams = new Map<string, number>();
  events: SqlParameters[] = [];

  async transaction<T>(work: (transaction: QueryExecutor) => Promise<T>): Promise<T> {
    const players = new Map(this.players);
    const receipts = new Map(this.receipts);
    const streams = new Map(this.streams);
    const events = [...this.events];
    const transaction: QueryExecutor = {
      query: async <Row extends object>(
        statement: string,
        parameters: SqlParameters = {},
      ): Promise<readonly Row[]> => {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes('FROM "platform"."CommandReceipts"')) {
          const receipt = receipts.get(receiptKey(parameters));
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
        if (statement.includes('FROM "player"."Players"')) {
          const player = [...players.values()].find(
            (record) => record["accountId"] === parameters["accountId"],
          );
          return (player ? [player] : []) as unknown as readonly Row[];
        }
        if (statement.includes('INSERT INTO "player"."Players"')) {
          const duplicate = [...players.values()].some(
            (record) => record["accountId"] === parameters["accountId"],
          );
          if (duplicate) {
            throw Object.assign(new Error("duplicate player"), {
              code: "23505",
              constraint: "Players_accountId_key",
            });
          }
          players.set(String(parameters["playerId"]), parameters);
          return [];
        }
        if (statement.includes('INSERT INTO "platform"."OutboxStreams"')) {
          const streamId = String(parameters["streamId"]);
          if (!streams.has(streamId)) streams.set(streamId, 1);
          return [];
        }
        if (statement.includes('UPDATE "platform"."OutboxStreams"')) {
          const streamId = String(parameters["streamId"]);
          const sequence = streams.get(streamId);
          if (sequence === undefined) throw new Error("Missing Outbox stream");
          streams.set(streamId, sequence + 1);
          return [{ sequence }] as unknown as readonly Row[];
        }
        if (statement.includes('INSERT INTO "platform"."OutboxEvents"')) {
          events.push(parameters);
          return [];
        }
        return [];
      },
    };
    const result = await work(transaction);
    this.players = players;
    this.receipts = receipts;
    this.streams = streams;
    this.events = events;
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

class SequentialIds implements IdGenerator {
  private calls = 0;

  next(): string {
    this.calls += 1;
    return `33333333-3333-4333-8333-${String(this.calls).padStart(12, "0")}`;
  }
}

const clock: Clock = { now: () => new Date("2026-10-08T12:00:00.000Z") };
const accountId = "11111111-1111-4111-8111-111111111111";
const input = {
  displayName: "Ada",
  factionId: "faction_1" as const,
  powerId: "power_1" as const,
  professionId: "profession_1" as const,
  gameplayReleaseId: "gameplay_v1",
};
const traceId = "77777777-7777-4777-8777-777777777777";
const activeGameplayRelease: GameplayReleaseReader = {
  getActiveGameplayRelease: async () => ({
    releaseId: "gameplay_v1",
    queryEnabled: false,
    templates: ["trial_1"],
  }),
  getGameplayReleaseById: async () => ({
    releaseId: "gameplay_v1",
    queryEnabled: true,
    templates: ["trial_1"],
  }),
};

function commandsFor(database: MemoryPlayerDatabase, ids = new SequentialIds()) {
  return new PostgresPlayerCommands(
    new PostgresPlayerRepository(),
    new PostgresCommandReceipts(database),
    new PostgresOutbox(),
    activeGameplayRelease,
    ids,
    clock,
  );
}

test("player creation commits one profile, receipt, and event, then replays", async () => {
  const database = new MemoryPlayerDatabase();
  const commands = commandsFor(database);
  const first = await commands.create(accountId, input, "create-player-key-0001", traceId);
  const replay = await commands.create(accountId, input, "create-player-key-0001", traceId);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(database.players.size, 1);
  assert.equal(database.receipts.size, 1);
  assert.equal(database.events.length, 1);
  assert.equal(database.events[0]?.["eventType"], "PlayerCreated");
  assert.equal(database.events[0]?.["traceId"], traceId);
});

test("player creation conflicts on a reused key with different input", async () => {
  const database = new MemoryPlayerDatabase();
  const commands = commandsFor(database);
  await commands.create(accountId, input, "create-player-key-0002", traceId);

  await assert.rejects(
    commands.create(
      accountId,
      { ...input, displayName: "Grace" },
      "create-player-key-0002",
      traceId,
    ),
    IdempotencyConflictError,
  );
  assert.equal(database.players.size, 1);
  assert.equal(database.events.length, 1);
});

test("an account cannot create a second player with another key", async () => {
  const database = new MemoryPlayerDatabase();
  const commands = commandsFor(database);
  await commands.create(accountId, input, "create-player-key-0003", traceId);

  await assert.rejects(
    commands.create(accountId, input, "create-player-key-0004", traceId),
    PlayerAlreadyExistsError,
  );
  assert.equal(database.players.size, 1);
  assert.equal(database.events.length, 1);
});

test("invalid PlayerCreated event rolls back profile and receipt", async () => {
  const database = new MemoryPlayerDatabase();
  const commands = commandsFor(database);

  await assert.rejects(
    commands.create(accountId, input, "create-player-key-0005", "invalid-trace"),
    /Invalid outbox event envelope/,
  );
  assert.equal(database.players.size, 0);
  assert.equal(database.receipts.size, 0);
  assert.equal(database.events.length, 0);
});