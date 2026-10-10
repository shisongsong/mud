import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlayerActor } from "../../kernel/actor.ts";
import type { Clock } from "../../kernel/ports.ts";
import {
  advanceQuery,
  createQuery,
  joinQuery,
  QueryRuleError,
} from "../../modules/query/public.ts";
import type { QueryAggregate } from "../../modules/query/public.ts";
import type {
  ActiveGameplayRelease,
  GameplayReleaseReader,
} from "./gameplay-release-repository.ts";
import { PostgresCommandReceipts } from "../transactions/command-receipts.ts";
import { PostgresQueryCommands } from "./query-commands.ts";
import { PostgresQueryRepository } from "./query-repository.ts";
import type {
  QueryExecutor,
  SqlParameters,
  UnitOfWork,
} from "../transactions/unit-of-work.ts";

// Self-contained fixtures for inspect and phase advancement. These tests use a
// pinned release shaped like the real trial1 data (variant_1 / site_1..3).

const NOW = new Date("2026-09-30T12:00:00.000Z").getTime();
const clock: Clock = { now: () => new Date(NOW) };
const QUERY_ID = "33333333-3333-4333-8333-333333333333";
const PLAYER_1 = "22222222-2222-4222-8222-222222222222";
const OUTSIDER = "55555555-5555-4555-8555-555555555555";
const actor: PlayerActor = {
  kind: "player",
  accountId: "11111111-1111-4111-8111-111111111111",
  playerId: PLAYER_1,
};
const scenario = {
  variantId: "variant_1",
  randomSeed: "seed_inspect_1",
  correctChoice: "choice_1" as const,
};

const pinnedRelease: GameplayReleaseReader = {
  getActiveGameplayRelease: async () =>
    ({
      releaseId: "gameplay_v1",
      queryEnabled: true,
      templates: ["trial_1"],
    }) as ActiveGameplayRelease,
  getGameplayReleaseById: async () =>
    ({
      releaseId: "gameplay_v1",
      queryEnabled: true,
      templates: ["trial_1"],
      trial1: {
        choices: [],
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
                args: {},
                isTruth: false,
              },
            ],
          },
        ],
      },
    }) as unknown as ActiveGameplayRelease,
};

const bareRelease: GameplayReleaseReader = {
  getActiveGameplayRelease: pinnedRelease.getActiveGameplayRelease,
  getGameplayReleaseById: async () =>
    ({
      releaseId: "gameplay_v1",
      queryEnabled: true,
      templates: ["trial_1"],
    }) as ActiveGameplayRelease,
};

// Builds an exploring room. The fourth join sets explorationStartedAt, so the
// exploration deadline is explorationStartAt + 120s.
function explorationRoom(explorationStartAt: number, withScenario = true) {
  const pinned = withScenario ? scenario : null;
  let query = createQuery(
    QUERY_ID,
    PLAYER_1,
    "gameplay_v1",
    explorationStartAt - 30_000,
    "faction_1",
  );
  query = joinQuery(
    query,
    "player_2",
    explorationStartAt - 20_000,
    () => scenario,
    "faction_2",
  );
  query = joinQuery(
    query,
    "player_3",
    explorationStartAt - 10_000,
    () => scenario,
    "faction_3",
  );
  query = joinQuery(
    query,
    "player_4",
    explorationStartAt,
    () => scenario,
    "faction_4",
  );
  return pinned === null ? { ...query, scenario: null } : query;
}

interface Fixture {
  readonly commands: PostgresQueryCommands;
  readonly database: MemoryDatabase;
  readonly aggregate: () => QueryAggregate;
  readonly saveCalls: () => number;
}

// Minimal in-memory database: records outbox inserts and replays receipts.
class MemoryDatabase implements UnitOfWork {
  readonly outboxEvents: SqlParameters[] = [];
  private receipts = new Map<
    string,
    { requestDigest: string; responseJson: string }
  >();

