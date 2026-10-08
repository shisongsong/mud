import type {
  PrivateEvidenceCard,
  QueryAggregate,
  QueryChoice,
  QueryPhase,
  QueryRepository,
  QueryScenario,
  QuerySite,
  QueryVote,
} from "../../modules/query/public.ts";
import type {
  QueryExecutor,
  UnitOfWork,
} from "../transactions/unit-of-work.ts";

interface QueryRoomRow {
  readonly queryId: string;
  readonly createdByPlayerId: string;
  readonly gameplayReleaseId: string;
  readonly phase: QueryPhase;
  readonly aggregateVersion: number | string;
  readonly createdAt: Date;
  readonly deadline: Date | null;
  readonly explorationStartedAt: Date | null;
  readonly scenarioVariantId: string | null;
  readonly randomSeed: Uint8Array | null;
  readonly correctChoice: QueryChoice | null;
  readonly selectedChoice: QueryChoice | null;
}

interface ParticipantRow {
  readonly playerId: string;
  readonly joinedAt: Date;
}

interface ActionRow {
  readonly playerId: string;
  readonly siteId: QuerySite;
  readonly cardId: string;
  readonly evidenceText: string;
  readonly isTruth: boolean;
  readonly acceptedAt: Date;
}

interface VoteRow {
  readonly playerId: string;
  readonly choice: QueryVote;
}

export class SqlServerQueryRepository implements QueryRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async create(query: QueryAggregate): Promise<void> {
    await this.unitOfWork.transaction((transaction) =>
      this.createInTransaction(transaction, query),
    );
  }

  async createInTransaction(
    transaction: QueryExecutor,
    query: QueryAggregate,
  ): Promise<void> {
    await transaction.query(
      `
INSERT INTO [query].QueryRooms
  (queryId, createdByPlayerId, gameplayReleaseId, phase, aggregateVersion,
   createdAt, deadline, explorationStartedAt, scenarioVariantId, randomSeed,
   correctChoice, selectedChoice)
VALUES
  (@queryId, @createdByPlayerId, @gameplayReleaseId, @phase, @aggregateVersion,
   @createdAt, @deadline, @explorationStartedAt, @scenarioVariantId, @randomSeed,
   @correctChoice, @selectedChoice);
`,
      roomParameters(query),
    );
    await insertChildren(transaction, query);
  }

  async get(queryId: string): Promise<QueryAggregate | null> {
    return this.unitOfWork.transaction((transaction) =>
      this.getInTransaction(transaction, queryId),
    );
  }

  async getInTransaction(
    transaction: QueryExecutor,
    queryId: string,
  ): Promise<QueryAggregate | null> {
    const rooms = await transaction.query<QueryRoomRow>(
      `
SELECT queryId, createdByPlayerId, gameplayReleaseId, phase, aggregateVersion,
       createdAt, deadline, explorationStartedAt, scenarioVariantId, randomSeed,
       correctChoice, selectedChoice
FROM [query].QueryRooms
WHERE queryId = @queryId;
`,
      { queryId },
    );
    const room = rooms[0];
    if (!room) return null;

    const participants = await transaction.query<ParticipantRow>(
      `
SELECT playerId, joinedAt
FROM [query].QueryParticipants
WHERE queryId = @queryId AND participationStatus = 'confirmed'
ORDER BY joinedAt, playerId;
`,
      { queryId },
    );
    const actions = await transaction.query<ActionRow>(
      `
SELECT playerId, siteId, cardId, evidenceText, isTruth, acceptedAt
FROM [query].QueryActions
WHERE queryId = @queryId
ORDER BY playerId, actionOrdinal;
`,
      { queryId },
    );
    const votes = await transaction.query<VoteRow>(
      `
SELECT playerId, choice
FROM [query].QueryVotes
WHERE queryId = @queryId
ORDER BY playerId;
`,
      { queryId },
    );
    return hydrateQuery(room, participants, actions, votes);
  }

  async save(query: QueryAggregate, expectedVersion: number): Promise<boolean> {
    if (query.version !== expectedVersion + 1) {
      throw new TypeError(
        "A saved query must advance exactly one aggregate version",
      );
    }

    return this.unitOfWork.transaction((transaction) =>
      this.saveInTransaction(transaction, query, expectedVersion),
    );
  }

  async saveInTransaction(
    transaction: QueryExecutor,
    query: QueryAggregate,
    expectedVersion: number,
  ): Promise<boolean> {
    if (query.version !== expectedVersion + 1) {
      throw new TypeError(
        "A saved query must advance exactly one aggregate version",
      );
    }

    const updated = await transaction.query<{ readonly queryId: string }>(
      `
UPDATE [query].QueryRooms
SET createdByPlayerId = @createdByPlayerId,
    gameplayReleaseId = @gameplayReleaseId,
    phase = @phase,
    aggregateVersion = @aggregateVersion,
    createdAt = @createdAt,
    deadline = @deadline,
    explorationStartedAt = @explorationStartedAt,
    scenarioVariantId = @scenarioVariantId,
    randomSeed = @randomSeed,
    correctChoice = @correctChoice,
    selectedChoice = @selectedChoice
OUTPUT inserted.queryId
WHERE queryId = @queryId AND aggregateVersion = @expectedVersion;
`,
      { ...roomParameters(query), expectedVersion },
    );
    if (updated.length === 0) return false;

    await transaction.query(
      "DELETE FROM [query].QueryActions WHERE queryId = @queryId;",
      { queryId: query.queryId },
    );
    await transaction.query(
      "DELETE FROM [query].QueryVotes WHERE queryId = @queryId;",
      { queryId: query.queryId },
    );
    await transaction.query(
      "DELETE FROM [query].QueryParticipants WHERE queryId = @queryId;",
      { queryId: query.queryId },
    );
    await insertChildren(transaction, query);
    return true;
  }
}

