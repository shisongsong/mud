import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { loadEnvironment } from "../../config/env.ts";
import type { PlayerActor } from "../../kernel/actor.ts";
import { QueryRuleError } from "../../modules/query/public.ts";
import type { ActiveGameplayRelease } from "./gameplay-release-repository.ts";
import { PostgresCommandReceipts } from "../transactions/command-receipts.ts";
import { PostgresOutbox } from "../transactions/outbox.ts";
import { PostgresPlayerCommands } from "./player-commands.ts";
import {
  PostgresPlayerFactionReader,
  PostgresPlayerRepository,
} from "./player-repository.ts";
import { PostgresUnitOfWork, createPostgresPool } from "./postgres.ts";
import { PostgresQueryCommands } from "./query-commands.ts";
import { PostgresQueryRepository } from "./query-repository.ts";
import { QuerySettlementCoordinator } from "./query-settlement.ts";
import { PostgresScriptCommands } from "./script-commands.ts";
import { PostgresScriptRepository } from "./script-repository.ts";

const release: ActiveGameplayRelease = {
  releaseId: "gameplay_integration",
  queryEnabled: true,
  templates: ["trial_1"],
  trial1: {
    choices: [
      {
        choiceId: "choice_1",
        messageKey: "trial.choice.mark",
        args: { mark: "K1" },
      },
      {
        choiceId: "choice_2",
        messageKey: "trial.choice.mark",
        args: { mark: "K2" },
      },
    ],
    variants: [
      {
        variantId: "variant_1",
        correctChoiceId: "choice_1",
        explanationKey: "trial.explanation.current_mark",
        evidence: [
          {
            siteId: "site_1",
            messageKey: "trial.evidence.current_mark",
            args: { mark: "K1" },
            isTruth: true,
          },
          {
            siteId: "site_2",
            messageKey: "trial.evidence.same_mark_rule",
            args: {},
            isTruth: true,
          },
          {
            siteId: "site_3",
            messageKey: "trial.evidence.unsigned_rumor",
            args: { mark: "K2" },
            isTruth: false,
          },
        ],
      },
      {
        variantId: "variant_2",
        correctChoiceId: "choice_2",
        explanationKey: "trial.explanation.current_mark",
        evidence: [
          {
            siteId: "site_1",
            messageKey: "trial.evidence.current_mark",
            args: { mark: "K2" },
            isTruth: true,
          },
          {
            siteId: "site_2",
            messageKey: "trial.evidence.same_mark_rule",
            args: {},
            isTruth: true,
          },
          {
            siteId: "site_3",
            messageKey: "trial.evidence.unsigned_rumor",
            args: { mark: "K1" },
            isTruth: false,
          },
        ],
      },
    ],
  },
};