  async transaction<T>(
    work: (executor: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    const receipts = new Map(this.receipts);
    const events: SqlParameters[] = [];
    const executor: QueryExecutor = {
      query: async <Row extends object>(
        statement: string,
        parameters: SqlParameters = {},
      ): Promise<readonly Row[]> => {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes('INSERT INTO "platform"."OutboxStreams"'))
          return [];
        if (statement.includes('UPDATE "platform"."OutboxStreams"')) {
          return [{ sequence: 1 }] as unknown as readonly Row[];
        }
        if (statement.includes('INSERT INTO "platform"."OutboxEvents"')) {
          events.push(parameters);
          return [];
        }
        if (statement.includes('FROM "platform"."CommandReceipts"')) {
          const key = [
            parameters["actorScope"],
            parameters["operation"],
            parameters["idempotencyKey"],
          ].join("|");
          const stored = receipts.get(key);
          return (stored === undefined
            ? []
            : [
                { ...stored, status: "completed" },
              ]) as unknown as readonly Row[];
        }
        if (statement.includes('INSERT INTO "platform"."CommandReceipts"')) {
          const key = [
            parameters["actorScope"],
            parameters["operation"],
            parameters["idempotencyKey"],
          ].join("|");
          receipts.set(key, {
            requestDigest: String(parameters["requestDigest"]),
            responseJson: String(parameters["responseJson"]),
          });
          return [];
        }
        return [];
      },
    };
    const result = await work(executor);
    this.receipts = receipts;
    this.outboxEvents.push(...events);
    return result;
  }
}

function fixtureFor(
  initial: QueryAggregate,
  release: GameplayReleaseReader = pinnedRelease,
): Fixture {
  let aggregate = initial;
  let saveCalls = 0;
  const database = new MemoryDatabase();
  let nextId = 0;
  const repository = {
    runInTransaction: <T>(work: (executor: QueryExecutor) => Promise<T>) =>
      database.transaction(work),
    listDueQueryIds: async () => [aggregate.queryId],
    getInTransaction: async (_t: QueryExecutor, queryId: string) =>
      aggregate.queryId === queryId ? aggregate : null,
    saveInTransaction: async (
      _t: QueryExecutor,
      updated: QueryAggregate,
      expectedVersion: number,
    ) => {
      if (aggregate.version !== expectedVersion) return false;
      aggregate = updated;
      saveCalls += 1;
      return true;
    },
  } as unknown as PostgresQueryRepository;
  const commands = new PostgresQueryCommands(
    repository,
    new PostgresCommandReceipts(database),
    release,
    {
      next: () => {
        nextId += 1;
        return `44444444-4444-4444-8444-${String(nextId).padStart(12, "0")}`;
      },
    },
    clock,
  );
  return {
    commands,
    database,
    aggregate: () => aggregate,
    saveCalls: () => saveCalls,
  };
}

test("inspect records private evidence, keeps text out of the outbox, and replays its receipt", async () => {
  const fx = fixtureFor(explorationRoom(NOW - 10_000), pinnedRelease);
  const key = "inspect-key-0000001";
  const first = await fx.commands.inspect(
    actor,
    QUERY_ID,
    { actionType: "inspect", siteId: "site_1" },
    key,
  );
  const replay = await fx.commands.inspect(
    actor,
    QUERY_ID,
    { actionType: "inspect", siteId: "site_1" },
    key,
  );

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(fx.saveCalls(), 1);

  const card = fx.aggregate().actions[0]?.card;
  assert.equal(card?.isTruth, true);
  assert.match(card?.text ?? "", /K1/);
  assert.doesNotMatch(card?.text ?? "", /\{mark\}/);

  assert.equal(fx.database.outboxEvents.length, 1);
  assert.equal(
    fx.database.outboxEvents[0]?.["eventType"],
    "QueryEvidenceInspected",
  );
  const payload = String(fx.database.outboxEvents[0]?.["payloadJson"]);
  assert.doesNotMatch(payload, /K1|isTruth|"text"/);
});

