import assert from "node:assert/strict";
import { test } from "node:test";
import type { MigrationDatabase, MigrationSession } from "./migrator.ts";
import { applyMigrations } from "./migrator.ts";
import {
  postgresMigrations as migrations,
  type DatabaseMigration,
  trial1GameplayChecksum,
  trial1GameplaySnapshot,
  trial1GlossaryChecksum,
  trial1GlossarySnapshot,
} from "./postgres-migrations.ts";

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
    /CREATE TABLE "query"\."ParticipationSlots"/,
  );
  assert.match(queryMigration.sql, /"playerId" uuid PRIMARY KEY/);
  assert.match(
    queryMigration.sql,
    /UNIQUE \("queryId", "playerId", "siteId"\)/,
  );
  assert.match(queryMigration.sql, /"evidenceText" varchar\(4000\)/);
  assert.match(queryMigration.sql, /"isTruth" boolean NOT NULL/);
  assert.match(
    queryMigration.sql,
    /"choice" IN \('choice_1', 'choice_2', 'abstain'\)/,
  );
});

test("outbox dispatch migration adds a positive per-stream cursor", () => {
  const dispatchMigration = migrations.find(
    ({ id }) => id === "0003_outbox_dispatch_cursor",
  );
  assert.ok(dispatchMigration);
  assert.match(
    dispatchMigration.sql,
    /ADD COLUMN "nextDispatchSequence" bigint NOT NULL DEFAULT 1/,
  );
  assert.match(dispatchMigration.sql, /"nextDispatchSequence" > 0/);
});

test("identity migration stores credential hashes and revocable session digests", () => {
  const identityMigration = migrations.find(
    ({ id }) => id === "0004_identity_accounts_sessions",
  );
  assert.ok(identityMigration);
  assert.match(identityMigration.sql, /CREATE SCHEMA IF NOT EXISTS "identity"/);
  assert.match(identityMigration.sql, /"username" varchar\(32\).*UNIQUE/s);
  assert.match(identityMigration.sql, /"passwordHash" varchar\(255\) NOT NULL/);
  assert.match(identityMigration.sql, /"sessionHash" char\(64\) PRIMARY KEY/);
  assert.match(identityMigration.sql, /"csrfHash" char\(64\) NOT NULL/);
  assert.match(identityMigration.sql, /"accountId" uuid NULL/);
  assert.match(identityMigration.sql, /"revokedAt" timestamptz\(3\) NULL/);
});

test("player migration enforces one profile per account and bounded role fields", () => {
  const playerMigration = migrations.find(
    ({ id }) => id === "0005_player_profiles",
  );
  assert.ok(playerMigration);
  assert.match(playerMigration.sql, /CREATE SCHEMA IF NOT EXISTS "player"/);
  assert.match(playerMigration.sql, /"accountId" uuid NOT NULL UNIQUE/);
  assert.match(playerMigration.sql, /REFERENCES "identity"\."Accounts"/);
  assert.match(playerMigration.sql, /"score" integer NOT NULL DEFAULT 1000/);
  assert.match(
    playerMigration.sql,
    /"aggregateVersion" bigint NOT NULL DEFAULT 1/,
  );
});

test("Board migration creates a bounded projection and idempotent effect ledger", () => {
  const boardMigration = migrations.find(
    ({ id }) => id === "0013_board_ledger",
  );
  assert.ok(boardMigration);
  assert.match(boardMigration.sql, /CREATE TABLE "board"\."BoardStates"/);
  assert.match(boardMigration.sql, /"tension" BETWEEN 0 AND 100/);
  assert.match(boardMigration.sql, /CREATE TABLE "board"\."BoardEffects"/);
  assert.match(boardMigration.sql, /"effectId" varchar\(256\) PRIMARY KEY/);
  assert.match(boardMigration.sql, /"requestedDelta" jsonb NOT NULL/);
  assert.match(boardMigration.sql, /"effectiveDelta" jsonb NOT NULL/);
  assert.match(boardMigration.sql, /TR_BoardEffects_immutable/);
  assert.match(boardMigration.sql, /'world_1', 1, 50/);
  assert.match(boardMigration.sql, /ON CONFLICT \("boardId"\) DO NOTHING/);
});

test("Query settlement migration snapshots factions and backfills Board deltas", () => {
  const settlementMigration = migrations.find(
    ({ id }) => id === "0014_query_board_settlement_delta",
  );
  assert.ok(settlementMigration);
  assert.match(
    settlementMigration.sql,
    /SET "factionId" = player\."factionId"/,
  );
  assert.match(
    settlementMigration.sql,
    /Cannot backfill Query participant faction snapshots/,
  );
  assert.match(settlementMigration.sql, /ADD COLUMN "boardDeltaJson" jsonb/);
  assert.match(
    settlementMigration.sql,
    /WHEN room\."selectedChoice" IS NULL THEN 1/,
  );
  assert.match(settlementMigration.sql, /THEN -2/);
  assert.match(settlementMigration.sql, /ELSE 2/);
  assert.match(
    settlementMigration.sql,
    /jsonb_object_agg\(active\."factionId", 1\)/,
  );
});

test("bootstrap release migration seeds immutable versions without replacing pointers", () => {
  const releaseMigration = migrations.find(
    ({ id }) => id === "0006_bootstrap_releases",
  );
  assert.ok(releaseMigration);
  assert.match(
    releaseMigration.sql,
    /CREATE TABLE "control"\."ConfigReleases"/,
  );
  assert.match(releaseMigration.sql, /TR_ConfigReleases_immutable/);
  assert.match(releaseMigration.sql, /gameplay_bootstrap_v1/);
  assert.match(releaseMigration.sql, /glossary_bootstrap_v1/);
  assert.match(releaseMigration.sql, /"queryEnabled":false/);
  assert.equal((releaseMigration.sql.match(/ON CONFLICT/g) ?? []).length, 2);
});

test("trial content migration seeds a checksummed release without activating it", () => {
  const trialMigration = migrations.find(
    ({ id }) => id === "0007_trial_1_content_release",
  );
  assert.ok(trialMigration);
  assert.match(trialMigration.sql, /gameplay_trial_1_v1/);
  assert.match(trialMigration.sql, /glossary_trial_1_v1/);
  assert.match(trialMigration.sql, new RegExp(trial1GameplayChecksum));
  assert.match(trialMigration.sql, new RegExp(trial1GlossaryChecksum));
  assert.equal(trial1GameplaySnapshot.content.trial_1.variants.length, 2);
  const messageKeys = [
    ...trial1GameplaySnapshot.content.trial_1.choices.map(
      ({ messageKey }) => messageKey,
    ),
    ...trial1GameplaySnapshot.content.trial_1.variants.flatMap((variant) => [
      variant.explanationKey,
      ...variant.evidence.map(({ messageKey }) => messageKey),
    ]),
  ];
  assert.ok(
    messageKeys.every(
      (messageKey) => messageKey in trial1GlossarySnapshot.entries,
    ),
  );
  assert.match(
    trialMigration.sql,
    /ON CONFLICT \("releaseKind", "releaseId"\) DO NOTHING/,
  );
  assert.doesNotMatch(trialMigration.sql, /ActiveReleasePointers/);
});