function roomParameters(query: QueryAggregate) {
  return {
    queryId: query.queryId,
    createdByPlayerId: query.createdByPlayerId,
    gameplayReleaseId: query.gameplayReleaseId,
    phase: query.phase,
    aggregateVersion: query.version,
    createdAt: new Date(query.createdAt),
    deadline: query.deadline === null ? null : new Date(query.deadline),
    explorationStartedAt:
      query.explorationStartedAt === null
        ? null
        : new Date(query.explorationStartedAt),
    scenarioVariantId: query.scenario?.variantId ?? null,
    randomSeed: query.scenario
      ? Buffer.from(query.scenario.randomSeed, "utf8")
      : null,
    correctChoice: query.scenario?.correctChoice ?? null,
    selectedChoice: query.selectedChoice,
  };
}

async function insertChildren(
  transaction: QueryExecutor,
  query: QueryAggregate,
): Promise<void> {
  for (const participant of query.participants) {
    await transaction.query(
      `
INSERT INTO [query].QueryParticipants (queryId, playerId, joinedAt, participationStatus)
VALUES (@queryId, @playerId, @joinedAt, 'confirmed');
`,
      {
        queryId: query.queryId,
        playerId: participant.playerId,
        joinedAt: new Date(participant.joinedAt),
      },
    );
  }

  const actionOrdinals = new Map<string, number>();
  for (const action of query.actions) {
    const actionOrdinal = (actionOrdinals.get(action.playerId) ?? 0) + 1;
    actionOrdinals.set(action.playerId, actionOrdinal);
    await transaction.query(
      `
INSERT INTO [query].QueryActions
  (queryId, playerId, actionOrdinal, siteId, cardId, evidenceText, isTruth, acceptedAt)
VALUES
  (@queryId, @playerId, @actionOrdinal, @siteId, @cardId, @evidenceText, @isTruth, @acceptedAt);
`,
      {
        queryId: query.queryId,
        playerId: action.playerId,
        actionOrdinal,
        siteId: action.siteId,
        cardId: action.card.cardId,
        evidenceText: action.card.text,
        isTruth: action.card.isTruth,
        acceptedAt: new Date(action.acceptedAt),
      },
    );
  }

  for (const vote of query.votes) {
    await transaction.query(
      `
INSERT INTO [query].QueryVotes (queryId, playerId, choice, updatedAt)
VALUES (@queryId, @playerId, @choice, SYSUTCDATETIME());
`,
      {
        queryId: query.queryId,
        playerId: vote.playerId,
        choice: vote.choice,
      },
    );
  }
}

function hydrateQuery(
  room: QueryRoomRow,
  participantRows: readonly ParticipantRow[],
  actionRows: readonly ActionRow[],
  voteRows: readonly VoteRow[],
): QueryAggregate {
  const scenario = hydrateScenario(room);
  return {
    queryId: room.queryId,
    createdByPlayerId: room.createdByPlayerId,
    gameplayReleaseId: room.gameplayReleaseId,
    phase: room.phase,
    version: Number(room.aggregateVersion),
    createdAt: room.createdAt.getTime(),
    deadline: room.deadline?.getTime() ?? null,
    explorationStartedAt: room.explorationStartedAt?.getTime() ?? null,
    scenario,
    participants: participantRows.map(({ playerId, joinedAt }) => ({
      playerId,
      joinedAt: joinedAt.getTime(),
    })),
    actions: actionRows.map((row) => ({
      playerId: row.playerId,
      siteId: row.siteId,
      acceptedAt: row.acceptedAt.getTime(),
      card: hydrateCard(row),
    })),
    votes: voteRows.map(({ playerId, choice }) => ({ playerId, choice })),
    selectedChoice: room.selectedChoice,
  };
}

function hydrateScenario(room: QueryRoomRow): QueryScenario | null {
  if (
    room.scenarioVariantId === null ||
    room.randomSeed === null ||
    room.correctChoice === null
  ) {
    if (
      room.scenarioVariantId !== null ||
      room.randomSeed !== null ||
      room.correctChoice !== null
    ) {
      throw new Error("Persisted query scenario is incomplete");
    }
    return null;
  }
  return {
    variantId: room.scenarioVariantId,
    randomSeed: new TextDecoder("utf-8", { fatal: true }).decode(
      room.randomSeed,
    ),
    correctChoice: room.correctChoice,
  };
}

function hydrateCard(row: ActionRow): PrivateEvidenceCard {
  return {
    cardId: row.cardId,
    playerId: row.playerId,
    siteId: row.siteId,
    text: row.evidenceText,
    isTruth: row.isTruth,
  };
}
