import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createQuery,
  getAuthorizedQueryView,
  inspectQuery,
  joinQuery,
} from "../../modules/query/public.ts";
import type {
  QueryAggregate,
  QueryScenario,
} from "../../modules/query/public.ts";
import type {
  QueryExecutor,
  SqlParameters,
  UnitOfWork,
} from "../transactions/unit-of-work.ts";
import { SqlServerQueryRepository } from "./query-repository.ts";

const playerIds = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];
const queryId = "10000000-0000-4000-8000-000000000001";
const cardId = "20000000-0000-4000-8000-000000000001";
const scenario: QueryScenario = {
  variantId: "trial_1_variant_a",
  randomSeed: "audit-seed-01",
  correctChoice: "choice_2",
};

function exploringQuery(): QueryAggregate {
  let query = createQuery(queryId, playerIds[0]!, "gameplay_release_1", 1_000);
  query = joinQuery(query, playerIds[1]!, 1_001, () => scenario);
  query = joinQuery(query, playerIds[2]!, 1_002, () => scenario);
  return joinQuery(query, playerIds[3]!, 1_003, () => scenario);
}

class RecordingUnitOfWork implements UnitOfWork {
  readonly statements: { statement: string; parameters?: SqlParameters }[] = [];
  allowUpdate = true;

  constructor(private readonly aggregate: QueryAggregate | null = null) {}

  async transaction<T>(
    work: (executor: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    return work({
      query: async <Row extends object>(
        statement: string,
        parameters?: SqlParameters,
      ): Promise<readonly Row[]> => {
        this.statements.push(
          parameters === undefined ? { statement } : { statement, parameters },
        );
        const rows = this.rowsFor(statement);
        return rows as readonly Row[];
      },
    });
  }

  private rowsFor(statement: string): readonly object[] {
    const aggregate = this.aggregate;
    if (!aggregate) return [];
    if (statement.includes("OUTPUT inserted.queryId")) {
      return this.allowUpdate ? [{ queryId: aggregate.queryId }] : [];
    }
    if (statement.includes("FROM [query].QueryRooms")) {
      return [
        {
          queryId: aggregate.queryId,
          createdByPlayerId: aggregate.createdByPlayerId,
          gameplayReleaseId: aggregate.gameplayReleaseId,
          phase: aggregate.phase,
          aggregateVersion: aggregate.version,
          createdAt: new Date(aggregate.createdAt),
          deadline:
            aggregate.deadline === null ? null : new Date(aggregate.deadline),
          explorationStartedAt:
            aggregate.explorationStartedAt === null
              ? null
              : new Date(aggregate.explorationStartedAt),
          scenarioVariantId: aggregate.scenario?.variantId ?? null,
          randomSeed: aggregate.scenario
            ? new TextEncoder().encode(aggregate.scenario.randomSeed)
            : null,
          correctChoice: aggregate.scenario?.correctChoice ?? null,
          selectedChoice: aggregate.selectedChoice,
        },
      ];
    }
    if (statement.includes("FROM [query].QueryParticipants")) {
      return aggregate.participants.map(({ playerId, joinedAt }) => ({
        playerId,
        joinedAt: new Date(joinedAt),
      }));
    }
    if (statement.includes("FROM [query].QueryActions")) {
      return aggregate.actions.map(
        ({ playerId, siteId, card, acceptedAt }) => ({
          playerId,
          siteId,
          cardId: card.cardId,
          evidenceText: card.text,
          isTruth: card.isTruth,
          acceptedAt: new Date(acceptedAt),
        }),
      );
    }
    if (statement.includes("FROM [query].QueryVotes")) {
      return aggregate.votes.map(({ playerId, choice }) => ({
        playerId,
        choice,
      }));
    }
    return [];
  }
}

test("Query repository creates the aggregate and its initial participants atomically", async () => {
  const unitOfWork = new RecordingUnitOfWork();
  const repository = new SqlServerQueryRepository(unitOfWork);
  const query = createQuery(
    queryId,
    playerIds[0]!,
    "gameplay_release_1",
    1_000,
  );

  await repository.create(query);

  assert.equal(unitOfWork.statements.length, 2);
  assert.match(
    unitOfWork.statements[0]!.statement,
    /INSERT INTO \[query\]\.QueryRooms/,
  );
  assert.match(
    unitOfWork.statements[1]!.statement,
    /INSERT INTO \[query\]\.QueryParticipants/,
  );
  assert.deepEqual(unitOfWork.statements[1]!.parameters, {
    queryId,
    playerId: playerIds[0],
    joinedAt: new Date(1_000),
  });
});

test("Query repository writes scenario seeds as bounded UTF-8 bytes", async () => {
  const unitOfWork = new RecordingUnitOfWork();
  const repository = new SqlServerQueryRepository(unitOfWork);

  await repository.create(exploringQuery());

  assert.deepEqual(
    unitOfWork.statements[0]!.parameters?.["randomSeed"],
    Buffer.from(scenario.randomSeed, "utf8"),
  );
});

test("Query repository rehydrates scenario and keeps evidence truth private", async () => {
  let query = exploringQuery();
  query = inspectQuery(query, playerIds[0]!, "site_1", 1_004, () => ({
    cardId,
    playerId: playerIds[0]!,
    siteId: "site_1",
    text: "A clue known only to its finder.",
    isTruth: true,
  }));
  const repository = new SqlServerQueryRepository(
    new RecordingUnitOfWork(query),
  );

  const rehydrated = await repository.get(queryId);

  assert.deepEqual(rehydrated, query);
  assert.equal(
    getAuthorizedQueryView(rehydrated!, playerIds[0]!).ownEvidenceCards[0]
      ?.text,
    "A clue known only to its finder.",
  );
  assert.equal(
    "isTruth" in
      getAuthorizedQueryView(rehydrated!, playerIds[0]!).ownEvidenceCards[0]!,
    false,
  );
});

test("Query repository uses aggregate-version compare-and-swap before replacing children", async () => {
  const current = exploringQuery();
  const changed = inspectQuery(current, playerIds[0]!, "site_1", 1_004, () => ({
    cardId,
    playerId: playerIds[0]!,
    siteId: "site_1",
    text: "Private evidence",
    isTruth: false,
  }));
  const unitOfWork = new RecordingUnitOfWork(changed);
  const repository = new SqlServerQueryRepository(unitOfWork);

  unitOfWork.allowUpdate = false;
  assert.equal(await repository.save(changed, current.version), false);
  assert.equal(
    unitOfWork.statements.some(({ statement }) =>
      statement.startsWith("DELETE FROM [query]."),
    ),
    false,
  );

  unitOfWork.statements.length = 0;
  unitOfWork.allowUpdate = true;
  assert.equal(await repository.save(changed, current.version), true);
  assert.match(
    unitOfWork.statements[0]!.statement,
    /aggregateVersion = @expectedVersion/,
  );
  assert.ok(
    unitOfWork.statements.some(({ statement }) =>
      statement.includes("INSERT INTO [query].QueryActions"),
    ),
  );
});
