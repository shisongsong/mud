import type { BoardDelta, BoardFactionId } from "../board/public.ts";

export type QueryPhase =
  | "waiting"
  | "exploring"
  | "voting"
  | "settling"
  | "settlement_failed"
  | "completed"
  | "cancelled";

export type QuerySite = "site_1" | "site_2" | "site_3";
export type QueryChoice = "choice_1" | "choice_2";
export type QueryVote = QueryChoice | "abstain";

export interface QueryScenario {
  readonly variantId: string;
  readonly randomSeed: string;
  readonly correctChoice: QueryChoice;
}

export interface PrivateEvidenceCard {
  readonly cardId: string;
  readonly playerId: string;
  readonly siteId: QuerySite;
  readonly text: string;
  readonly isTruth: boolean;
}

interface QueryAction {
  readonly playerId: string;
  readonly siteId: QuerySite;
  readonly card: PrivateEvidenceCard;
  readonly acceptedAt: number;
}

interface QueryParticipant {
  readonly playerId: string;
  readonly factionId: BoardFactionId;
  readonly joinedAt: number;
}

export interface SettlementPlan {
  readonly settlementId: string;
  readonly targets: readonly string[];
  readonly boardDelta: BoardDelta;
  readonly pointAwards: readonly {
    readonly playerId: string;
    readonly requestedDelta: number;
  }[];
}

export interface SettlementConfirmation {
  readonly effectKey: string;
  readonly resultReference: string;
}

export interface QueryAggregate {
  readonly queryId: string;
  readonly createdByPlayerId: string;
  readonly gameplayReleaseId: string;
  readonly phase: QueryPhase;
  readonly version: number;
  readonly createdAt: number;
  readonly deadline: number | null;
  readonly explorationStartedAt: number | null;
  readonly scenario: QueryScenario | null;
  readonly participants: readonly QueryParticipant[];
  readonly actions: readonly QueryAction[];
  readonly votes: readonly {
    readonly playerId: string;
    readonly choice: QueryVote;
  }[];
  readonly selectedChoice: QueryChoice | null;
  readonly settlementPlan: SettlementPlan | null;
}

export interface AuthorizedQueryView {
  readonly queryId: string;
  readonly phase: QueryPhase;
  readonly version: number;
  readonly deadline: number | null;
  readonly gameplayReleaseId: string;
  readonly participantCount: number;
  readonly ownActionsUsed: number;
  readonly ownVote: QueryVote | null;
  readonly ownEvidenceCards: readonly {
    readonly cardId: string;
    readonly siteId: QuerySite;
    readonly text: string;
  }[];
}

const MAX_PARTICIPANTS = 4;
const MAX_ACTIONS_PER_PLAYER = 2;
const WAITING_DURATION_MS = 5 * 60 * 1000;
const EXPLORATION_DURATION_MS = 120 * 1000;
const VOTING_DURATION_MS = 60 * 1000;

export class QueryRuleError extends Error {
  constructor(
    readonly code:
      | "QUERY_FULL"
      | "QUERY_ALREADY_STARTED"
      | "QUERY_NOT_WAITING"
      | "QUERY_NOT_EXPLORING"
      | "QUERY_NOT_VOTING"
      | "QUERY_NOT_MEMBER"
      | "QUERY_ALREADY_MEMBER"
      | "QUERY_EXPIRED"
      | "ACTION_LIMIT_REACHED"
      | "SITE_ALREADY_INSPECTED"
      | "INVALID_EXPECTED_VERSION"
      | "INVALID_SCENARIO"
      | "QUERY_NOT_FOUND"
      | "QUERY_NOT_SETTLING"
      | "SETTLEMENT_INCOMPLETE"
      | "SETTLEMENT_PLAN_MISMATCH",
  ) {
    super(code);
    this.name = "QueryRuleError";
  }
}

