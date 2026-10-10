import type { CreatePlayerRequest } from "../../contracts/http.ts";
import type { QueryExecutor } from "../transactions/unit-of-work.ts";
import type { UnitOfWork } from "../transactions/unit-of-work.ts";
import type { PlayerFactionReader } from "../../kernel/ports.ts";

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

export interface PlayerScoreEffect {
  readonly effectId: string;
  readonly playerId: string;
  readonly requestedDelta: number;
  readonly effectiveDelta: number;
  readonly scoreBefore: number;
  readonly scoreAfter: number;
  readonly clamped: boolean;
  readonly reasonRef: string;
  readonly aggregateVersion: number;
}

interface PlayerScoreEffectRow extends Omit<
  PlayerScoreEffect,
  "aggregateVersion"
> {
  readonly aggregateVersion: number | string;
}

interface PlayerScoreRow {
  readonly score: number | string;
  readonly aggregateVersion: number | string;
  readonly gameplayReleaseId: string;
}

export class PlayerScoreEffectConflictError extends Error {
  readonly code = "PLAYER_SCORE_EFFECT_CONFLICT";

  constructor() {
    super("A score effect key was reused with different parameters");
    this.name = "PlayerScoreEffectConflictError";
  }
}

export class PlayerNotFoundError extends Error {
  readonly code = "PLAYER_NOT_FOUND";

  constructor() {
    super("Player profile not found");
    this.name = "PlayerNotFoundError";
  }
}

export class PostgresPlayerRepository {
  async getScoreEffectInTransaction(
    transaction: QueryExecutor,
    effectId: string,
    playerId: string,
  ): Promise<PlayerScoreEffect | null> {
    const rows = await transaction.query<PlayerScoreEffectRow>(
      `
SELECT "effectId" AS "effectId", "playerId" AS "playerId",
       "requestedDelta" AS "requestedDelta", "effectiveDelta" AS "effectiveDelta",
       "scoreBefore" AS "scoreBefore", "scoreAfter" AS "scoreAfter",
       "aggregateVersion" AS "aggregateVersion", "clamped" AS "clamped",
       "reasonRef" AS "reasonRef"
FROM "player"."ScoreEntries"
WHERE "effectId" = @effectId AND "playerId" = @playerId;
`,
      { effectId, playerId },
    );
    const effect = rows[0];
    return effect
      ? {
          ...effect,
          requestedDelta: Number(effect.requestedDelta),
          effectiveDelta: Number(effect.effectiveDelta),
          scoreBefore: Number(effect.scoreBefore),
          scoreAfter: Number(effect.scoreAfter),
          aggregateVersion: Number(effect.aggregateVersion),
        }
      : null;
  }

  async getFactionIdInTransaction(
    transaction: QueryExecutor,
    playerId: string,
  ): Promise<PlayerProfile["factionId"] | null> {
    const rows = await transaction.query<{
      readonly factionId: PlayerProfile["factionId"];
    }>(
      `SELECT "factionId" AS "factionId"
       FROM "player"."Players" WHERE "playerId" = @playerId;`,
      { playerId },
    );
    return rows[0]?.factionId ?? null;
  }