async function cleanupRoom(
  unitOfWork: PostgresUnitOfWork,
  queryId: string,
  actors: readonly PlayerActor[],
): Promise<void> {
  const scopes = actors.map(
    (actor) => `player:${actor.accountId}:${actor.playerId}`,
  );
  await unitOfWork.transaction(async (transaction) => {
    const scripts = await transaction.query<{ scriptId: string }>(
      `SELECT "scriptId" FROM "script"."Scripts" WHERE "queryId" = @queryId;`,
      { queryId },
    );
    const streamIds = [
      queryId,
      ...actors.map(({ playerId }) => playerId),
      ...scripts.map(({ scriptId }) => scriptId),
    ];
    const streamParameters = Object.fromEntries(
      streamIds.map((streamId, index) => [`streamId${index}`, streamId]),
    );
    const streamPlaceholders = streamIds
      .map((_, index) => `@streamId${index}`)
      .join(", ");
    await transaction.query(
      `DELETE FROM "platform"."EventDeliveries"
       WHERE "eventId" IN (
         SELECT "eventId" FROM "platform"."OutboxEvents"
         WHERE "streamId" IN (${streamPlaceholders})
       );`,
      streamParameters,
    );
    await transaction.query(
      `DELETE FROM "platform"."OutboxEvents"
       WHERE "streamId" IN (${streamPlaceholders});`,
      streamParameters,
    );
    await transaction.query(
      `DELETE FROM "platform"."OutboxStreams"
       WHERE "streamId" IN (${streamPlaceholders});`,
      streamParameters,
    );
    for (const statement of [
      `DELETE FROM "query"."QueryActions" WHERE "queryId" = @queryId;`,
      `DELETE FROM "query"."QueryVotes" WHERE "queryId" = @queryId;`,
      `DELETE FROM "query"."ParticipationSlots" WHERE "queryId" = @queryId;`,
      `DELETE FROM "query"."JoinReservations" WHERE "queryId" = @queryId;`,
      `DELETE FROM "query"."SettlementPointAwards" WHERE "queryId" = @queryId;`,
      `DELETE FROM "query"."QueryParticipants" WHERE "queryId" = @queryId;`,
      `DELETE FROM "query"."SettlementConfirmations" WHERE "queryId" = @queryId;`,
      `DELETE FROM "query"."SettlementTargets" WHERE "queryId" = @queryId;`,
      `DELETE FROM "query"."SettlementPlans" WHERE "queryId" = @queryId;`,
      `DELETE FROM "query"."QueryRooms" WHERE "queryId" = @queryId;`,
    ]) {
      await transaction.query(statement, { queryId });
    }
    for (const actorScope of scopes) {
      await transaction.query(
        `DELETE FROM "platform"."CommandReceipts" WHERE "actorScope" = @actorScope;`,
        { actorScope },
      );
    }
    const serviceReceiptPrefixes: readonly [string, string][] = [
      ["service:worker:score", `points:${queryId}:`],
      ["service:worker:script", `script-create:${queryId}:`],
      ["service:worker:knowledge", `knowledge:${queryId}:`],
    ];
    for (const [actorScope, prefix] of serviceReceiptPrefixes) {
      await transaction.query(
        `DELETE FROM "platform"."CommandReceipts"
         WHERE "actorScope" = @actorScope AND "idempotencyKey" LIKE @keyPrefix;`,
        { actorScope, keyPrefix: `${prefix}%` },
      );
    }
  });
}

async function cleanupPlayers(
  unitOfWork: PostgresUnitOfWork,
  actors: readonly PlayerActor[],
): Promise<void> {
  await unitOfWork.transaction(async (transaction) => {
    const playerParameters = Object.fromEntries(
      actors.map(({ playerId }, index) => [`playerId${index}`, playerId]),
    );
    const accountParameters = Object.fromEntries(
      actors.map(({ accountId }, index) => [`accountId${index}`, accountId]),
    );
    const playerPlaceholders = actors
      .map((_, index) => `@playerId${index}`)
      .join(", ");
    const accountPlaceholders = actors
      .map((_, index) => `@accountId${index}`)
      .join(", ");
    await transaction.query(
      `DELETE FROM "player"."Players" WHERE "playerId" IN (${playerPlaceholders});`,
      playerParameters,
    );
    await transaction.query(
      `DELETE FROM "identity"."Accounts" WHERE "accountId" IN (${accountPlaceholders});`,
      accountParameters,
    );
  });
}

