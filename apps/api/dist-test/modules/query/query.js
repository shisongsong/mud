const MAX_PARTICIPANTS = 4;
const MAX_ACTIONS_PER_PLAYER = 2;
const WAITING_DURATION_MS = 5 * 60 * 1000;
const EXPLORATION_DURATION_MS = 120 * 1000;
const VOTING_DURATION_MS = 60 * 1000;
export class QueryRuleError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = "QueryRuleError";
    }
}
export function createQuery(queryId, creatorPlayerId, gameplayReleaseId, now) {
    requireText(queryId, "queryId");
    requireText(creatorPlayerId, "creatorPlayerId");
    requireText(gameplayReleaseId, "gameplayReleaseId");
    requireTimestamp(now);
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
        participants: [{ playerId: creatorPlayerId, joinedAt: now }],
        actions: [],
        votes: [],
        selectedChoice: null,
        settlementPlan: null,
    };
}
export function joinQuery(query, playerId, now, createScenario) {
    requireTimestamp(now);
    if (query.phase !== "waiting")
        throw new QueryRuleError("QUERY_NOT_WAITING");
    if (query.deadline === null || now >= query.deadline) {
        throw new QueryRuleError("QUERY_EXPIRED");
    }
    if (query.participants.some((participant) => participant.playerId === playerId)) {
        throw new QueryRuleError("QUERY_ALREADY_MEMBER");
    }
    if (query.participants.length >= MAX_PARTICIPANTS) {
        throw new QueryRuleError("QUERY_FULL");
    }
    const participants = [...query.participants, { playerId, joinedAt: now }];
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
export function leaveQuery(query, playerId, expectedVersion, now) {
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
    if (!query.participants.some((participant) => participant.playerId === playerId)) {
        throw new QueryRuleError("QUERY_NOT_MEMBER");
    }
    const participants = query.participants.filter((participant) => participant.playerId !== playerId);
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
export function assertCanInspect(query, playerId, siteId, now) {
    requireTimestamp(now);
    if (query.phase !== "exploring") {
        throw new QueryRuleError("QUERY_NOT_EXPLORING");
    }
    if (query.deadline === null || now >= query.deadline) {
        throw new QueryRuleError("QUERY_EXPIRED");
    }
    requireParticipant(query, playerId);
    const playerActions = query.actions.filter((action) => action.playerId === playerId);
    if (playerActions.some((action) => action.siteId === siteId)) {
        throw new QueryRuleError("SITE_ALREADY_INSPECTED");
    }
    if (playerActions.length >= MAX_ACTIONS_PER_PLAYER) {
        throw new QueryRuleError("ACTION_LIMIT_REACHED");
    }
}
export function inspectQuery(query, playerId, siteId, now, createEvidence) {
    assertCanInspect(query, playerId, siteId, now);
    const card = createEvidence();
    if (card.playerId !== playerId ||
        card.siteId !== siteId ||
        card.cardId.trim().length === 0 ||
        card.text.trim().length === 0) {
        throw new QueryRuleError("INVALID_SCENARIO");
    }
    return {
        ...query,
        actions: [...query.actions, { playerId, siteId, card, acceptedAt: now }],
        version: query.version + 1,
    };
}
export function castVote(query, playerId, choice, expectedVersion, now) {
    requireTimestamp(now);
    if (query.phase !== "voting")
        throw new QueryRuleError("QUERY_NOT_VOTING");
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
export function advanceQuery(query, now) {
    requireTimestamp(now);
    if (query.deadline === null || now < query.deadline)
        return query;
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
        const votingDeadline = explorationStartedAt + EXPLORATION_DURATION_MS + VOTING_DURATION_MS;
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
export function finalizeSettlement(query, confirmedEffectKeys) {
    if (query.phase !== "settling") {
        throw new QueryRuleError("QUERY_NOT_SETTLING");
    }
    if (query.settlementPlan === null) {
        throw new QueryRuleError("SETTLEMENT_PLAN_MISMATCH");
    }
    const planned = new Set(query.settlementPlan.targets);
    const confirmed = new Set(confirmedEffectKeys);
    if ([...confirmed].some((key) => !planned.has(key))) {
        throw new QueryRuleError("SETTLEMENT_PLAN_MISMATCH");
    }
    if ([...planned].some((key) => !confirmed.has(key))) {
        throw new QueryRuleError("SETTLEMENT_INCOMPLETE");
    }
    return { ...query, phase: "completed", version: query.version + 1 };
}
export function getAuthorizedQueryView(query, playerId) {
    requireParticipant(query, playerId);
    const ownActions = query.actions.filter((action) => action.playerId === playerId);
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
function buildSettlementPlan(query) {
    const targets = [
        `board:${query.queryId}`,
        ...query.participants.map(({ playerId }) => `points:${query.queryId}:${playerId}`),
        ...query.actions.map(({ card }) => `knowledge:${query.queryId}:${card.cardId}`),
    ].sort();
    return { settlementId: `settlement:${query.queryId}`, targets };
}
function resolveVote(query) {
    if (query.scenario === null)
        throw new QueryRuleError("INVALID_SCENARIO");
    const counts = { choice_1: 0, choice_2: 0 };
    for (const vote of query.votes) {
        if (vote.choice !== "abstain")
            counts[vote.choice] += 1;
    }
    const selectedChoice = counts.choice_1 === 0 && counts.choice_2 === 0
        ? null
        : counts.choice_1 >= counts.choice_2
            ? "choice_1"
            : "choice_2";
    return { ...query, selectedChoice };
}
function validateScenario(scenario) {
    const seedByteLength = new TextEncoder().encode(scenario.randomSeed).length;
    if (scenario.variantId.trim().length === 0 ||
        scenario.randomSeed.trim().length === 0 ||
        seedByteLength > 64 ||
        (scenario.correctChoice !== "choice_1" &&
            scenario.correctChoice !== "choice_2")) {
        throw new QueryRuleError("INVALID_SCENARIO");
    }
}
function requireParticipant(query, playerId) {
    if (!query.participants.some((participant) => participant.playerId === playerId)) {
        throw new QueryRuleError("QUERY_NOT_MEMBER");
    }
}
function requireText(value, field) {
    if (value.trim().length === 0)
        throw new TypeError(`${field} is required`);
}
function requireTimestamp(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("Timestamp must be a non-negative safe integer");
    }
}
