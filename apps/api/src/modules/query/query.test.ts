import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceQuery,
  castVote,
  createQuery,
  finalizeSettlement,
  getAuthorizedQueryView,
  inspectQuery,
  joinQuery,
  leaveQuery,
  QueryRuleError,
} from "./public.ts";
import type { QueryAggregate, QueryScenario } from "./public.ts";

const scenario: QueryScenario = {
  variantId: "trial_1_variant_a",
  randomSeed: "seed_audit_1",
  correctChoice: "choice_2",
};

function fullQuery(startedAt = 1_000): QueryAggregate {
  let query = createQuery("query_1", "player_1", "gameplay_v1", 0);
  query = joinQuery(query, "player_2", 1, () => scenario);
  query = joinQuery(query, "player_3", 2, () => scenario);
  query = joinQuery(query, "player_4", startedAt, () => scenario);
  return query;
}

test("fourth confirmed player starts exploring and pins one scenario", () => {
  let scenarioSelections = 0;
  let query = createQuery("query_1", "player_1", "gameplay_v1", 0);
  query = joinQuery(query, "player_2", 10, () => scenario);
  query = joinQuery(query, "player_3", 20, () => scenario);
  query = joinQuery(query, "player_4", 30, () => {
    scenarioSelections += 1;
    return scenario;
  });

  assert.equal(query.phase, "exploring");
  assert.equal(query.version, 4);
  assert.equal(query.deadline, 120_030);
  assert.equal(query.scenario?.variantId, scenario.variantId);
  assert.equal(scenarioSelections, 1);
  assert.throws(
    () => joinQuery(query, "player_5", 31, () => scenario),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "QUERY_NOT_WAITING",
  );
});

test("scenario random seed must fit its durable binary column", () => {
  const invalidScenario = { ...scenario, randomSeed: "x".repeat(65) };
  let query = createQuery("query_1", "player_1", "gameplay_v1", 0);
  query = joinQuery(query, "player_2", 1, () => invalidScenario);
  query = joinQuery(query, "player_3", 2, () => invalidScenario);

  assert.throws(
    () => joinQuery(query, "player_4", 3, () => invalidScenario),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "INVALID_SCENARIO",
  );
});

test("waiting query leaves and times out without changing membership incorrectly", () => {
  const created = createQuery("query_1", "player_1", "gameplay_v1", 0);
  const withSecond = joinQuery(created, "player_2", 1, () => scenario);
  const afterLeave = leaveQuery(withSecond, "player_1", withSecond.version, 2);

  assert.equal(afterLeave.phase, "waiting");
  assert.deepEqual(
    afterLeave.participants.map(({ playerId }) => playerId),
    ["player_2"],
  );
  assert.equal(advanceQuery(afterLeave, 300_000).phase, "cancelled");
  assert.equal(advanceQuery(created, 299_999).phase, "waiting");
  assert.equal(
    leaveQuery(created, "player_1", created.version, 1).phase,
    "cancelled",
  );
  const started = fullQuery();
  assert.throws(
    () => leaveQuery(started, "player_1", started.version, 1_001),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "QUERY_ALREADY_STARTED",
  );
  assert.throws(
    () => leaveQuery(withSecond, "player_1", created.version, 2),
    (error: unknown) =>
      error instanceof QueryRuleError &&
      error.code === "INVALID_EXPECTED_VERSION",
  );
  assert.throws(
    () => leaveQuery(created, "player_1", created.version, created.deadline!),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "QUERY_EXPIRED",
  );
});

test("inspect is private, bounded, and rejected at the exact deadline", () => {
  const query = fullQuery();
  const card = (
    playerId: string,
    siteId: "site_1" | "site_2" | "site_3",
    cardId: string,
  ) => ({
    cardId,
    playerId,
    siteId,
    text: "A private clue",
    isTruth: true,
  });
  let inspected = inspectQuery(query, "player_1", "site_1", 1_001, () =>
    card("player_1", "site_1", "card_1"),
  );
  inspected = inspectQuery(inspected, "player_1", "site_2", 1_002, () =>
    card("player_1", "site_2", "card_2"),
  );

  assert.throws(
    () =>
      inspectQuery(inspected, "player_1", "site_3", 1_003, () =>
        card("player_1", "site_3", "card_3"),
      ),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "ACTION_LIMIT_REACHED",
  );
  assert.throws(
    () =>
      inspectQuery(query, "player_2", "site_1", query.deadline!, () =>
        card("player_2", "site_1", "late_card"),
      ),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "QUERY_EXPIRED",
  );

  const ownView = getAuthorizedQueryView(inspected, "player_1");
  assert.equal(ownView.participantCount, 4);
  assert.equal("participantPlayerIds" in ownView, false);
  assert.equal(ownView.ownActionsUsed, 2);
  assert.equal(ownView.ownEvidenceCards.length, 2);
  assert.equal("isTruth" in ownView.ownEvidenceCards[0]!, false);
  assert.throws(
    () => getAuthorizedQueryView(inspected, "not_a_member"),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "QUERY_NOT_MEMBER",
  );
});