test(
  "PostgresQueryCommands joins four players into exploration and records one private inspection",
  { skip: process.env["RUN_DB_INTEGRATION"] !== "1" },
  async () => {
    const pool = createPostgresPool(loadEnvironment());
    const unitOfWork = new PostgresUnitOfWork(pool);
    const commands = new PostgresQueryCommands(
      new PostgresQueryRepository(unitOfWork),
      new PostgresCommandReceipts(unitOfWork),
      {
        getActiveGameplayRelease: async () => release,
        getGameplayReleaseById: async () => release,
      },
      { next: () => randomUUID() },
      { now: () => new Date() },
      undefined,
      { getFactionId: async () => "faction_1" },
    );
    const actors: PlayerActor[] = Array.from({ length: 4 }, () => ({
      kind: "player",
      accountId: randomUUID(),
      playerId: randomUUID(),
    }));
    const key = (label: string) => `integration-${label}-${randomUUID()}`;
    let queryId: string | undefined;

    try {
      const created = await commands.create(
        actors[0]!,
        { templateId: "trial_1", gameplayReleaseId: release.releaseId },
        key("create"),
      );
      const roomId = created.result.queryId;
      queryId = roomId;

      let lastJoin: Awaited<ReturnType<PostgresQueryCommands["join"]>> | null =
        null;
      for (const actor of actors.slice(1)) {
        lastJoin = await commands.join(actor, queryId, key("join"));
      }
      assert.equal(lastJoin?.result.phase, "exploring");

      const room = await unitOfWork.transaction((transaction) =>
        transaction.query<{ phase: string; scenarioVariantId: string }>(
          `SELECT "phase" AS "phase", "scenarioVariantId" AS "scenarioVariantId"
           FROM "query"."QueryRooms" WHERE "queryId" = @queryId;`,
          { queryId: roomId },
        ),
      );
      assert.equal(room[0]?.phase, "exploring");
      assert.ok(
        ["variant_1", "variant_2"].includes(room[0]!.scenarioVariantId),
      );

      const inspectKey = key("inspect");
      const inspection = {
        actionType: "inspect" as const,
        siteId: "site_1" as const,
      };
      const first = await commands.inspect(
        actors[0]!,
        queryId,
        inspection,
        inspectKey,
      );
      const replay = await commands.inspect(
        actors[0]!,
        queryId,
        inspection,
        inspectKey,
      );
      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, first.result);

      await assert.rejects(
        commands.inspect(actors[0]!, queryId, inspection, key("inspect-again")),
        (error: unknown) =>
          error instanceof QueryRuleError &&
          error.code === "SITE_ALREADY_INSPECTED",
      );

      const actions = await unitOfWork.transaction((transaction) =>
        transaction.query<{ siteId: string; isTruth: boolean }>(
          `SELECT "siteId" AS "siteId", "isTruth" AS "isTruth"
           FROM "query"."QueryActions"
           WHERE "queryId" = @queryId AND "playerId" = @playerId;`,
          { queryId: roomId, playerId: actors[0]!.playerId },
        ),
      );
      assert.equal(actions.length, 1);
      assert.equal(actions[0]?.siteId, "site_1");
      assert.equal(actions[0]?.isTruth, true);

      const joinEvents = await unitOfWork.transaction((transaction) =>
        transaction.query<{ count: string }>(
          `SELECT COUNT(*)::text AS "count" FROM "platform"."OutboxEvents"
           WHERE "streamId" = @queryId AND "eventType" = 'QueryParticipantJoined';`,
          { queryId: roomId },
        ),
      );
      assert.equal(Number(joinEvents[0]?.count), 3);
    } finally {
      try {
        if (queryId !== undefined) {
          await cleanupRoom(unitOfWork, queryId, actors);
        }
      } finally {
        await pool.end();
      }
    }
  },
);

