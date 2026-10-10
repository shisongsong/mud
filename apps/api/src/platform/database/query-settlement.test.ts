import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceQuery,
  castVote,
  createQuery,
  finalizeSettlement,
  inspectQuery,
  joinQuery,
} from "../../modules/query/public.ts";
import type {
  QueryAggregate,
  QueryScenario,
} from "../../modules/query/public.ts";
import { QuerySettlementCoordinator } from "./query-settlement.ts";

const scenario: QueryScenario = {
  variantId: "trial_1_variant_a",
  randomSeed: "seed_audit_1",
  correctChoice: "choice_2",
};

function settlingQuery(): QueryAggregate {
  let query = createQuery("query_1", "player_1", "gameplay_v1", 0, "faction_1");
  query = joinQuery(query, "player_2", 1, () => scenario, "faction_2");
  query = joinQuery(query, "player_3", 2, () => scenario, "faction_3");
  query = joinQuery(query, "player_4", 3, () => scenario, "faction_4");
  query = inspectQuery(query, "player_1", "site_1", 4, () => ({
    cardId: "card_1",
    playerId: "player_1",
    siteId: "site_1",
    text: "A private clue",
    isTruth: true,
  }));
  query = advanceQuery(query, query.deadline!);
  for (const { playerId } of query.participants) {
    query = castVote(
      query,
      playerId,
      "choice_2",
      query.version,
      query.deadline! - 1,
    );
  }
  return advanceQuery(query, query.deadline!);
}

test("settlement retries idempotently and confirms each effect before finalizing", async () => {
  const query = settlingQuery();
  const confirmations = new Map<string, string>();
  const errors: unknown[] = [];
  const operations: string[] = [];
  const boardReferences = new Map<string, string>();
  let boardAttempts = 0;
  let failFirstConfirmation = true;
  let failFirstGrant = true;
  let finalized = false;

  const coordinator = new QuerySettlementCoordinator(
    {
      listSettlingQueryIds: async () => [query.queryId],
      get: async () => query,
      getSettlementConfirmations: async () =>
        [...confirmations].map(([effectKey, resultReference]) => ({
          effectKey,
          resultReference,
        })),
    },
    {
      confirmSettlementEffects: async (_queryId, batch) => {
        if (failFirstConfirmation) {
          failFirstConfirmation = false;
          throw new Error("confirmation unavailable");
        }
        for (const item of batch) {
          confirmations.set(item.effectKey, item.resultReference);
        }
        return batch;
      },
      finalizeSettlement: async (_queryId, batch) => {
        const completed = finalizeSettlement(query, batch);
        finalized = completed.phase === "completed";
        return { replayed: false, aggregateVersion: completed.version };
      },
    },
    {
      applyDelta: async (effectId) => {
        operations.push("board");
        boardAttempts += 1;
        let resultReference = boardReferences.get(effectId);
        if (!resultReference) {
          resultReference = `board-effect:${effectId}`;
          boardReferences.set(effectId, resultReference);
        }
        return { resultReference, replayed: boardAttempts > 1 };
      },
    },
    {
      applyScoreEffect: async (
        effectId,
        playerId,
        requestedDelta,
        reasonRef,
      ) => {
        operations.push("score");
        return {
          effect: {
            effectId,
            playerId,
            requestedDelta,
            effectiveDelta: requestedDelta,
            scoreBefore: 0,
            scoreAfter: requestedDelta,
            clamped: false,
            reasonRef,
            aggregateVersion: 1,
          },
          replayed: false,
        };
      },
    },
    {
      createQueryCardScript: async (effectId) => {
        operations.push("script-create");
        return {
          scriptId: `script:${effectId}`,
          created: true,
          replayed: false,
        };
      },
      grantKnowledgeEffect: async () => {
        operations.push("knowledge-grant");
        if (failFirstGrant) {
          failFirstGrant = false;
          throw new Error("knowledge service unavailable");
        }
        return { grantId: "grant_1", created: true, replayed: false };
      },
    },
    { next: () => "trace_1" },
    (_queryId, error) => errors.push(error),
  );

  assert.equal(await coordinator.advanceDueSettlements(), 0);
  assert.equal(finalized, false);
  assert.equal(confirmations.size, 0);

  assert.equal(await coordinator.advanceDueSettlements(), 0);
  assert.equal(finalized, false);
  assert.equal(confirmations.size, 1);

  assert.equal(await coordinator.advanceDueSettlements(), 1);
  assert.equal(finalized, true);
  assert.equal(errors.length, 2);
  assert.equal(boardAttempts, 2);
  assert.equal(boardReferences.size, 1);
  assert.equal(
    operations.filter((operation) => operation === "board").length,
    2,
  );
  assert.equal(
    operations.filter((operation) => operation === "score").length,
    query.participants.length,
  );
  assert.ok(
    operations.indexOf("script-create") <
      operations.lastIndexOf("knowledge-grant"),
  );
  assert.equal(confirmations.size, query.settlementPlan?.targets.length);
});