test("phase deadlines are fixed and vote replacement follows aggregate version", () => {
  const exploring = fullQuery(10_000);
  const voting = advanceQuery(exploring, 130_000);

  assert.equal(voting.phase, "voting");
  assert.equal(voting.deadline, 190_000);
  const firstVote = castVote(
    voting,
    "player_1",
    "choice_2",
    voting.version,
    130_001,
  );
  const replacedVote = castVote(
    firstVote,
    "player_1",
    "choice_1",
    firstVote.version,
    130_002,
  );
  assert.equal(replacedVote.votes.length, 1);
  assert.equal(replacedVote.votes[0]?.choice, "choice_1");
  assert.throws(
    () =>
      castVote(replacedVote, "player_2", "abstain", voting.version, 130_003),
    (error: unknown) =>
      error instanceof QueryRuleError &&
      error.code === "INVALID_EXPECTED_VERSION",
  );
  assert.throws(
    () =>
      castVote(
        replacedVote,
        "player_2",
        "abstain",
        replacedVote.version,
        replacedVote.deadline!,
      ),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "QUERY_EXPIRED",
  );
});

test("a delayed worker advances through voting before settling", () => {
  const exploring = fullQuery(10_000);
  const explorationDeadline = exploring.deadline!;
  const votingDeadline = explorationDeadline + 60_000;
  const delayedExplorationTransition = advanceQuery(
    exploring,
    votingDeadline + 1,
  );

  assert.equal(delayedExplorationTransition.phase, "voting");
  assert.equal(delayedExplorationTransition.deadline, votingDeadline);
  assert.equal(delayedExplorationTransition.version, exploring.version + 1);

  const settled = advanceQuery(
    delayedExplorationTransition,
    votingDeadline + 1,
  );
  assert.equal(settled.phase, "settling");
  assert.equal(settled.deadline, null);
  assert.equal(settled.version, delayedExplorationTransition.version + 1);
});

test("deadline resolution uses choice_1 for a nonempty tie and null for all abstentions", () => {
  const exploring = fullQuery(1_000);
  const voting = advanceQuery(exploring, 121_000);
  let tied = castVote(voting, "player_1", "choice_1", voting.version, 121_001);
  tied = castVote(tied, "player_2", "choice_2", tied.version, 121_002);
  const tieResolved = advanceQuery(tied, tied.deadline!);
  assert.equal(tieResolved.phase, "settling");
  assert.equal(tieResolved.selectedChoice, "choice_1");

  const noVotesResolved = advanceQuery(voting, voting.deadline!);
  assert.equal(noVotesResolved.phase, "settling");
  assert.equal(noVotesResolved.selectedChoice, null);
});

test("settlement completes only after every planned effect is confirmed", () => {
  let query = fullQuery(10_000);
  query = inspectQuery(query, "player_1", "site_1", 10_001, () => ({
    cardId: "card_1",
    playerId: "player_1",
    siteId: "site_1",
    text: "A private clue",
    isTruth: true,
  }));
  query = advanceQuery(query, 130_000);
  assert.throws(
    () => finalizeSettlement(query, []),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "QUERY_NOT_SETTLING",
  );

  query = advanceQuery(query, 190_000);
  const plan = query.settlementPlan;
  assert.equal(query.phase, "settling");
  assert.deepEqual(plan?.targets, [
    "board:query_1",
    "knowledge:query_1:card_1",
    "points:query_1:player_1",
    "points:query_1:player_2",
    "points:query_1:player_3",
    "points:query_1:player_4",
  ]);

  const targets = plan?.targets ?? [];
  assert.throws(
    () => finalizeSettlement(query, targets.slice(1)),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "SETTLEMENT_INCOMPLETE",
  );
  assert.throws(
    () => finalizeSettlement(query, [...targets, "knowledge:query_1:forged"]),
    (error: unknown) =>
      error instanceof QueryRuleError &&
      error.code === "SETTLEMENT_PLAN_MISMATCH",
  );

  const completed = finalizeSettlement(query, [...targets].reverse());
  assert.equal(completed.phase, "completed");
  assert.equal(completed.version, query.version + 1);
  assert.throws(
    () => finalizeSettlement(completed, targets),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "QUERY_NOT_SETTLING",
  );
});
