import assert from "node:assert/strict";
import { test } from "node:test";
import type { MigrationDatabase, MigrationSession } from "./migrator.ts";
import { applyMigrations } from "./migrator.ts";
import { migrations, type DatabaseMigration } from "./migrations.ts";

class FakeMigrationDatabase implements MigrationDatabase {
  applied: string[] = [];
  executed: string[] = [];

  async transaction<T>(
    work: (session: MigrationSession) => Promise<T>,
  ): Promise<T> {
    const applied = [...this.applied];
    const executed = [...this.executed];
    const session: MigrationSession = {
      acquireMigrationLock: async () => undefined,
      ensureHistoryTable: async () => undefined,
      getAppliedMigrationIds: async () => [...applied],
      execute: async (statement) => {
        if (statement === "FAIL") throw new Error("migration failed");
        executed.push(statement);
      },
      recordAppliedMigration: async (id) => {
        applied.push(id);
      },
    };

    const result = await work(session);
    this.applied = applied;
    this.executed = executed;
    return result;
  }
}

const fixtures: readonly DatabaseMigration[] = [
  { id: "0001_base", sql: "CREATE BASE" },
  { id: "0002_events", sql: "CREATE EVENTS" },
];

test("migration runner applies ordered migrations once", async () => {
  const database = new FakeMigrationDatabase();

  assert.deepEqual(await applyMigrations(database, fixtures), [
    "0001_base",
    "0002_events",
  ]);
  assert.deepEqual(await applyMigrations(database, fixtures), []);
  assert.deepEqual(database.executed, ["CREATE BASE", "CREATE EVENTS"]);
});

test("migration runner rejects missing or out-of-order history", async () => {
  const database = new FakeMigrationDatabase();
  database.applied = ["0002_events"];

  await assert.rejects(
    applyMigrations(database, fixtures),
    /contiguous ordered prefix/,
  );
});

test("failed migration leaves transaction state unchanged", async () => {
  const database = new FakeMigrationDatabase();
  const failingMigrations: readonly DatabaseMigration[] = [
    fixtures[0]!,
    { id: "0002_events", sql: "FAIL" },
  ];

  await assert.rejects(
    applyMigrations(database, failingMigrations),
    /migration failed/,
  );
  assert.deepEqual(database.applied, []);
  assert.deepEqual(database.executed, []);
});

test("migration runner rejects duplicate and unordered IDs", async () => {
  const database = new FakeMigrationDatabase();

  await assert.rejects(
    applyMigrations(database, [fixtures[0]!, fixtures[0]!]),
    /Duplicate migration ID/,
  );
  await assert.rejects(
    applyMigrations(database, [...fixtures].reverse()),
    /ordered by ascending ID/,
  );
});

test("query migration encodes the MVP aggregate uniqueness and privacy storage", () => {
  const queryMigration = migrations.find(
    ({ id }) => id === "0002_query_aggregates",
  );
  assert.ok(queryMigration);
  assert.match(
    queryMigration.sql,
    /CREATE TABLE \[query\]\.ParticipationSlots/,
  );
  assert.match(queryMigration.sql, /PRIMARY KEY \(playerId\)/);
  assert.match(queryMigration.sql, /UQ_QueryActions_player_site/);
  assert.match(queryMigration.sql, /evidenceText nvarchar\(4000\)/);
  assert.match(queryMigration.sql, /isTruth bit NOT NULL/);
  assert.match(queryMigration.sql, /CK_QueryVotes_choice/);
});
