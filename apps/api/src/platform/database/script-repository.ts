import type { QueryCardScriptInput } from "../../modules/script/public.ts";
import type {
  QueryExecutor,
  UnitOfWork,
} from "../transactions/unit-of-work.ts";

export interface ScriptInstance {
  readonly scriptId: string;
  readonly queryId: string;
  readonly playerId: string;
  readonly cardId: string;
  readonly contentText: string;
  readonly gameplayReleaseId: string;
  readonly createdAt: Date;
}

export interface ScriptInstanceResult {
  readonly script: ScriptInstance;
  readonly created: boolean;
}

export interface KnowledgeItemRow {
  readonly scriptId: string;
  readonly content: string;
  readonly receivedAt: Date;
}

export class PostgresScriptRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async createOrGetQueryCardInTransaction(
    transaction: QueryExecutor,
    input: QueryCardScriptInput & {
      readonly scriptId: string;
      readonly createdAt: Date;
    },
  ): Promise<ScriptInstanceResult> {
    const cardRows = await transaction.query<{
      readonly evidenceText: string;
      readonly gameplayReleaseId: string;
    }>(
      `SELECT a."evidenceText" AS "evidenceText",
              r."gameplayReleaseId" AS "gameplayReleaseId"
       FROM "query"."QueryActions" a
       JOIN "query"."QueryRooms" r ON r."queryId" = a."queryId"
       WHERE a."queryId" = @queryId AND a."playerId" = @playerId
         AND a."cardId" = @cardId AND r."phase" IN ('settling', 'completed')
       FOR SHARE OF r, a`,
      {
        queryId: input.queryId,
        playerId: input.playerId,
        cardId: input.cardId,
      },
    );
    const card = cardRows[0];
    if (!card) throw new QueryCardNotReadyError();
    if (
      card.evidenceText !== input.contentText ||
      card.gameplayReleaseId !== input.gameplayReleaseId
    ) {
      throw new QueryCardContentConflictError();
    }

    const inserted = await transaction.query<ScriptInstance>(
      `INSERT INTO "script"."Scripts" (
         "scriptId", "queryId", "playerId", "cardId", "contentText",
         "gameplayReleaseId", "createdAt"
       ) VALUES (@scriptId, @queryId, @playerId, @cardId, @contentText,
                 @gameplayReleaseId, @createdAt)
      ON CONFLICT ("queryId", "playerId", "cardId") DO NOTHING
       RETURNING "scriptId" AS "scriptId", "queryId" AS "queryId",
                 "playerId" AS "playerId", "cardId" AS "cardId",
                 "contentText" AS "contentText",
                 "gameplayReleaseId" AS "gameplayReleaseId",
                 "createdAt" AS "createdAt"`,
      { ...input },
    );
    if (inserted[0]) {
      return { script: inserted[0], created: true };
    }

    const existing = await transaction.query<ScriptInstance>(
      `SELECT "scriptId", "queryId", "playerId", "cardId",
              "contentText", "gameplayReleaseId", "createdAt"
       FROM script."Scripts"
      WHERE "queryId" = @queryId AND "playerId" = @playerId AND "cardId" = @cardId`,
      {
        queryId: input.queryId,
        playerId: input.playerId,
        cardId: input.cardId,
      },
    );
    const row = existing[0];
    if (!row) throw new Error("Script instance conflict could not be resolved");
    if (
      row.contentText !== input.contentText ||
      row.gameplayReleaseId !== input.gameplayReleaseId
    ) {
      throw new ScriptInstanceConflictError();
    }
    return { script: row, created: false };
  }

  async grantKnowledgeInTransaction(
    transaction: QueryExecutor,
    input: {
      readonly grantId: string;
      readonly scriptId: string;
      readonly playerId: string;
      readonly sourceRef: string;
      readonly grantedAt: Date;
    },
  ): Promise<{ readonly grantId: string; readonly created: boolean }> {
    const inserted = await transaction.query<{ readonly grantId: string }>(
      `INSERT INTO "script"."PlayerKnowledge" (
         "grantId", "scriptId", "playerId", "sourceRef", "grantedAt"
       ) VALUES (@grantId, @scriptId, @playerId, @sourceRef, @grantedAt)
      ON CONFLICT ("scriptId", "playerId", "sourceRef") DO NOTHING
      RETURNING "grantId"`,
      {
        grantId: input.grantId,
        scriptId: input.scriptId,
        playerId: input.playerId,
        sourceRef: input.sourceRef,
        grantedAt: input.grantedAt,
      },
    );
    if (inserted[0]) return { grantId: inserted[0].grantId, created: true };

    const existing = await transaction.query<{ readonly grantId: string }>(
      `SELECT "grantId" FROM "script"."PlayerKnowledge"
       WHERE "scriptId" = @scriptId AND "playerId" = @playerId
         AND "sourceRef" = @sourceRef`,
      {
        scriptId: input.scriptId,
        playerId: input.playerId,
        sourceRef: input.sourceRef,
      },
    );
    const grant = existing[0];
    if (!grant)
      throw new Error("Knowledge grant conflict could not be resolved");
    return { grantId: grant.grantId, created: false };
  }

  async listKnowledgeForPlayerInTransaction(
    transaction: QueryExecutor,
    playerId: string,
  ): Promise<readonly KnowledgeItemRow[]> {
    const rows = await transaction.query<{
      readonly scriptId: string;
      readonly content: string;
      readonly receivedAt: Date;
    }>(
      `SELECT s."scriptId" AS "scriptId", s."contentText" AS "content",
              min(k."grantedAt") AS "receivedAt"
       FROM "script"."PlayerKnowledge" k
       JOIN "script"."Scripts" s ON s."scriptId" = k."scriptId"
       WHERE k."playerId" = @playerId
       GROUP BY s."scriptId", s."contentText"
       ORDER BY min(k."grantedAt"), s."scriptId"`,
      { playerId },
    );
    return rows;
  }

  async listKnowledgeForPlayer(
    playerId: string,
  ): Promise<readonly KnowledgeItemRow[]> {
    return this.unitOfWork.transaction((transaction) =>
      this.listKnowledgeForPlayerInTransaction(transaction, playerId),
    );
  }
}

export class ScriptInstanceConflictError extends Error {
  readonly code = "SCRIPT_INSTANCE_CONFLICT";

  constructor() {
    super("The query card already has a different Script instance");
    this.name = "ScriptInstanceConflictError";
  }
}

export class QueryCardNotReadyError extends Error {
  readonly code = "QUERY_CARD_NOT_READY";

  constructor() {
    super("The query card is unavailable or its query is not completed");
    this.name = "QueryCardNotReadyError";
  }
}

export class QueryCardContentConflictError extends Error {
  readonly code = "QUERY_CARD_CONTENT_CONFLICT";

  constructor() {
    super("Script content must match the explored query card and release");
    this.name = "QueryCardContentConflictError";
  }
}
