import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  QueryExecutor,
  SqlParameters,
  UnitOfWork,
} from "../transactions/unit-of-work.ts";
import {
  BoardEffectConflictError,
  PostgresBoardCommands,
} from "./board-commands.ts";

class MemoryBoardDatabase implements UnitOfWork {
  state: SqlParameters = {
    version: 1,
    tension: 50,
    factionStrengths: JSON.stringify({
      faction_1: 50,
      faction_2: 50,
      faction_3: 50,
      faction_4: 50,
      faction_5: 50,
      faction_6: 50,
    }),
  };
  readonly effects = new Map<string, SqlParameters>();

  async transaction<T>(
    work: (executor: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    const state = { ...this.state };
    const effects = new Map(this.effects);
    const executor: QueryExecutor = {
      query: async <Row extends object>(
        statement: string,
        parameters: SqlParameters = {},
      ): Promise<readonly Row[]> => {
        if (statement.includes('FROM "board"."BoardStates"')) {
          return [state] as unknown as readonly Row[];
        }
        if (statement.includes('FROM "board"."BoardEffects"')) {
          if (statement.includes('ORDER BY "aggregateVersion"')) {
            return [...effects.values()].map((effect) => ({
              aggregateVersion: effect["aggregateVersion"],
              effectiveDelta: effect["effectiveDelta"],
            })) as unknown as readonly Row[];
          }
          const effect = effects.get(String(parameters["effectId"]));
          if (!effect) return [];
          return [
            {
              reasonRef: effect["reasonRef"],
              requestedDelta: effect["requestedDelta"],
              resultReference: `board-effect:${parameters["effectId"]}`,
            },
          ] as unknown as readonly Row[];
        }
        if (statement.includes('UPDATE "board"."BoardStates"')) {
          Object.assign(state, parameters);
          return [];
        }
        if (statement.includes('INSERT INTO "board"."BoardEffects"')) {
          effects.set(String(parameters["effectId"]), parameters);
          return [];
        }
        throw new Error(`Unexpected Board SQL: ${statement}`);
      },
    };
    const result = await work(executor);
    this.state = state;
    this.effects.clear();
    for (const [effectId, effect] of effects)
      this.effects.set(effectId, effect);
    return result;
  }
}

const clock = { now: () => new Date("2026-10-01T12:00:00.000Z") };
const effectId = "query-12345678-board";

test("Board command persists requested/effective deltas and replays idempotently", async () => {
  const database = new MemoryBoardDatabase();
  database.state = {
    ...database.state,
    tension: 99,
    factionStrengths: JSON.stringify({
      faction_1: 100,
      faction_2: 50,
      faction_3: 50,
      faction_4: 50,
      faction_5: 50,
      faction_6: 50,
    }),
  };
  const commands = new PostgresBoardCommands(database, clock);
  const delta = { tensionDelta: 2, factionDeltas: { faction_1: 1 } } as const;

  const first = await commands.applyDelta(effectId, delta, "query:trial-1");
  assert.equal(first.replayed, false);
  assert.equal(first.resultReference, `board-effect:${effectId}`);
  assert.equal(database.state["tension"], 100);
  assert.equal(database.state["version"], 2);
  const ledger = database.effects.get(effectId)!;
  assert.deepEqual(JSON.parse(String(ledger["requestedDelta"])), delta);
  assert.deepEqual(JSON.parse(String(ledger["effectiveDelta"])), {
    tensionDelta: 1,
    factionDeltas: {
      faction_1: 0,
      faction_2: 0,
      faction_3: 0,
      faction_4: 0,
      faction_5: 0,
      faction_6: 0,
    },
  });
  assert.deepEqual(JSON.parse(String(ledger["clampReasons"])), {
    tension: "upper_bound",
    faction_1: "upper_bound",
  });

  const replay = await commands.applyDelta(effectId, delta, "query:trial-1");
  assert.equal(replay.replayed, true);
  assert.equal(database.state["tension"], 100);
  assert.equal(database.state["version"], 2);
  assert.equal(database.effects.size, 1);
});

test("Board effect key cannot be reused for a different delta", async () => {
  const database = new MemoryBoardDatabase();
  const commands = new PostgresBoardCommands(database, clock);
  await commands.applyDelta(
    effectId,
    { tensionDelta: -2, factionDeltas: {} },
    "query:trial-1",
  );

  await assert.rejects(
    commands.applyDelta(
      effectId,
      { tensionDelta: 2, factionDeltas: {} },
      "query:trial-1",
    ),
    BoardEffectConflictError,
  );
  assert.equal(database.state["tension"], 48);
  assert.equal(database.state["version"], 2);
});

test("Board projection rebuild repairs persisted state from its effect ledger", async () => {
  const database = new MemoryBoardDatabase();
  const commands = new PostgresBoardCommands(database, clock);
  await commands.applyDelta(
    "query-12345678-board-first",
    { tensionDelta: -2, factionDeltas: { faction_1: 1 } },
    "query:first",
  );
  await commands.applyDelta(
    "query-12345678-board-second",
    { tensionDelta: 2, factionDeltas: { faction_2: -1 } },
    "query:second",
  );
  database.state = {
    ...database.state,
    version: 88,
    tension: 0,
    factionStrengths: JSON.stringify({
      faction_1: 0,
      faction_2: 0,
      faction_3: 0,
      faction_4: 0,
      faction_5: 0,
      faction_6: 0,
    }),
  };

  const rebuilt = await commands.rebuildProjection();

  assert.deepEqual(rebuilt, {
    version: 3,
    tension: 50,
    factions: {
      faction_1: 51,
      faction_2: 49,
      faction_3: 50,
      faction_4: 50,
      faction_5: 50,
      faction_6: 50,
    },
  });
  assert.equal(database.state["version"], 3);
  assert.equal(database.state["tension"], 50);
});