export function createQuery(
  queryId: string,
  creatorPlayerId: string,
  gameplayReleaseId: string,
  now: number,
  creatorFactionId: BoardFactionId,
): QueryAggregate {
  requireText(queryId, "queryId");
  requireText(creatorPlayerId, "creatorPlayerId");
  requireText(gameplayReleaseId, "gameplayReleaseId");
  requireTimestamp(now);
  requireFactionId(creatorFactionId);

  return {
    queryId,
    createdByPlayerId: creatorPlayerId,
    gameplayReleaseId,
    phase: "waiting",
    version: 1,
    createdAt: now,
    deadline: now + WAITING_DURATION_MS,
    explorationStartedAt: null,
    scenario: null,
    participants: [
      { playerId: creatorPlayerId, factionId: creatorFactionId, joinedAt: now },
    ],
    actions: [],
    votes: [],
    selectedChoice: null,
    settlementPlan: null,
  };
}

export function joinQuery(
  query: QueryAggregate,
  playerId: string,
  now: number,
  createScenario: () => QueryScenario,
  factionId: BoardFactionId,
): QueryAggregate {
  requireTimestamp(now);
  requireFactionId(factionId);
  if (query.phase !== "waiting") throw new QueryRuleError("QUERY_NOT_WAITING");
  if (query.deadline === null || now >= query.deadline) {
    throw new QueryRuleError("QUERY_EXPIRED");
  }
  if (
    query.participants.some((participant) => participant.playerId === playerId)
  ) {
    throw new QueryRuleError("QUERY_ALREADY_MEMBER");
  }
  if (query.participants.length >= MAX_PARTICIPANTS) {
    throw new QueryRuleError("QUERY_FULL");
  }

  const participants = [
    ...query.participants,
    { playerId, factionId, joinedAt: now },
  ];
  if (participants.length < MAX_PARTICIPANTS) {
    return { ...query, participants, version: query.version + 1 };
  }

  const scenario = createScenario();
  validateScenario(scenario);
  return {
    ...query,
    phase: "exploring",
    participants,
    version: query.version + 1,
    deadline: now + EXPLORATION_DURATION_MS,
    explorationStartedAt: now,
    scenario,
  };
}

export function leaveQuery(
  query: QueryAggregate,
  playerId: string,
  expectedVersion: number,
  now: number,
): QueryAggregate {
  requireTimestamp(now);
  if (query.phase !== "waiting") {
    throw new QueryRuleError("QUERY_ALREADY_STARTED");
  }
  if (query.version !== expectedVersion) {
    throw new QueryRuleError("INVALID_EXPECTED_VERSION");
  }
  if (query.deadline === null || now >= query.deadline) {
    throw new QueryRuleError("QUERY_EXPIRED");
  }
  if (
    !query.participants.some((participant) => participant.playerId === playerId)
  ) {
    throw new QueryRuleError("QUERY_NOT_MEMBER");
  }

  const participants = query.participants.filter(
    (participant) => participant.playerId !== playerId,
  );
  return {
    ...query,
    phase: participants.length === 0 ? "cancelled" : query.phase,
    participants,
    version: query.version + 1,
    deadline: participants.length === 0 ? null : query.deadline,
  };
}

/**
 * Validates every inspect rule without producing evidence. Callers that need
 * to resolve evidence from storage should call this first so rule violations
 * are reported before any lookup.
 */
export function assertCanInspect(
  query: QueryAggregate,
  playerId: string,
  siteId: QuerySite,
  now: number,
): void {
  requireTimestamp(now);
  if (query.phase !== "exploring") {
    throw new QueryRuleError("QUERY_NOT_EXPLORING");
  }
  if (query.deadline === null || now >= query.deadline) {
    throw new QueryRuleError("QUERY_EXPIRED");
  }
  requireParticipant(query, playerId);

  const playerActions = query.actions.filter(
    (action) => action.playerId === playerId,
  );
  if (playerActions.some((action) => action.siteId === siteId)) {
    throw new QueryRuleError("SITE_ALREADY_INSPECTED");
  }
  if (playerActions.length >= MAX_ACTIONS_PER_PLAYER) {
    throw new QueryRuleError("ACTION_LIMIT_REACHED");
  }
}

