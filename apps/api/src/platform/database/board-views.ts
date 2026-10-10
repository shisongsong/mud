import { boardSnapshotResponseSchema } from "../../contracts/http.ts";
import type { BoardSnapshotResponse } from "../../contracts/http.ts";
import type { Clock } from "../../kernel/ports.ts";
import { factionIds } from "../../modules/board/public.ts";
import type { UnitOfWork } from "../transactions/unit-of-work.ts";

interface BoardStateRow {
  readonly version: number | string;
  readonly tension: number;
  readonly factionStrengths: Readonly<Record<string, number>> | string;
  readonly updatedAt: Date;
}

export class PostgresBoardViews {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  getSnapshot(): Promise<BoardSnapshotResponse> {
    const serverTime = this.clock.now();
    return this.unitOfWork.transaction(async (transaction) => {
      const rows = await transaction.query<BoardStateRow>(
        `SELECT "version", "tension", "factionStrengths", "updatedAt"
         FROM "board"."BoardStates" WHERE "boardId" = @boardId;`,
        { boardId: "world_1" },
      );
      const row = rows[0];
      if (!row) throw new Error("Board state is not initialized");
      const strengths = parseJson(row.factionStrengths);
      return boardSnapshotResponseSchema.parse({
        boardVersion: Number(row.version),
        tension: row.tension,
        factions: factionIds.map((factionId) => ({
          factionId,
          strength: strengths[factionId],
        })),
        updatedAt: row.updatedAt.toISOString(),
        serverTime: serverTime.toISOString(),
      });
    });
  }
}

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

export type BoardSnapshotReader = Pick<PostgresBoardViews, "getSnapshot">;
