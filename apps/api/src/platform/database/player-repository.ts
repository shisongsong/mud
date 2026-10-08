import type { CreatePlayerRequest } from "../../contracts/http.ts";
import type { QueryExecutor } from "../transactions/unit-of-work.ts";

export interface PlayerProfile {
  readonly playerId: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly factionId: CreatePlayerRequest["factionId"];
  readonly powerId: CreatePlayerRequest["powerId"];
  readonly professionId: CreatePlayerRequest["professionId"];
  readonly gameplayReleaseId: string;
  readonly score: number;
  readonly aggregateVersion: number;
}

export class PostgresPlayerRepository {
  async createInTransaction(
    transaction: QueryExecutor,
    profile: Pick<
      PlayerProfile,
      | "playerId"
      | "accountId"
      | "displayName"
      | "factionId"
      | "powerId"
      | "professionId"
      | "gameplayReleaseId"
      | "aggregateVersion"
    >,
  ): Promise<void> {
    await transaction.query(
      `
INSERT INTO "player"."Players"
  ("playerId", "accountId", "displayName", "factionId", "powerId",
   "professionId", "gameplayReleaseId", "aggregateVersion")
VALUES
  (@playerId, @accountId, @displayName, @factionId, @powerId,
   @professionId, @gameplayReleaseId, @aggregateVersion);
`,
      { ...profile },
    );
  }

  async getDisplayNameByPlayerId(
    transaction: QueryExecutor,
    playerId: string,
  ): Promise<string | null> {
    const rows = await transaction.query<{ readonly displayName: string }>(
      `
SELECT "displayName" AS "displayName"
FROM "player"."Players"
WHERE "playerId" = @playerId;
`,
      { playerId },
    );
    return rows[0]?.displayName ?? null;
  }

  async getByAccountId(
    transaction: QueryExecutor,
    accountId: string,
  ): Promise<PlayerProfile | null> {
    const rows = await transaction.query<{
      readonly playerId: string;
      readonly accountId: string;
      readonly displayName: string;
      readonly factionId: PlayerProfile["factionId"];
      readonly powerId: PlayerProfile["powerId"];
      readonly professionId: PlayerProfile["professionId"];
      readonly gameplayReleaseId: string;
      readonly score: number | string;
      readonly aggregateVersion: number | string;
    }>(
      `
SELECT "playerId" AS "playerId", "accountId" AS "accountId",
       "displayName" AS "displayName", "factionId" AS "factionId",
       "powerId" AS "powerId", "professionId" AS "professionId",
       "gameplayReleaseId" AS "gameplayReleaseId", "score" AS "score",
       "aggregateVersion" AS "aggregateVersion"
FROM "player"."Players"
WHERE "accountId" = @accountId;
`,
      { accountId },
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      score: Number(row.score),
      aggregateVersion: Number(row.aggregateVersion),
    };
  }
}