export function inspectQuery(
  query: QueryAggregate,
  playerId: string,
  siteId: QuerySite,
  now: number,
  createEvidence: () => PrivateEvidenceCard,
): QueryAggregate {
  assertCanInspect(query, playerId, siteId, now);

  const card = createEvidence();
  if (
    card.playerId !== playerId ||
    card.siteId !== siteId ||
    card.cardId.trim().length === 0 ||
    card.text.trim().length === 0
  ) {
    throw new QueryRuleError("INVALID_SCENARIO");
  }

  return {
    ...query,
    actions: [...query.actions, { playerId, siteId, card, acceptedAt: now }],
    version: query.version + 1,
  };
}

export function castVote(
  query: QueryAggregate,
  playerId: string,
  choice: QueryVote,
  expectedVersion: number,
  now: number,
): QueryAggregate {
  requireTimestamp(now);
  if (query.phase !== "voting") throw new QueryRuleError("QUERY_NOT_VOTING");
  if (query.version !== expectedVersion) {
    throw new QueryRuleError("INVALID_EXPECTED_VERSION");
  }
  if (query.deadline === null || now >= query.deadline) {
    throw new QueryRuleError("QUERY_EXPIRED");
  }
  requireParticipant(query, playerId);

  const votes = query.votes.filter((vote) => vote.playerId !== playerId);
  votes.push({ playerId, choice });
  return { ...query, votes, version: query.version + 1 };
}

export function advanceQuery(
  query: QueryAggregate,
  now: number,
): QueryAggregate {
  requireTimestamp(now);
  if (query.deadline === null || now < query.deadline) return query;

  if (query.phase === "waiting") {
    return {
      ...query,
      phase: "cancelled",
      deadline: null,
      version: query.version + 1,
    };
  }
  if (query.phase === "exploring") {
    const explorationStartedAt = query.explorationStartedAt;
    if (explorationStartedAt === null) {
      throw new QueryRuleError("INVALID_SCENARIO");
    }
    const votingDeadline =
      explorationStartedAt + EXPLORATION_DURATION_MS + VOTING_DURATION_MS;
    return {
      ...query,
      phase: "voting",
      deadline: votingDeadline,
      version: query.version + 1,
    };
  }
  if (query.phase === "voting") {
    const settling = resolveVote({
      ...query,
      phase: "settling",
      deadline: null,
      version: query.version + 1,
    });
    return { ...settling, settlementPlan: buildSettlementPlan(settling) };
  }

  return query;
}

export function finalizeSettlement(
  query: QueryAggregate,
  confirmations: readonly SettlementConfirmation[],
): QueryAggregate {
  if (query.phase !== "settling") {
    throw new QueryRuleError("QUERY_NOT_SETTLING");
  }
  if (query.settlementPlan === null) {
    throw new QueryRuleError("SETTLEMENT_PLAN_MISMATCH");
  }

  const planned = new Set(query.settlementPlan.targets);
  const confirmed = new Set(confirmations.map(({ effectKey }) => effectKey));
  if (
    confirmed.size !== confirmations.length ||
    confirmations.some(
      ({ effectKey, resultReference }) =>
        effectKey.trim().length === 0 ||
        resultReference.trim().length === 0 ||
        resultReference.length > 512,
    )
  ) {
    throw new QueryRuleError("SETTLEMENT_PLAN_MISMATCH");
  }
  if ([...confirmed].some((key) => !planned.has(key))) {
    throw new QueryRuleError("SETTLEMENT_PLAN_MISMATCH");
  }
  if ([...planned].some((key) => !confirmed.has(key))) {
    throw new QueryRuleError("SETTLEMENT_INCOMPLETE");
  }

  return { ...query, phase: "completed", version: query.version + 1 };
}

export function getAuthorizedQueryView(
  query: QueryAggregate,
  playerId: string,
): AuthorizedQueryView {
  requireParticipant(query, playerId);
  const ownActions = query.actions.filter(
    (action) => action.playerId === playerId,
  );
  const ownVote = query.votes.find((vote) => vote.playerId === playerId);

  return {
    queryId: query.queryId,
    phase: query.phase,
    version: query.version,
    deadline: query.deadline,
    gameplayReleaseId: query.gameplayReleaseId,
    participantCount: query.participants.length,
    ownActionsUsed: ownActions.length,
    ownVote: ownVote?.choice ?? null,
    ownEvidenceCards: ownActions.map(({ card }) => ({
      cardId: card.cardId,
      siteId: card.siteId,
      text: card.text,
    })),
  };
}