test("inspect rejects a repeated site and an outsider without writing", async () => {
  const fx = fixtureFor(explorationRoom(NOW - 10_000), pinnedRelease);
  await fx.commands.inspect(
    actor,
    QUERY_ID,
    { actionType: "inspect", siteId: "site_2" },
    "inspect-key-0000002",
  );

  await assert.rejects(
    fx.commands.inspect(
      actor,
      QUERY_ID,
      { actionType: "inspect", siteId: "site_2" },
      "inspect-key-0000003",
    ),
    (error: unknown) =>
      error instanceof QueryRuleError &&
      error.code === "SITE_ALREADY_INSPECTED",
  );
  await assert.rejects(
    fx.commands.inspect(
      { ...actor, playerId: OUTSIDER },
      QUERY_ID,
      { actionType: "inspect", siteId: "site_3" },
      "inspect-key-0000004",
    ),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "QUERY_NOT_MEMBER",
  );
  assert.equal(fx.saveCalls(), 1);
  assert.equal(fx.database.outboxEvents.length, 1);
});

test("inspect reports a non-exploring room as a rule error before any evidence lookup", async () => {
  const votingRoom = advanceQuery(explorationRoom(NOW - 130_000), NOW - 1);
  // Release has no trial1 data; the phase rule must still win over the lookup.
  const fx = fixtureFor(votingRoom, bareRelease);
  await assert.rejects(
    fx.commands.inspect(
      actor,
      QUERY_ID,
      { actionType: "inspect", siteId: "site_1" },
      "inspect-key-0000005",
    ),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "QUERY_NOT_EXPLORING",
  );
  assert.equal(fx.saveCalls(), 0);
  assert.equal(fx.database.outboxEvents.length, 0);
});

test("inspect fails closed when the pinned release lacks evidence for the room", async () => {
  const fx = fixtureFor(explorationRoom(NOW - 10_000), bareRelease);
  await assert.rejects(
    fx.commands.inspect(
      actor,
      QUERY_ID,
      { actionType: "inspect", siteId: "site_1" },
      "inspect-key-0000006",
    ),
    /no evidence for site/,
  );
  assert.equal(fx.saveCalls(), 0);
  assert.equal(fx.database.outboxEvents.length, 0);
});

test("inspect rejects a room without a scenario as INVALID_SCENARIO", async () => {
  const fx = fixtureFor(explorationRoom(NOW - 10_000, false), pinnedRelease);
  await assert.rejects(
    fx.commands.inspect(
      actor,
      QUERY_ID,
      { actionType: "inspect", siteId: "site_1" },
      "inspect-key-0000007",
    ),
    (error: unknown) =>
      error instanceof QueryRuleError && error.code === "INVALID_SCENARIO",
  );
  assert.equal(fx.saveCalls(), 0);
});

test("advanceDueQueries moves due rooms through waiting, exploring, and voting deadlines", async () => {
  // Waiting room whose 5-minute window has passed.
  const waiting = {
    ...createQuery(
      QUERY_ID,
      PLAYER_1,
      "gameplay_v1",
      NOW - 400_000,
      "faction_1",
    ),
  };
  const waitingFx = fixtureFor(waiting);
  assert.equal(await waitingFx.commands.advanceDueQueries(), 1);
  assert.equal(waitingFx.aggregate().phase, "cancelled");
  assert.equal(
    waitingFx.database.outboxEvents[0]?.["eventType"],
    "QueryPhaseAdvanced",
  );
  // Already terminal: the domain returns the same object, so nothing is written.
  assert.equal(await waitingFx.commands.advanceDueQueries(), 0);
  assert.equal(waitingFx.saveCalls(), 1);

  // Exploration deadline passed (start NOW-130s, deadline NOW-10s).
  const exploringFx = fixtureFor(explorationRoom(NOW - 130_000));
  assert.equal(await exploringFx.commands.advanceDueQueries(), 1);
  assert.equal(exploringFx.aggregate().phase, "voting");

  // Voting deadline passed (start NOW-200s, voting deadline NOW-20s).
  const votingFx = fixtureFor(
    advanceQuery(explorationRoom(NOW - 200_000), NOW - 79_000),
  );
  assert.equal(votingFx.aggregate().phase, "voting");
  assert.equal(await votingFx.commands.advanceDueQueries(), 1);
  assert.equal(votingFx.aggregate().phase, "settling");
});

test("advanceDueQueries skips rooms whose deadline has not passed", async () => {
  const fx = fixtureFor(explorationRoom(NOW - 10_000));
  assert.equal(await fx.commands.advanceDueQueries(), 0);
  assert.equal(fx.saveCalls(), 0);
  assert.equal(fx.database.outboxEvents.length, 0);
});
