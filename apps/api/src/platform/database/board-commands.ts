import { canonicalJson } from "../../kernel/idempotency.ts";
import type { Clock } from "../../kernel/ports.ts";
import {
  applyBoardDelta,
  factionIds,
  rebuildBoardState,
} from "../../modules/board/public.ts";
import type {
  BoardDelta,
  BoardLedgerEntry,
  BoardState,
} from "../../modules/board/public.ts";
import type { UnitOfWork } from "../transactions/unit-of-work.ts";

const BOARD_ID = "world_1";

interface BoardStateRow {
  readonly version: number | string;
  readonly tension: number;
  readonly factionStrengths: Readonly<Record<string, number>> | string;
}

interface BoardEffectRow {
  readonly reasonRef: string;
  readonly requestedDelta: BoardDelta | string;
  readonly resultReference: string;
}

interface BoardLedgerRow {
  readonly aggregateVersion: number | string;
  readonly effectiveDelta: BoardDelta | string;
}

export class BoardEffectConflictError extends Error {
  constructor() {
    super("Board effect key was already used with different input");
    this.name = "BoardEffectConflictError";
  }
}

export class PostgresBoardCommands {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async rebuildProjection(): Promise<BoardState> {
    const now = this.clock.now();
    if (!Number.isSafeInteger(now.getTime()) || now.getTime() < 0) {
      throw new TypeError("Clock returned an invalid timestamp");
    }

    return this.unitOfWork.transaction(async (transaction) => {
      const states = await transaction.query<BoardStateRow>(
        `SELECT "version", "tension", "factionStrengths"
         FROM "board"."BoardStates" WHERE "boardId" = @boardId FOR UPDATE;`,
        { boardId: BOARD_ID },
      );
      if (!states[0]) throw new Error("Board state is not initialized");

      const rows = await transaction.query<BoardLedgerRow>(
        `SELECT "aggregateVersion" AS "aggregateVersion",
                "effectiveDelta" AS "effectiveDelta"
         FROM "board"."BoardEffects"
         WHERE "boardId" = @boardId ORDER BY "aggregateVersion";`,
        { boardId: BOARD_ID },
      );
      const entries: BoardLedgerEntry[] = rows.map((row) => ({
        aggregateVersion: Number(row.aggregateVersion),
        effectiveDelta: parseJson(row.effectiveDelta),
      }));
      const rebuilt = rebuildBoardState(entries);
      await transaction.query(
        `UPDATE "board"."BoardStates"
         SET "version" = @version, "tension" = @tension,
             "factionStrengths" = @factionStrengths, "updatedAt" = @updatedAt
         WHERE "boardId" = @boardId;`,
        {
          boardId: BOARD_ID,
          version: rebuilt.version,
          tension: rebuilt.tension,
          factionStrengths: JSON.stringify(rebuilt.factions),
          updatedAt: now,
        },
      );
      return rebuilt;
    });
  }

  async applyDelta(
    effectId: string,
    requested: BoardDelta,
    reasonRef: string,
  ): Promise<{ readonly resultReference: string; readonly replayed: boolean }> {
    validateEffect(effectId, reasonRef);
    const now = this.clock.now();
    if (!Number.isSafeInteger(now.getTime()) || now.getTime() < 0) {
      throw new TypeError("Clock returned an invalid timestamp");
    }

    return this.unitOfWork.transaction(async (transaction) => {
      const stateRows = await transaction.query<BoardStateRow>(
        `
SELECT "version", "tension", "factionStrengths"
FROM "board"."BoardStates"
WHERE "boardId" = @boardId
FOR UPDATE;
`,
        { boardId: BOARD_ID },
      );
      const state = stateRows[0];
      if (!state) throw new Error("Board state is not initialized");

      const existingRows = await transaction.query<BoardEffectRow>(
        `
SELECT "reasonRef", "requestedDelta", 'board-effect:' || "effectId" AS "resultReference"
FROM "board"."BoardEffects"
WHERE "effectId" = @effectId;
`,
        { effectId },
      );
      const existing = existingRows[0];
      if (existing) {
        if (
          existing.reasonRef !== reasonRef ||
          canonicalJson(parseJson(existing.requestedDelta)) !==
            canonicalJson(requested)
        ) {
          throw new BoardEffectConflictError();
        }
        return { resultReference: existing.resultReference, replayed: true };
      }

      const before = mapState(state);
      const applied = applyBoardDelta(before, requested);
      const clampReasons = getClampReasons(requested, applied.effective);
      const resultReference = `board-effect:${effectId}`;
      await transaction.query(
        `
UPDATE "board"."BoardStates"
SET "version" = @version,
    "tension" = @tension,
    "factionStrengths" = @factionStrengths,
    "updatedAt" = @appliedAt
WHERE "boardId" = @boardId;
`,
        {
          boardId: BOARD_ID,
          version: applied.after.version,
          tension: applied.after.tension,
          factionStrengths: JSON.stringify(applied.after.factions),
          appliedAt: now,
        },
      );
      await transaction.query(
        `
INSERT INTO "board"."BoardEffects"
  ("effectId", "boardId", "aggregateVersion", "reasonRef", "requestedDelta",
   "effectiveDelta", "clampReasons", "appliedAt")
VALUES
  (@effectId, @boardId, @aggregateVersion, @reasonRef, @requestedDelta,
   @effectiveDelta, @clampReasons, @appliedAt);
`,
        {
          effectId,
          boardId: BOARD_ID,
          aggregateVersion: applied.after.version,
          reasonRef,
          requestedDelta: JSON.stringify(requested),
          effectiveDelta: JSON.stringify(applied.effective),
          clampReasons: JSON.stringify(clampReasons),
          appliedAt: now,
        },
      );
      return { resultReference, replayed: false };
    });
  }
}

function mapState(row: BoardStateRow): BoardState {
  const factions = parseJson(row.factionStrengths) as Record<string, number>;
  const mappedFactions = Object.fromEntries(
    factionIds.map((factionId) => [factionId, factions[factionId]]),
  ) as BoardState["factions"];
  return {
    version: Number(row.version),
    tension: Number(row.tension),
    factions: mappedFactions,
  };
}

function getClampReasons(
  requested: BoardDelta,
  effective: BoardDelta,
): Record<string, string> {
  const reasons: Record<string, string> = {};
  if (requested.tensionDelta !== effective.tensionDelta) {
    reasons["tension"] =
      requested.tensionDelta > effective.tensionDelta
        ? "upper_bound"
        : "lower_bound";
  }
  for (const factionId of factionIds) {
    const requestedDelta = requested.factionDeltas[factionId] ?? 0;
    const effectiveDelta = effective.factionDeltas[factionId] ?? 0;
    if (requestedDelta !== effectiveDelta) {
      reasons[factionId] =
        requestedDelta > effectiveDelta ? "upper_bound" : "lower_bound";
    }
  }
  return reasons;
}

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

function validateEffect(effectId: string, reasonRef: string): void {
  if (
    effectId.trim().length === 0 ||
    effectId.length < 16 ||
    effectId.length > 256 ||
    !/^[\x21-\x7e]+$/.test(effectId) ||
    reasonRef.trim().length === 0 ||
    reasonRef.length > 256
  ) {
    throw new TypeError("Invalid Board effect");
  }
}