// Fixed at resolution so retries reuse the same targets and never re-roll them.
function buildSettlementPlan(query: QueryAggregate): SettlementPlan {
  const targets = [
    `board:${query.queryId}`,
    ...query.participants.map(
      ({ playerId }) => `points:${query.queryId}:${playerId}`,
    ),
    ...query.actions.map(
      ({ card }) => `knowledge:${query.queryId}:${card.cardId}`,
    ),
  ].sort();
  const pointAwards = query.participants
    .map(({ playerId }) => {
      const participated =
        query.actions.some((action) => action.playerId === playerId) ||
        query.votes.some((vote) => vote.playerId === playerId);
      const votedCorrectly = query.votes.some(
        (vote) =>
          vote.playerId === playerId &&
          vote.choice !== "abstain" &&
          vote.choice === query.scenario?.correctChoice,
      );
      return {
        playerId,
        requestedDelta: (participated ? 5 : 0) + (votedCorrectly ? 20 : 0),
      };
    })
    .sort((left, right) =>
      left.playerId < right.playerId
        ? -1
        : left.playerId > right.playerId
          ? 1
          : 0,
    );
  const correctChoice = query.scenario?.correctChoice;
  if (correctChoice === undefined) {
    throw new QueryRuleError("INVALID_SCENARIO");
  }
  const activeFactions = new Set(
    query.participants
      .filter(
        ({ playerId }) =>
          query.actions.some((action) => action.playerId === playerId) ||
          query.votes.some((vote) => vote.playerId === playerId),
      )
      .map(({ factionId }) => factionId),
  );
  const factionDeltas: Partial<Record<BoardFactionId, number>> = {};
  for (const factionId of activeFactions) factionDeltas[factionId] = 1;
  return {
    settlementId: `settlement:${query.queryId}`,
    targets,
    boardDelta: {
      tensionDelta:
        query.selectedChoice === null
          ? 1
          : query.selectedChoice === correctChoice
            ? -2
            : 2,
      factionDeltas,
    },
    pointAwards,
  };
}

function requireFactionId(
  factionId: string,
): asserts factionId is BoardFactionId {
  if (
    ![
      "faction_1",
      "faction_2",
      "faction_3",
      "faction_4",
      "faction_5",
      "faction_6",
    ].includes(factionId)
  ) {
    throw new QueryRuleError("INVALID_SCENARIO");
  }
}

function resolveVote(query: QueryAggregate): QueryAggregate {
  if (query.scenario === null) throw new QueryRuleError("INVALID_SCENARIO");
  const counts: Record<QueryChoice, number> = { choice_1: 0, choice_2: 0 };
  for (const vote of query.votes) {
    if (vote.choice !== "abstain") counts[vote.choice] += 1;
  }

  const selectedChoice =
    counts.choice_1 === 0 && counts.choice_2 === 0
      ? null
      : counts.choice_1 >= counts.choice_2
        ? "choice_1"
        : "choice_2";
  return { ...query, selectedChoice };
}

function validateScenario(scenario: QueryScenario): void {
  const seedByteLength = new TextEncoder().encode(scenario.randomSeed).length;
  if (
    scenario.variantId.trim().length === 0 ||
    scenario.randomSeed.trim().length === 0 ||
    seedByteLength > 64 ||
    (scenario.correctChoice !== "choice_1" &&
      scenario.correctChoice !== "choice_2")
  ) {
    throw new QueryRuleError("INVALID_SCENARIO");
  }
}

function requireParticipant(query: QueryAggregate, playerId: string): void {
  if (
    !query.participants.some((participant) => participant.playerId === playerId)
  ) {
    throw new QueryRuleError("QUERY_NOT_MEMBER");
  }
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} is required`);
}

function requireTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Timestamp must be a non-negative safe integer");
  }
}
