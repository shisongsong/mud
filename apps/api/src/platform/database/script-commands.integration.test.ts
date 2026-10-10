import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { loadEnvironment } from "../../config/env.ts";
import { PostgresCommandReceipts } from "../transactions/command-receipts.ts";
import { PostgresOutbox } from "../transactions/outbox.ts";
import { PostgresUnitOfWork, createPostgresPool } from "./postgres.ts";
import { PostgresScriptCommands } from "./script-commands.ts";
import { PostgresScriptRepository } from "./script-repository.ts";

const scriptEffectId = () => `script-effect-${randomUUID()}`;
const grantEffectId = () => `knowledge-effect-${randomUUID()}`;

test(
  "PostgresScriptCommands creates settled query cards once and grants owner-only Knowledge with provenance",
  { skip: process.env["RUN_DB_INTEGRATION"] !== "1" },
  async () => {
    const pool = createPostgresPool(loadEnvironment());
    const unitOfWork = new PostgresUnitOfWork(pool);
    const commands = new PostgresScriptCommands(
      new PostgresScriptRepository(unitOfWork),
      new PostgresCommandReceipts(unitOfWork),
      new PostgresOutbox(),
      { next: () => randomUUID() },
      { now: () => new Date() },
    );
    const accountIds = [randomUUID(), randomUUID()];
    const playerIds = [randomUUID(), randomUUID()];
    const queryId = randomUUID();
    const cardId = randomUUID();
    const traceId = randomUUID();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
    const usernames = [`script_${suffix}`, `knowledge_${suffix}`];
    const createEffectIds = [
      scriptEffectId(),
      scriptEffectId(),
      scriptEffectId(),
    ];
    const grantEffectIds = [
      grantEffectId(),
      grantEffectId(),
      grantEffectId(),
      grantEffectId(),
    ];
    const contentText = "The explored private card becomes a Script.";
    const now = new Date();

    try {
      await unitOfWork.transaction(async (transaction) => {
        for (let index = 0; index < accountIds.length; index += 1) {
          await transaction.query(
            `INSERT INTO "identity"."Accounts"
               ("accountId", "username", "passwordHash")
             VALUES (@accountId, @username, 'integration-only-hash');`,
            {
              accountId: accountIds[index]!,
              username: usernames[index]!,
            },
          );
          await transaction.query(
            `INSERT INTO "player"."Players"
               ("playerId", "accountId", "displayName", "factionId", "powerId",
                "professionId", "gameplayReleaseId")
             VALUES (@playerId, @accountId, 'Script Test', 'faction_1', 'power_1',
                     'profession_1', 'gameplay_integration');`,
            { playerId: playerIds[index]!, accountId: accountIds[index]! },
          );
        }
        await transaction.query(
          `INSERT INTO "query"."QueryRooms"
             ("queryId", "createdByPlayerId", "gameplayReleaseId", "phase",
              "aggregateVersion", "createdAt", "deadline", "explorationStartedAt",
              "scenarioVariantId", "randomSeed", "correctChoice", "selectedChoice")
           VALUES (@queryId, @playerId, 'gameplay_integration', 'exploring', 2,
                   @now, @now, @now, 'variant_1', @randomSeed, 'choice_1', NULL);`,
          {
            queryId,
            playerId: playerIds[0]!,
            now,
            randomSeed: new Uint8Array([1, 2, 3]),
          },
        );
        await transaction.query(
          `INSERT INTO "query"."QueryParticipants"
             ("queryId", "playerId", "joinedAt", "factionId")
           VALUES (@queryId, @playerId, @now, 'faction_1');`,
          { queryId, playerId: playerIds[0]!, now },
        );
        await transaction.query(
          `INSERT INTO "query"."QueryActions"
             ("queryId", "playerId", "actionOrdinal", "siteId", "cardId",
              "evidenceText", "isTruth", "acceptedAt")
           VALUES (@queryId, @playerId, 1, 'site_1', @cardId, @contentText, false, @now);`,
          { queryId, playerId: playerIds[0]!, cardId, contentText, now },
        );
      });

      const cardInput = {
        queryId,
        playerId: playerIds[0]!,
        cardId,
        contentText,
        gameplayReleaseId: "gameplay_integration",
      };
      await assert.rejects(
        commands.createQueryCardScript(createEffectIds[0]!, cardInput, traceId),
        (error: unknown) =>
          error instanceof Error && error.name === "QueryCardNotReadyError",
      );
      await unitOfWork.transaction((transaction) =>
        transaction.query(
          `UPDATE "query"."QueryRooms" SET "phase" = 'settling'
           WHERE "queryId" = @queryId;`,
          { queryId },
        ),
      );

      const created = await commands.createQueryCardScript(
        createEffectIds[0]!,
        cardInput,
        traceId,
      );
      const replayed = await commands.createQueryCardScript(
        createEffectIds[0]!,
        cardInput,
        traceId,
      );
      const reused = await commands.createQueryCardScript(
        createEffectIds[1]!,
        cardInput,
        traceId,
      );
      assert.equal(created.created, true);
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.scriptId, created.scriptId);
      assert.equal(reused.created, false);
      assert.equal(reused.scriptId, created.scriptId);
      await assert.rejects(
        commands.createQueryCardScript(
          createEffectIds[2]!,
          { ...cardInput, contentText: "Caller supplied different evidence." },
          traceId,
        ),
        (error: unknown) =>
          error instanceof Error &&
          error.name === "QueryCardContentConflictError",
      );

      const firstGrant = await commands.grantKnowledgeEffect(
        grantEffectIds[0]!,
        created.scriptId,
        playerIds[0]!,
        `query:${queryId}:card:${cardId}`,
        traceId,
      );
      const duplicateReplay = await commands.grantKnowledgeEffect(
        grantEffectIds[0]!,
        created.scriptId,
        playerIds[0]!,
        `query:${queryId}:card:${cardId}`,
        traceId,
      );
      const duplicateSource = await commands.grantKnowledgeEffect(
        grantEffectIds[1]!,
        created.scriptId,
        playerIds[0]!,
        `query:${queryId}:card:${cardId}`,
        traceId,
      );
      const secondSource = await commands.grantKnowledgeEffect(
        grantEffectIds[2]!,
        created.scriptId,
        playerIds[0]!,
        "admin:verified-copy",
        traceId,
      );
      assert.equal(firstGrant.created, true);
      assert.equal(duplicateReplay.replayed, true);
      assert.equal(duplicateSource.created, false);
      assert.equal(duplicateSource.grantId, firstGrant.grantId);
      assert.equal(secondSource.created, true);

      const ownerKnowledge = await commands.listOwnedKnowledge({
        kind: "player",
        accountId: accountIds[0]!,
        playerId: playerIds[0]!,
      });
      const otherKnowledge = await commands.listOwnedKnowledge({
        kind: "player",
        accountId: accountIds[1]!,
        playerId: playerIds[1]!,
      });
      assert.equal(ownerKnowledge.length, 1);
      assert.deepEqual(ownerKnowledge[0], {
        scriptId: created.scriptId,
        content: contentText,
        receivedAt: ownerKnowledge[0]!.receivedAt,
      });
      assert.equal(otherKnowledge.length, 0);

      const grantRows = await pool.query(
        `SELECT "sourceRef" FROM "script"."PlayerKnowledge"
         WHERE "scriptId" = $1 AND "playerId" = $2 ORDER BY "sourceRef";`,
        [created.scriptId, playerIds[0]],
      );
      assert.deepEqual(
        grantRows.rows.map((row: { sourceRef: string }) => row.sourceRef),
        ["admin:verified-copy", `query:${queryId}:card:${cardId}`],
      );
      const events = await pool.query(
        `SELECT "eventType" FROM "platform"."OutboxEvents"
         WHERE "streamId" IN ($1, $2) ORDER BY "eventType";`,
        [created.scriptId, playerIds[0]],
      );
      assert.deepEqual(
        events.rows.map((row: { eventType: string }) => row.eventType),
        ["KnowledgeGranted", "KnowledgeGranted", "ScriptCreated"],
      );
    } finally {
      try {
        await unitOfWork.transaction(async (transaction) => {
          await transaction.query(
            `DELETE FROM "platform"."EventDeliveries"
             WHERE "streamId" = @playerId
                OR "streamId" IN (
                  SELECT "scriptId" FROM "script"."Scripts" WHERE "cardId" = @cardId
                );`,
            { cardId, playerId: playerIds[0]! },
          );
          await transaction.query(
            `DELETE FROM "platform"."OutboxEvents"
             WHERE "streamId" = @playerId
                OR "streamId" IN (
                  SELECT "scriptId" FROM "script"."Scripts" WHERE "cardId" = @cardId
                );`,
            { cardId, playerId: playerIds[0]! },
          );
          await transaction.query(
            `DELETE FROM "platform"."OutboxStreams"
             WHERE "streamId" = @playerId
                OR "streamId" IN (
                  SELECT "scriptId" FROM "script"."Scripts" WHERE "cardId" = @cardId
                );`,
            { cardId, playerId: playerIds[0]! },
          );
          for (const effectId of createEffectIds) {
            await transaction.query(
              `DELETE FROM "platform"."CommandReceipts"
               WHERE "actorScope" = 'service:worker:script'
                 AND "operation" = 'script.query-card.create'
                 AND "idempotencyKey" = @effectId;`,
              { effectId },
            );
          }
          for (const effectId of grantEffectIds) {
            await transaction.query(
              `DELETE FROM "platform"."CommandReceipts"
               WHERE "actorScope" = 'service:worker:knowledge'
                 AND "operation" = 'script.knowledge.grant'
                 AND "idempotencyKey" = @effectId;`,
              { effectId },
            );
          }
          await transaction.query(
            `DELETE FROM "query"."QueryActions" WHERE "queryId" = @queryId;`,
            { queryId },
          );
          await transaction.query(
            `DELETE FROM "query"."QueryParticipants" WHERE "queryId" = @queryId;`,
            { queryId },
          );
          await transaction.query(
            `DELETE FROM "query"."QueryRooms" WHERE "queryId" = @queryId;`,
            { queryId },
          );
          for (const accountId of accountIds) {
            await transaction.query(
              `DELETE FROM "identity"."Accounts" WHERE "accountId" = @accountId;`,
              { accountId },
            );
          }
        });
      } finally {
        await pool.end();
      }
    }
  },
);
