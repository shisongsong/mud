export const factionIds = [
  "faction_1",
  "faction_2",
  "faction_3",
  "faction_4",
  "faction_5",
  "faction_6",
] as const;

export type BoardFactionId = (typeof factionIds)[number];

export interface BoardState {
  readonly version: number;
  readonly tension: number;
  readonly factions: Readonly<Record<BoardFactionId, number>>;
}

export interface BoardDelta {
  readonly tensionDelta: number;
  readonly factionDeltas: Readonly<Partial<Record<BoardFactionId, number>>>;
}

export interface AppliedBoardDelta {
  readonly requested: BoardDelta;
  readonly effective: BoardDelta;
  readonly before: BoardState;
  readonly after: BoardState;
}

export interface BoardLedgerEntry {
  readonly aggregateVersion: number;
  readonly effectiveDelta: BoardDelta;
}

export class InvalidBoardDeltaError extends Error {
  constructor() {
    super("Board deltas must be safe integers in the supported range");
    this.name = "InvalidBoardDeltaError";
  }
}

export class InvalidBoardLedgerError extends Error {
  constructor() {
    super("Board effect ledger is incomplete or inconsistent");
    this.name = "InvalidBoardLedgerError";
  }
}

export function createInitialBoardState(): BoardState {
  return {
    version: 1,
    tension: 50,
    factions: {
      faction_1: 50,
      faction_2: 50,
      faction_3: 50,
      faction_4: 50,
      faction_5: 50,
      faction_6: 50,
    },
  };
}

export function applyBoardDelta(
  state: BoardState,
  requested: BoardDelta,
): AppliedBoardDelta {
  if (
    requested.factionDeltas === null ||
    typeof requested.factionDeltas !== "object" ||
    Array.isArray(requested.factionDeltas) ||
    Object.keys(requested.factionDeltas).some(
      (factionId) => !factionIds.includes(factionId as BoardFactionId),
    )
  ) {
    throw new InvalidBoardDeltaError();
  }
  validateDelta(requested.tensionDelta);
  for (const delta of Object.values(requested.factionDeltas)) {
    if (delta !== undefined) validateDelta(delta);
  }
  if (
    !Number.isSafeInteger(state.version) ||
    state.version < 1 ||
    state.version >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError("Board version is invalid");
  }
  validateValue(state.tension);
  for (const factionId of factionIds) {
    validateValue(state.factions[factionId]);
  }

  const tension = applyValue(state.tension, requested.tensionDelta);
  const factions = { ...state.factions };
  const effectiveFactionDeltas: Partial<Record<BoardFactionId, number>> = {};
  for (const factionId of factionIds) {
    const delta = requested.factionDeltas[factionId] ?? 0;
    const applied = applyValue(state.factions[factionId], delta);
    factions[factionId] = applied.after;
    effectiveFactionDeltas[factionId] = applied.effective;
  }

  const after: BoardState = {
    version: state.version + 1,
    tension: tension.after,
    factions,
  };
  return {
    requested,
    effective: {
      tensionDelta: tension.effective,
      factionDeltas: effectiveFactionDeltas,
    },
    before: state,
    after,
  };
}

export function rebuildBoardState(
  entries: readonly BoardLedgerEntry[],
): BoardState {
  let state = createInitialBoardState();
  for (const entry of entries) {
    if (
      !Number.isSafeInteger(entry.aggregateVersion) ||
      entry.aggregateVersion !== state.version + 1
    ) {
      throw new InvalidBoardLedgerError();
    }
    try {
      const applied = applyBoardDelta(state, entry.effectiveDelta);
      if (!sameDelta(applied.effective, entry.effectiveDelta)) {
        throw new InvalidBoardLedgerError();
      }
      state = applied.after;
    } catch (error: unknown) {
      if (error instanceof InvalidBoardLedgerError) throw error;
      throw new InvalidBoardLedgerError();
    }
  }
  return state;
}

function sameDelta(left: BoardDelta, right: BoardDelta): boolean {
  return (
    left.tensionDelta === right.tensionDelta &&
    factionIds.every(
      (factionId) =>
        (left.factionDeltas[factionId] ?? 0) ===
        (right.factionDeltas[factionId] ?? 0),
    )
  );
}

function applyValue(
  value: number,
  requestedDelta: number,
): { readonly after: number; readonly effective: number } {
  const after = Math.max(0, Math.min(100, value + requestedDelta));
  return { after, effective: after - value };
}

function validateDelta(value: number): void {
  if (!Number.isSafeInteger(value) || value < -100 || value > 100) {
    throw new InvalidBoardDeltaError();
  }
}

function validateValue(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new TypeError("Board value is outside the supported range");
  }
}
