import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryExecutor, UnitOfWork } from "../transactions/unit-of-work.ts";
import { PostgresBoardViews } from "./board-views.ts";

const now = new Date("2026-10-10T10:00:01.000Z");
const dbRow = {
  version: "8",
  tension: 63,
  factionStrengths: JSON.stringify({
    faction_1: 41,
    faction_2: 52,
    faction_3: 63,
    faction_4: 74,
    faction_5: 85,
    faction_6: 96,
  }),
  updatedAt: new Date("2026-10-10T09:59:00.000Z"),
};

class SnapshotDatabase implements UnitOfWork {
  statement = "";
  parameters: Readonly<Record<string, unknown>> = {};

  transaction<T>(work: (executor: QueryExecutor) => Promise<T>): Promise<T> {
    return work({
      query: async <Row extends object>(statement: string, parameters = {}) => {
        this.statement = statement;
        this.parameters = parameters;
        return [dbRow] as unknown as readonly Row[];
      },
    });
  }
}

test("Postgres Board view returns a contract-validated world snapshot", async () => {
  const database = new SnapshotDatabase();
  const views = new PostgresBoardViews(database, { now: () => now });

  const snapshot = await views.getSnapshot();

  assert.equal(database.parameters["boardId"], "world_1");
  assert.match(database.statement, /FROM "board"\."BoardStates"/);
  assert.deepEqual(snapshot, {
    boardVersion: 8,
    tension: 63,
    factions: [41, 52, 63, 74, 85, 96].map((strength, index) => ({
      factionId: `faction_${index + 1}`,
      strength,
    })),
    updatedAt: "2026-10-10T09:59:00.000Z",
    serverTime: now.toISOString(),
  });
});

test("Postgres Board view rejects an uninitialized world projection", async () => {
  const database: UnitOfWork = {
    transaction: (work) =>
      work({ query: async () => [] }),
  };
  const views = new PostgresBoardViews(database, { now: () => now });

  await assert.rejects(views.getSnapshot(), /Board state is not initialized/);
});
