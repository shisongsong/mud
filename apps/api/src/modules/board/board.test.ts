import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyBoardDelta,
  createInitialBoardState,
  InvalidBoardDeltaError,
  InvalidBoardLedgerError,
  rebuildBoardState,
} from "./public.ts";

test("initial Board starts tension and every faction at 50", () => {
  const board = createInitialBoardState();
  assert.equal(board.version, 1);
  assert.equal(board.tension, 50);
  assert.deepEqual(Object.values(board.factions), [50, 50, 50, 50, 50, 50]);
});

test("Board delta clamps tension and faction strengths independently", () => {
  const initial = createInitialBoardState();
  const nearBounds = {
    ...initial,
    tension: 99,
    factions: { ...initial.factions, faction_1: 100 },
  };
  const result = applyBoardDelta(nearBounds, {
    tensionDelta: 2,
    factionDeltas: { faction_1: 1, faction_2: -2 },
  });

  assert.equal(result.after.tension, 100);
  assert.equal(result.effective.tensionDelta, 1);
  assert.equal(result.after.factions.faction_1, 100);
  assert.equal(result.effective.factionDeltas.faction_1, 0);
  assert.equal(result.after.factions.faction_2, 48);
  assert.equal(result.effective.factionDeltas.faction_2, -2);
  assert.equal(result.after.version, 2);
  assert.equal(nearBounds.factions.faction_3, 50);
});

test("Board rejects non-integer and out-of-range requested deltas", () => {
  const board = createInitialBoardState();
  assert.throws(
    () => applyBoardDelta(board, { tensionDelta: 1.5, factionDeltas: {} }),
    InvalidBoardDeltaError,
  );
  assert.throws(
    () =>
      applyBoardDelta(board, {
        tensionDelta: 0,
        factionDeltas: { faction_1: 101 },
      }),
    InvalidBoardDeltaError,
  );
  assert.throws(
    () =>
      applyBoardDelta(board, {
        tensionDelta: 0,
        factionDeltas: { faction_unknown: 1 } as never,
      }),
    InvalidBoardDeltaError,
  );
});

test("Board projection rebuild replays effective deltas in contiguous version order", () => {
  const rebuilt = rebuildBoardState([
    {
      aggregateVersion: 2,
      effectiveDelta: { tensionDelta: 2, factionDeltas: { faction_1: 1 } },
    },
    {
      aggregateVersion: 3,
      effectiveDelta: { tensionDelta: -2, factionDeltas: { faction_2: 1 } },
    },
  ]);

  assert.equal(rebuilt.version, 3);
  assert.equal(rebuilt.tension, 50);
  assert.equal(rebuilt.factions.faction_1, 51);
  assert.equal(rebuilt.factions.faction_2, 51);
});

test("Board projection rebuild rejects gaps and impossible effective deltas", () => {
  assert.throws(
    () =>
      rebuildBoardState([
        { aggregateVersion: 3, effectiveDelta: { tensionDelta: 1, factionDeltas: {} } },
      ]),
    InvalidBoardLedgerError,
  );
  assert.throws(
    () =>
      rebuildBoardState([
        { aggregateVersion: 2, effectiveDelta: { tensionDelta: 80, factionDeltas: {} } },
      ]),
    InvalidBoardLedgerError,
  );
});