  async applyScoreEffectInTransaction(
    transaction: QueryExecutor,
    input: Omit<
      PlayerScoreEffect,
      | "effectiveDelta"
      | "scoreBefore"
      | "scoreAfter"
      | "clamped"
      | "aggregateVersion"
    > & { readonly appliedAt: number },
  ): Promise<{
    readonly effect: PlayerScoreEffect;
    readonly gameplayReleaseId: string;
    readonly replayed: boolean;
  }> {
    await transaction.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(@effectId, 0));`,
      { effectId: input.effectId },
    );
    const existingRows = await transaction.query<PlayerScoreEffectRow>(
      `
SELECT e."effectId" AS "effectId", e."playerId" AS "playerId",
       e."requestedDelta" AS "requestedDelta", e."effectiveDelta" AS "effectiveDelta",
       e."scoreBefore" AS "scoreBefore", e."scoreAfter" AS "scoreAfter",
       e."aggregateVersion" AS "aggregateVersion", e."clamped" AS "clamped",
       e."reasonRef" AS "reasonRef"
FROM "player"."ScoreEntries" e
JOIN "player"."Players" p ON p."playerId" = e."playerId"
WHERE e."effectId" = @effectId;
`,
      { effectId: input.effectId },
    );
    const existing = existingRows[0];
    if (existing) {
      if (
        existing.playerId !== input.playerId ||
        Number(existing.requestedDelta) !== input.requestedDelta ||
        existing.reasonRef !== input.reasonRef
      ) {
        throw new PlayerScoreEffectConflictError();
      }
      return {
        effect: {
          ...existing,
          aggregateVersion: Number(existing.aggregateVersion),
        },
        gameplayReleaseId: await this.getReleaseIdInTransaction(
          transaction,
          input.playerId,
        ),
        replayed: true,
      };
    }

    const playerRows = await transaction.query<PlayerScoreRow>(
      `
SELECT "score" AS "score", "aggregateVersion" AS "aggregateVersion",
       "gameplayReleaseId" AS "gameplayReleaseId"
FROM "player"."Players"
WHERE "playerId" = @playerId
FOR UPDATE;
`,
      { playerId: input.playerId },
    );
    const player = playerRows[0];
    if (!player) throw new PlayerNotFoundError();

    const scoreBefore = Number(player.score);
    const scoreAfter = Math.min(
      1_000_000_000,
      scoreBefore + input.requestedDelta,
    );
    const effectiveDelta = scoreAfter - scoreBefore;
    const updatedRows = await transaction.query<{
      readonly aggregateVersion: number | string;
    }>(
      `
UPDATE "player"."Players"
SET "score" = @scoreAfter,
    "aggregateVersion" = "aggregateVersion" + 1,
    "updatedAt" = @appliedAt
WHERE "playerId" = @playerId
RETURNING "aggregateVersion" AS "aggregateVersion";
`,
      {
        playerId: input.playerId,
        scoreAfter,
        appliedAt: new Date(input.appliedAt),
      },
    );
    const aggregateVersion = Number(updatedRows[0]?.aggregateVersion);
    if (!Number.isSafeInteger(aggregateVersion) || aggregateVersion < 1) {
      throw new Error(
        "Player score update did not return an aggregate version",
      );
    }
    const effect: PlayerScoreEffect = {
      effectId: input.effectId,
      playerId: input.playerId,
      requestedDelta: input.requestedDelta,
      effectiveDelta,
      scoreBefore,
      scoreAfter,
      clamped: effectiveDelta !== input.requestedDelta,
      reasonRef: input.reasonRef,
      aggregateVersion,
    };
    await transaction.query(
      `
INSERT INTO "player"."ScoreEntries"
  ("effectId", "playerId", "requestedDelta", "effectiveDelta", "scoreBefore",
    "scoreAfter", "aggregateVersion", "clamped", "reasonRef", "appliedAt")
VALUES
    (@effectId, @playerId, @requestedDelta, @effectiveDelta, @scoreBefore,
    @scoreAfter, @aggregateVersion, @clamped, @reasonRef, @appliedAt);
`,
      { ...effect, appliedAt: new Date(input.appliedAt) },
    );
    return {
      effect,
      gameplayReleaseId: player.gameplayReleaseId,
      replayed: false,
    };
  }

  private async getReleaseIdInTransaction(
    transaction: QueryExecutor,
    playerId: string,
  ): Promise<string> {
    const rows = await transaction.query<{
      readonly gameplayReleaseId: string;
    }>(
      `SELECT "gameplayReleaseId" AS "gameplayReleaseId"
       FROM "player"."Players" WHERE "playerId" = @playerId;`,
      { playerId },
    );
    const releaseId = rows[0]?.gameplayReleaseId;
    if (!releaseId) throw new PlayerNotFoundError();
    return releaseId;
  }

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

export class PostgresPlayerFactionReader implements PlayerFactionReader {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly repository: PostgresPlayerRepository,
  ) {}

  getFactionId(playerId: string) {
    return this.unitOfWork.transaction((transaction) =>
      this.repository.getFactionIdInTransaction(transaction, playerId),
    );
  }
}
