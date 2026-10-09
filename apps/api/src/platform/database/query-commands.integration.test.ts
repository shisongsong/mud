import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { loadEnvironment } from "../../config/env.ts";
import type { PlayerActor } from "../../kernel/actor.ts";
import { QueryRuleError } from "../../modules/query/public.ts";
import type { ActiveGameplayRelease } from "./gameplay-release-repository.ts";
import { PostgresCommandReceipts } from "../transactions/command-receipts.ts";
import { PostgresUnitOfWork, createPostgresPool } from "./postgres.ts";
import { PostgresQueryCommands } from "./query-commands.ts";
import { PostgresQueryRepository } from "./query-repository.ts";

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
    for (const statement of [
      `DELETE FROM "platform"."EventDeliveries" WHERE "streamId" = @queryId;`,
      `DELETE FROM "platform"."OutboxEvents" WHERE "streamId" = @queryId;`,
      `DELETE FROM "platform"."OutboxStreams" WHERE "streamId" = @queryId;`,
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
    const commands = new PostgresQueryCommands(
      repository,
      new PostgresCommandReceipts(unitOfWork),
      {
        getActiveGameplayRelease: async () => release,
        getGameplayReleaseById: async () => release,
      },
      { next: () => randomUUID() },
      { now: () => new Date(current) },
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

      const finalized = await commands.finalizeSettlement(
        roomId,
        confirmations([...targets].reverse()),
      );
      assert.equal(finalized.replayed, false);
      const replayed = await commands.finalizeSettlement(
        roomId,
        confirmations(targets),
      );
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.aggregateVersion, finalized.aggregateVersion);
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

      const completed = await repository.get(roomId);
      assert.equal(completed?.phase, "completed");

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
        persistedConfirmations.every(({ resultReference }) =>
          resultReference.startsWith("integration-result:"),
        ),
      );

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
      } finally {
        await pool.end();
      }
    }
  },
);
