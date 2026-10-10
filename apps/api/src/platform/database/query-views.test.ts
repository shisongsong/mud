import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlayerActor } from "../../kernel/actor.ts";
import type { Clock } from "../../kernel/ports.ts";
import {
  advanceQuery,
  castVote,
  createQuery,
  finalizeSettlement,
  inspectQuery,
  joinQuery,
} from "../../modules/query/public.ts";
import type { QueryAggregate } from "../../modules/query/public.ts";
import type {
  QueryExecutor,
  UnitOfWork,
} from "../transactions/unit-of-work.ts";
import type { PostgresPlayerRepository } from "./player-repository.ts";
import type {
  ActiveGameplayRelease,
  GameplayReleaseReader,
} from "./gameplay-release-repository.ts";
import type { PostgresQueryRepository } from "./query-repository.ts";
import { PostgresQueryViews } from "./query-views.ts";

const NOW = new Date("2026-09-30T12:00:00.000Z").getTime();
const clock: Clock = { now: () => new Date(NOW) };
const QUERY_ID = "33333333-3333-4333-8333-333333333333";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "66666666-6666-4666-8666-666666666666";
const P3 = "77777777-7777-4777-8777-777777777777";
const P4 = "88888888-8888-4888-8888-888888888888";
const OUTSIDER = "55555555-5555-4555-8555-555555555555";
const scenario = {
  variantId: "variant_1",
  randomSeed: "seed_views_1",
  correctChoice: "choice_1" as const,
};
const gameplayRelease: ActiveGameplayRelease = {
  releaseId: "gameplay_v1",
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

function roomWithEvidence(): QueryAggregate {
  let query = createQuery(
    QUERY_ID,
    P1,
    "gameplay_v1",
    NOW - 60_000,
    "faction_1",
  );
  query = joinQuery(query, P2, NOW - 50_000, () => scenario, "faction_2");
  query = joinQuery(query, P3, NOW - 40_000, () => scenario, "faction_3");
  query = joinQuery(query, P4, NOW - 30_000, () => scenario, "faction_4");
  query = inspectQuery(query, P1, "site_1", NOW, () => ({
    cardId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    playerId: P1,
    siteId: "site_1",
    text: "own-visible-text",
    isTruth: true,
  }));
  return inspectQuery(query, P2, "site_2", NOW, () => ({
    cardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    playerId: P2,
    siteId: "site_2",
    text: "p2-private-text",
    isTruth: false,
  }));
}

function viewsFor(
  query: QueryAggregate | null,
  ownScoreEffect: {
    readonly requestedDelta: number;
    readonly effectiveDelta: number;
    readonly scoreAfter: number;
  } | null = null,
) {
  const unitOfWork = {
    transaction: <T>(work: (executor: QueryExecutor) => Promise<T>) =>
      work({ query: async () => [] } as unknown as QueryExecutor),
  } as unknown as UnitOfWork;
  const repository = {
    getInTransaction: async (_t: QueryExecutor, queryId: string) =>
      query !== null && query.queryId === queryId ? query : null,
  } as unknown as PostgresQueryRepository;
  const players = {
    getDisplayNameByPlayerId: async (_t: QueryExecutor, playerId: string) =>
      `玩家${playerId.slice(0, 4)}`,
    getScoreEffectInTransaction: async () => ownScoreEffect,
  } as unknown as PostgresPlayerRepository;
  const gameplayReleases: GameplayReleaseReader = {
    getActiveGameplayRelease: async () => null,
    getGameplayReleaseById: async () => gameplayRelease,
  };
  return new PostgresQueryViews(
    unitOfWork,
    repository,
    players,
    clock,
    gameplayReleases,
  );
}

function actorFor(playerId: string): PlayerActor {
  return {
    kind: "player",
    accountId: "11111111-1111-4111-8111-111111111111",
    playerId,
  };
}

test("snapshot exposes only the caller's own evidence and marks exactly one participant as self", async () => {
  const views = viewsFor(roomWithEvidence());
  const snapshot = await views.getSnapshot(actorFor(P1), QUERY_ID);

  assert.notEqual(snapshot, null);
  assert.equal(snapshot?.phase, "exploring");
  assert.equal(snapshot?.participants.length, 4);
  assert.equal(snapshot?.participants.filter((p) => p.isSelf).length, 1);
  assert.equal(
    snapshot?.participants.find((p) => p.isSelf)?.displayName,
    "玩家2222",
  );
  assert.deepEqual(
    snapshot?.self.evidenceCards.map((card) => card.siteId),
    ["site_1"],
  );
  assert.equal(snapshot?.self.evidenceCards[0]?.text, "own-visible-text");
  assert.equal(snapshot?.self.actionsUsed, 1);
  assert.equal(snapshot?.result, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /p2-private-text/);
});

test("completed snapshot reveals aggregate verdict and only the caller's score", async () => {
  let query = roomWithEvidence();
  query = advanceQuery(query, NOW + 120_000);
  query = castVote(query, P1, "choice_1", query.version, query.deadline! - 1);
  query = castVote(query, P2, "choice_2", query.version, query.deadline! - 1);
  query = castVote(query, P3, "abstain", query.version, query.deadline! - 1);
  query = advanceQuery(query, query.deadline!);
  const plan = query.settlementPlan!;
  query = finalizeSettlement(
    query,
    plan.targets.map((effectKey) => ({
      effectKey,
      resultReference: `result:${effectKey}`,
    })),
  );

  const snapshot = await viewsFor(query, {
    requestedDelta: 25,
    effectiveDelta: 25,
    scoreAfter: 1_025,
  }).getSnapshot(actorFor(P1), QUERY_ID);

  assert.equal(snapshot?.phase, "completed");
  assert.deepEqual(snapshot?.result, {
    selectedChoice: "choice_1",
    correctChoice: "choice_1",
    voteCounts: { choice1: 1, choice2: 1, abstentions: 1, notCast: 1 },
    explanationKey: "trial.explanation.current_mark",
    ownScore: { requestedDelta: 25, awardedDelta: 25, scoreAfter: 1_025 },
  });
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /playerId|voteChoice.*choice_2/,
  );
});

test("snapshot returns null for outsiders and unknown rooms", async () => {
  const views = viewsFor(roomWithEvidence());
  assert.equal(await views.getSnapshot(actorFor(OUTSIDER), QUERY_ID), null);
  assert.equal(
    await views.getSnapshot(
      actorFor(P1),
      "99999999-9999-4999-8999-999999999999",
    ),
    null,
  );
  assert.equal(await viewsFor(null).getSnapshot(actorFor(P1), QUERY_ID), null);
});