test(
  "PostgresQueryCommands finalizes settlement only after every planned effect is confirmed",
  { skip: process.env["RUN_DB_INTEGRATION"] !== "1" },
  async () => {
    const pool = createPostgresPool(loadEnvironment());
    const unitOfWork = new PostgresUnitOfWork(pool);
    const repository = new PostgresQueryRepository(unitOfWork);
    const start = Math.floor(Date.now() / 1000) * 1000;
    let current = start;
    const players = new PostgresPlayerRepository();
    const receipts = new PostgresCommandReceipts(unitOfWork);
    const ids = { next: () => randomUUID() };
    const clock = { now: () => new Date(current) };
    const gameplayReleases = {
      getActiveGameplayRelease: async () => release,
      getGameplayReleaseById: async () => release,
    };
    const factions = [
      "faction_1",
      "faction_2",
      "faction_3",
      "faction_4",
    ] as const;
    const commands = new PostgresQueryCommands(
      repository,
      receipts,
      gameplayReleases,
      ids,
      clock,
      undefined,
      new PostgresPlayerFactionReader(unitOfWork, players),
    );
    const actors: PlayerActor[] = Array.from({ length: 4 }, () => ({
      kind: "player",
      accountId: randomUUID(),
      playerId: randomUUID(),
    }));
    const key = (label: string) => `integration-${label}-${randomUUID()}`;
    let queryId: string | undefined;

    try {
      await unitOfWork.transaction(async (transaction) => {
        for (const [index, actor] of actors.entries()) {
          const suffix = actor.accountId.replaceAll("-", "").slice(0, 26);
          await transaction.query(
            `INSERT INTO "identity"."Accounts"
               ("accountId", "username", "passwordHash")
             VALUES (@accountId, @username, 'integration-only-hash');`,
            { accountId: actor.accountId, username: `saga_${suffix}` },
          );
          await transaction.query(
            `INSERT INTO "player"."Players"
               ("playerId", "accountId", "displayName", "factionId", "powerId",
                "professionId", "gameplayReleaseId")
             VALUES (@playerId, @accountId, @displayName, @factionId, 'power_1',
                     'profession_1', @gameplayReleaseId);`,
            {
              playerId: actor.playerId,
              accountId: actor.accountId,
              displayName: `Saga Player ${index + 1}`,
              factionId: factions[index]!,
              gameplayReleaseId: release.releaseId,
            },
          );
        }
      });
      const created = await commands.create(
        actors[0]!,
        { templateId: "trial_1", gameplayReleaseId: release.releaseId },
        key("create"),
      );
      const roomId = created.result.queryId;
      queryId = roomId;
      for (const actor of actors.slice(1)) {
        await commands.join(actor, roomId, key("join"));
      }

      current = start + 10_000;
      await commands.inspect(
        actors[0]!,
        roomId,
        { actionType: "inspect", siteId: "site_1" },
        key("inspect"),
      );

      current = start + 121_000;
      assert.ok((await commands.advanceDueQueries()) >= 1);

      current = start + 130_000;
      for (const actor of actors.slice(0, 2)) {
        const room = await repository.get(roomId);
        assert.ok(room);
        await commands.vote(
          actor,
          roomId,
          { choiceId: "choice_1", expectedVersion: room.version },
          key("vote"),
        );
      }

      current = start + 181_000;
      assert.ok((await commands.advanceDueQueries()) >= 1);
      const settling = await repository.get(roomId);
      assert.equal(settling?.phase, "settling");
      const targets = settling?.settlementPlan?.targets ?? [];
      assert.equal(targets.length, 6);
      const exploredCardId = settling?.actions[0]?.card.cardId;
      assert.ok(exploredCardId);
      assert.ok(targets.includes(`knowledge:${roomId}:${exploredCardId}`));
      const expectedAward = (actorIndex: number) =>
        (actorIndex < 2 ? 5 : 0) +
        (settling?.scenario?.correctChoice === "choice_1" && actorIndex < 2
          ? 20
          : 0);
      assert.deepEqual(
        settling?.settlementPlan?.pointAwards.map(
          ({ playerId, requestedDelta }) => ({
            playerId,
            requestedDelta,
          }),
        ),
        actors
          .map((actor, index) => ({
            playerId: actor.playerId,
            requestedDelta: expectedAward(index),
          }))
          .sort((left, right) =>
            left.playerId < right.playerId
              ? -1
              : left.playerId > right.playerId
                ? 1
                : 0,
          ),
      );
      const confirmations = (effectKeys: readonly string[]) =>
        effectKeys.map((effectKey) => ({
          effectKey,
          resultReference: `integration-result:${effectKey}`,
        }));

      await assert.rejects(
        commands.finalizeSettlement(roomId, confirmations(targets.slice(1))),
        (error: unknown) =>
          error instanceof QueryRuleError &&
          error.code === "SETTLEMENT_INCOMPLETE",
      );
      await assert.rejects(
        commands.finalizeSettlement(
          roomId,
          confirmations([...targets, "knowledge:forged"]),
        ),
        (error: unknown) =>
          error instanceof QueryRuleError &&
          error.code === "SETTLEMENT_PLAN_MISMATCH",
      );
      assert.equal((await repository.get(roomId))?.phase, "settling");

      const playerCommands = new PostgresPlayerCommands(
        players,
        receipts,
        new PostgresOutbox(),
        gameplayReleases,
        ids,
        clock,
      );
      const scriptCommands = new PostgresScriptCommands(
        new PostgresScriptRepository(unitOfWork),
        receipts,
        new PostgresOutbox(),
        ids,
        clock,
      );
      const errors: unknown[] = [];
      const createCoordinator = (
        scriptPort: Pick<
          PostgresScriptCommands,
          "createQueryCardScript" | "grantKnowledgeEffect"
        >,
      ) =>
        new QuerySettlementCoordinator(
          repository,
          commands,
          {
            applyDelta: async (effectId: string) => ({
              resultReference: `isolated-board-effect:${effectId}`,
              replayed: false,
            }),
          },
          playerCommands,
          scriptPort,
          ids,
          (_failedQueryId, error) => errors.push(error),
        );
      let failKnowledgeOnce = true;
      const interruptedScriptCommands: Pick<
        PostgresScriptCommands,
        "createQueryCardScript" | "grantKnowledgeEffect"
      > = {
        createQueryCardScript: (...args) =>
          scriptCommands.createQueryCardScript(...args),
        grantKnowledgeEffect: async (...args) => {
          if (failKnowledgeOnce) {
            failKnowledgeOnce = false;
            throw new Error("injected Knowledge failure");
          }
          return scriptCommands.grantKnowledgeEffect(...args);
        },
      };

      assert.equal(
        await createCoordinator(interruptedScriptCommands).advanceDueSettlements(),
        0,
      );
      assert.equal(errors.length, 1);
      assert.equal((await repository.get(roomId))?.phase, "settling");
      const confirmationsAfterFailure =
        await repository.getSettlementConfirmations(roomId);
      assert.equal(confirmationsAfterFailure.length, 1);
      assert.equal(
        confirmationsAfterFailure[0]?.effectKey,
        `board:${roomId}`,
      );
      const scriptsAfterFailure = await unitOfWork.transaction((transaction) =>
        transaction.query<{ cardId: string; playerId: string }>(
          `SELECT "cardId" AS "cardId", "playerId" AS "playerId"
           FROM "script"."Scripts" WHERE "queryId" = @queryId;`,
          { queryId: roomId },
        ),
      );
      assert.deepEqual(scriptsAfterFailure, [
        { cardId: exploredCardId, playerId: actors[0]!.playerId },
      ]);

      assert.equal(
        await createCoordinator(scriptCommands).advanceDueSettlements(),
        1,
      );
      assert.equal(errors.length, 1);
      const completed = await repository.get(roomId);
      assert.equal(completed?.phase, "completed");
      const scripts = await unitOfWork.transaction((transaction) =>
        transaction.query<{ cardId: string; playerId: string }>(
          `SELECT "cardId" AS "cardId", "playerId" AS "playerId"
           FROM "script"."Scripts" WHERE "queryId" = @queryId;`,
          { queryId: roomId },
        ),
      );
      assert.deepEqual(scripts, [
        { cardId: exploredCardId, playerId: actors[0]!.playerId },
      ]);

      const replayed = await commands.finalizeSettlement(
        roomId,
        (await repository.getSettlementConfirmations(roomId)).map(
          ({ effectKey, resultReference }) => ({ effectKey, resultReference }),
        ),
      );
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.aggregateVersion, completed?.version);
      await assert.rejects(
        commands.finalizeSettlement(
          roomId,
          confirmations(targets).map((confirmation, index) =>
            index === 0
              ? { ...confirmation, resultReference: "result:forged" }
              : confirmation,
          ),
        ),
        (error: unknown) =>
          error instanceof QueryRuleError &&
          error.code === "SETTLEMENT_PLAN_MISMATCH",
      );
      await assert.rejects(
        commands.finalizeSettlement(
          roomId,
          confirmations([...targets.slice(1), targets[0]!, targets[0]!]),
        ),
        (error: unknown) =>
          error instanceof QueryRuleError &&
          error.code === "SETTLEMENT_PLAN_MISMATCH",
      );

      const persistedConfirmations = await unitOfWork.transaction(
        (transaction) =>
          transaction.query<{
            effectKey: string;
            resultReference: string;
          }>(
            `SELECT "effectKey" AS "effectKey",
                    "resultReference" AS "resultReference"
             FROM "query"."SettlementConfirmations"
             WHERE "queryId" = @queryId ORDER BY "effectKey";`,
            { queryId: roomId },
          ),
      );
      assert.equal(persistedConfirmations.length, targets.length);
      assert.deepEqual(
        persistedConfirmations.map(({ effectKey }) => effectKey),
        [...targets].sort(),
      );
      assert.ok(
        persistedConfirmations.every(
          ({ resultReference }) => resultReference.length > 0,
        ),
      );
      const scorePlayerParameters = Object.fromEntries(
        actors.map(({ playerId }, index) => [
          `scorePlayerId${index}`,
          playerId,
        ]),
      );
      const scorePlayerPlaceholders = actors
        .map((_, index) => `@scorePlayerId${index}`)
        .join(", ");
      const scores = await unitOfWork.transaction((transaction) =>
        transaction.query<{ playerId: string; score: number }>(
          `SELECT "playerId" AS "playerId", "score" AS "score"
           FROM "player"."Players" WHERE "playerId" IN (${scorePlayerPlaceholders});`,
          scorePlayerParameters,
        ),
      );
      assert.deepEqual(
        scores
          .map(({ playerId, score }) => ({ playerId, score }))
          .sort((left, right) => left.playerId.localeCompare(right.playerId)),
        actors
          .map((actor, index) => ({
            playerId: actor.playerId,
            score: 1_000 + expectedAward(index),
          }))
          .sort((left, right) => left.playerId.localeCompare(right.playerId)),
      );
      const knowledge = await unitOfWork.transaction((transaction) =>
        transaction.query<{ sourceRef: string }>(
          `SELECT k."sourceRef" AS "sourceRef"
           FROM "script"."PlayerKnowledge" k
           JOIN "script"."Scripts" s ON s."scriptId" = k."scriptId"
           WHERE k."playerId" = @playerId AND s."queryId" = @queryId;`,
          {
            playerId: actors[0]!.playerId,
            queryId: roomId,
          },
        ),
      );
      assert.deepEqual(knowledge, [
        {
          sourceRef: `query:${roomId}:card:${settling?.actions[0]?.card.cardId}`,
        },
      ]);

      const events = await unitOfWork.transaction((transaction) =>
        transaction.query<{
          payloadJson: { selectedCorrect: boolean; participantIds: string[] };
        }>(
          `SELECT "payloadJson" AS "payloadJson" FROM "platform"."OutboxEvents"
           WHERE "streamId" = @queryId AND "eventType" = 'QuerySettlementCompleted';`,
          { queryId: roomId },
        ),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.payloadJson.participantIds.length, 4);
      assert.equal(
        events[0]?.payloadJson.selectedCorrect,
        completed?.scenario?.correctChoice === "choice_1",
      );

      const slots = await unitOfWork.transaction((transaction) =>
        transaction.query<{ count: string }>(
          `SELECT COUNT(*)::text AS "count" FROM "query"."ParticipationSlots"
           WHERE "queryId" = @queryId;`,
          { queryId: roomId },
        ),
      );
      assert.equal(Number(slots[0]?.count), 0);
    } finally {
      try {
        if (queryId !== undefined) {
          await cleanupRoom(unitOfWork, queryId, actors);
        }
        await cleanupPlayers(unitOfWork, actors);
      } finally {
        await pool.end();
      }
    }
  },
);
