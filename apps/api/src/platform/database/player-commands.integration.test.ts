import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { loadEnvironment } from "../../config/env.ts";
import { IdempotencyConflictError } from "../transactions/command-receipts.ts";
import { PostgresCommandReceipts } from "../transactions/command-receipts.ts";
import { PostgresOutbox } from "../transactions/outbox.ts";
import { PostgresUnitOfWork, createPostgresPool } from "./postgres.ts";
import { PostgresPlayerCommands } from "./player-commands.ts";
import { PostgresPlayerRepository } from "./player-repository.ts";

test(
  "PostgresPlayerCommands applies idempotent score effects, clamps the cap, and records zero-point outcomes",
  { skip: process.env["RUN_DB_INTEGRATION"] !== "1" },
  async () => {
    const pool = createPostgresPool(loadEnvironment());
    const unitOfWork = new PostgresUnitOfWork(pool);
    const repository = new PostgresPlayerRepository();
    const commands = new PostgresPlayerCommands(
      repository,
      new PostgresCommandReceipts(unitOfWork),
      new PostgresOutbox(),
      {
        getActiveGameplayRelease: async () => null,
        getGameplayReleaseById: async () => null,
      },
      { next: () => randomUUID() },
      { now: () => new Date() },
    );
    const accountId = randomUUID();
    const playerId = randomUUID();
    const traceId = randomUUID();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
    const username = `score_${suffix}`;
    const effectIds = [
      `settlement-points-${randomUUID()}`,
      `settlement-points-${randomUUID()}`,
      `settlement-points-${randomUUID()}`,
    ];

    try {
      await unitOfWork.transaction(async (transaction) => {
        await transaction.query(
          `INSERT INTO "identity"."Accounts" ("accountId", "username", "passwordHash")
           VALUES (@accountId, @username, @passwordHash);`,
          { accountId, username, passwordHash: "integration-only-hash" },
        );
        await transaction.query(
          `INSERT INTO "player"."Players"
             ("playerId", "accountId", "displayName", "factionId", "powerId",
              "professionId", "gameplayReleaseId")
           VALUES (@playerId, @accountId, 'Ledger Test', 'faction_1', 'power_1',
                   'profession_1', 'gameplay_integration');`,
          { playerId, accountId },
        );
      });

      const applied = await commands.applyScoreEffect(
        effectIds[0]!,
        playerId,
        25,
        "settlement:integration:participation",
        traceId,
      );
      const replayed = await commands.applyScoreEffect(
        effectIds[0]!,
        playerId,
        25,
        "settlement:integration:participation",
        traceId,
      );
      assert.equal(applied.replayed, false);
      assert.equal(replayed.replayed, true);
      assert.deepEqual(replayed.effect, applied.effect);
      assert.equal(applied.effect.scoreBefore, 1000);
      assert.equal(applied.effect.scoreAfter, 1025);
      assert.equal(applied.effect.effectiveDelta, 25);

      await assert.rejects(
        commands.applyScoreEffect(
          effectIds[0]!,
          playerId,
          26,
          "settlement:integration:participation",
          traceId,
        ),
        IdempotencyConflictError,
      );

      await unitOfWork.transaction((transaction) =>
        transaction.query(
          `UPDATE "player"."Players" SET "score" = 999999995
           WHERE "playerId" = @playerId;`,
          { playerId },
        ),
      );
      const clamped = await commands.applyScoreEffect(
        effectIds[1]!,
        playerId,
        20,
        "settlement:integration:correct-answer",
        traceId,
      );
      assert.equal(clamped.effect.scoreAfter, 1_000_000_000);
      assert.equal(clamped.effect.effectiveDelta, 5);
      assert.equal(clamped.effect.clamped, true);

      const zero = await commands.applyScoreEffect(
        effectIds[2]!,
        playerId,
        0,
        "settlement:integration:no-reward",
        traceId,
      );
      assert.equal(zero.effect.effectiveDelta, 0);
      assert.equal(zero.effect.scoreAfter, 1_000_000_000);

      const rows = await pool.query<{
        score: number;
        aggregateVersion: number | string;
      }>(
        `SELECT "score" AS "score", "aggregateVersion" AS "aggregateVersion"
         FROM "player"."Players" WHERE "playerId" = $1;`,
        [playerId],
      );
      const ledger = await pool.query(
        `SELECT "effectId" FROM "player"."ScoreEntries" WHERE "playerId" = $1;`,
        [playerId],
      );
      const events = await pool.query(
        `SELECT "eventType" FROM "platform"."OutboxEvents"
         WHERE "streamId" = $1 AND "eventType" = 'ScoreChanged';`,
        [playerId],
      );
      assert.equal(rows.rows[0]?.score, 1_000_000_000);
      assert.equal(Number(rows.rows[0]?.aggregateVersion), 4);
      assert.equal(ledger.rowCount, 3);
      assert.equal(events.rowCount, 3);
    } finally {
      try {
        await unitOfWork.transaction(async (transaction) => {
          await transaction.query(
            `DELETE FROM "platform"."EventDeliveries" WHERE "streamId" = @playerId;`,
            { playerId },
          );
          await transaction.query(
            `DELETE FROM "platform"."OutboxEvents" WHERE "streamId" = @playerId;`,
            { playerId },
          );
          await transaction.query(
            `DELETE FROM "platform"."OutboxStreams" WHERE "streamId" = @playerId;`,
            { playerId },
          );
          for (const effectId of effectIds) {
            await transaction.query(
              `DELETE FROM "platform"."CommandReceipts"
               WHERE "actorScope" = 'service:worker:score'
                 AND "operation" = 'player.score.apply'
                 AND "idempotencyKey" = @effectId;`,
              { effectId },
            );
          }
          await transaction.query(
            `DELETE FROM "identity"."Accounts" WHERE "accountId" = @accountId;`,
            { accountId },
          );
        });
      } finally {
        await pool.end();
      }
    }
  },
);
