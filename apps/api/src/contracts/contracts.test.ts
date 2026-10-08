import assert from "node:assert/strict";
import { test } from "node:test";
import { actorSchema } from "../kernel/actor.ts";
import { commandMetadataSchema, idempotencyKeySchema } from "./command.ts";
import { apiErrorSchema } from "./errors.ts";
import { eventEnvelopeSchema } from "./event.ts";
import {
  adminSagaListRequestSchema,
  boardSnapshotResponseSchema,
  createQueryRequestSchema,
  createQueryResponseSchema,
  createPlayerRequestSchema,
  loginRequestSchema,
  leaderboardResponseSchema,
  mfaConfirmRequestSchema,
  moderationRequestSchema,
  notificationListResponseSchema,
  querySnapshotResponseSchema,
  registerAccountRequestSchema,
  reportAcceptedResponseSchema,
  sessionViewSchema,
  spreadOperationResponseSchema,
  spreadRequestSchema,
} from "./http.ts";
import { clientWebSocketMessageSchema } from "./websocket.ts";

const validEvent = {
  eventId: "11111111-1111-4111-8111-111111111111",
  type: "AccountRegistered",
  schemaVersion: 1,
  source: "identity",
  aggregateId: "22222222-2222-4222-8222-222222222222",
  aggregateVersion: 1,
  streamId: "33333333-3333-4333-8333-333333333333",
  sequence: 1,
  releaseVersion: null,
  occurredAt: "2026-09-30T12:00:00.000Z",
  traceId: "44444444-4444-4444-8444-444444444444",
  correlationId: "55555555-5555-4555-8555-555555555555",
  causationId: null,
  rootEventId: "11111111-1111-4111-8111-111111111111",
  depth: 0,
  payload: { accountId: "66666666-6666-4666-8666-666666666666" },
};

test("event envelope accepts non-gameplay null release and rejects extra fields", () => {
  assert.equal(eventEnvelopeSchema.safeParse(validEvent).success, true);
  assert.equal(
    eventEnvelopeSchema.safeParse({ ...validEvent, passwordHash: "secret" })
      .success,
    false,
  );
});

test("actor schema rejects client-injected or unknown authority fields", () => {
  const actor = {
    kind: "player",
    accountId: "11111111-1111-4111-8111-111111111111",
    playerId: "22222222-2222-4222-8222-222222222222",
  };

  assert.equal(actorSchema.safeParse(actor).success, true);
  assert.equal(
    actorSchema.safeParse({
      kind: "account",
      accountId: "11111111-1111-4111-8111-111111111111",
    }).success,
    true,
  );
  assert.equal(
    actorSchema.safeParse({ ...actor, role: "admin" }).success,
    false,
  );
});

test("trusted command metadata is strict", () => {
  const metadata = {
    commandId: "11111111-1111-4111-8111-111111111111",
    actor: {
      kind: "player",
      accountId: "22222222-2222-4222-8222-222222222222",
      playerId: "33333333-3333-4333-8333-333333333333",
    },
    traceId: "44444444-4444-4444-8444-444444444444",
    idempotencyKey: "abcdefgh12345678",
    expectedVersion: 1,
  };

  assert.equal(commandMetadataSchema.safeParse(metadata).success, true);
  assert.equal(
    idempotencyKeySchema.safeParse("abcdefgh12345678").success,
    true,
  );
  assert.equal(idempotencyKeySchema.safeParse("short").success, false);
  assert.equal(
    idempotencyKeySchema.safeParse("contains space 123").success,
    false,
  );
  assert.equal(
    commandMetadataSchema.safeParse({ ...metadata, isAdmin: true }).success,
    false,
  );
});

test("WebSocket contract rejects business-write message types", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";

  assert.equal(
    clientWebSocketMessageSchema.safeParse({
      requestId,
      schemaVersion: 1,
      type: "Ping",
      payload: {},
    }).success,
    true,
  );
  assert.equal(
    clientWebSocketMessageSchema.safeParse({
      requestId,
      schemaVersion: 1,
      type: "CastVote",
      payload: { choiceId: "choice_1" },
    }).success,
    false,
  );
});

test("API errors accept only safe public fields", () => {
  const error = {
    code: "AUTH_INVALID_CREDENTIALS",
    messageKey: "auth.invalidCredentials",
    args: {},
    traceId: "11111111-1111-4111-8111-111111111111",
  };

  assert.equal(apiErrorSchema.safeParse(error).success, true);
  assert.equal(
    apiErrorSchema.safeParse({ ...error, stack: "private" }).success,
    false,
  );
});

test("HTTP schemas reject forged fields and duplicate recipients", () => {
  const player = {
    displayName: "Ada",
    factionId: "faction_1",
    powerId: "power_1",
    professionId: "profession_1",
    gameplayReleaseId: "gameplay_v1",
  };
  assert.equal(createPlayerRequestSchema.safeParse(player).success, true);
  assert.equal(
    createPlayerRequestSchema.safeParse({ ...player, playerId: "forged" })
      .success,
    false,
  );

  const spread = {
    scriptId: "script_1",
    mode: "directed",
    recipientIds: ["player_1", "player_1"],
  };
  assert.equal(spreadRequestSchema.safeParse(spread).success, false);
});

test("auth contracts enforce credential limits and session authority shape", () => {
  const credentials = { username: "Player_01", password: "twelve_chars" };
  assert.equal(registerAccountRequestSchema.safeParse(credentials).success, true);
  assert.equal(loginRequestSchema.safeParse(credentials).success, true);
  assert.equal(
    registerAccountRequestSchema.safeParse({ ...credentials, role: "admin" })
      .success,
    false,
  );
  assert.equal(
    registerAccountRequestSchema.safeParse({
      username: "ab",
      password: credentials.password,
    }).success,
    false,
  );
  assert.equal(
    registerAccountRequestSchema.safeParse({
      username: credentials.username,
      password: "short",
    }).success,
    false,
  );
  assert.equal(
    registerAccountRequestSchema.safeParse({
      username: credentials.username,
      password: "😀".repeat(129),
    }).success,
    false,
  );

  const anonymousSession = {
    authenticated: false,
    expiresAt: "2026-10-08T12:00:00.000Z",
    csrfToken: "A".repeat(43),
    mfaRequired: false,
  };
  assert.equal(sessionViewSchema.safeParse(anonymousSession).success, true);
  assert.equal(
    sessionViewSchema.safeParse({
      ...anonymousSession,
      authenticated: true,
    }).success,
    false,
  );
});

test("display name length counts Unicode code points", () => {
  const player = {
    displayName: "😀😀",
    factionId: "faction_1",
    powerId: "power_1",
    professionId: "profession_1",
    gameplayReleaseId: "gameplay_v1",
  };

  assert.equal(createPlayerRequestSchema.safeParse(player).success, true);
});

test("create-query contract pins the supported template and minimal response", () => {
  assert.equal(
    createQueryRequestSchema.safeParse({
      templateId: "trial_1",
      gameplayReleaseId: "gameplay_v1",
    }).success,
    true,
  );
  assert.equal(
    createQueryRequestSchema.safeParse({
      templateId: "trial_2",
      gameplayReleaseId: "gameplay_v1",
    }).success,
    false,
  );
  assert.equal(
    createQueryResponseSchema.safeParse({
      queryId: "11111111-1111-4111-8111-111111111111",
      aggregateVersion: 1,
    }).success,
    true,
  );
  assert.equal(
    createQueryResponseSchema.safeParse({
      queryId: "11111111-1111-4111-8111-111111111111",
      aggregateVersion: 1,
      correctChoice: "choice_1",
    }).success,
    false,
  );
});

test("remaining HTTP contracts validate safe requests and public responses", () => {
  assert.equal(
    adminSagaListRequestSchema.safeParse({ status: "running", limit: "10" })
      .success,
    true,
  );
  assert.equal(
    mfaConfirmRequestSchema.safeParse({ code: "123456" }).success,
    true,
  );
  assert.equal(
    mfaConfirmRequestSchema.safeParse({ code: "12345x" }).success,
    false,
  );
  assert.equal(
    moderationRequestSchema.safeParse({
      action: "unmute",
      reason: "reviewed",
      until: "2026-09-30T12:00:00Z",
    }).success,
    false,
  );
  assert.equal(
    reportAcceptedResponseSchema.safeParse({
      reportId: "report_1",
      status: "accepted",
      targetId: "must-not-leak",
    }).success,
    false,
  );
  assert.equal(
    leaderboardResponseSchema.safeParse({
      items: [
        {
          playerId: "player_1",
          displayName: "Ada",
          score: 100,
          rank: "bronze",
        },
      ],
      nextCursor: null,
      boardVersion: 1,
      serverTime: "2026-09-30T12:00:00.000Z",
    }).success,
    true,
  );
  assert.equal(
    notificationListResponseSchema.safeParse({
      items: [],
      nextCursor: null,
      serverTime: "2026-09-30T12:00:00.000Z",
      accountId: "must-not-leak",
    }).success,
    false,
  );
});

test("query, spread, and board responses enforce privacy and invariants", () => {
  const querySnapshot = {
    queryId: "query_1",
    phase: "exploring",
    deadline: "2026-09-30T12:02:00.000Z",
    serverTime: "2026-09-30T12:01:00.000Z",
    gameplayReleaseId: "gameplay_v1",
    aggregateVersion: 4,
    participants: [{ displayName: "Ada", isSelf: true }],
    self: {
      actionsUsed: 1,
      voteChoice: null,
      evidenceCards: [{ cardId: "card_1", siteId: "site_1", text: "A clue" }],
    },
  };

  assert.equal(
    querySnapshotResponseSchema.safeParse(querySnapshot).success,
    true,
  );
  assert.equal(
    querySnapshotResponseSchema.safeParse({
      ...querySnapshot,
      participants: [{ displayName: "Ada", isSelf: false }],
    }).success,
    false,
  );
  assert.equal(
    querySnapshotResponseSchema.safeParse({
      ...querySnapshot,
      self: {
        ...querySnapshot.self,
        evidenceCards: [
          { ...querySnapshot.self.evidenceCards[0], isTruth: true },
        ],
      },
    }).success,
    false,
  );
  assert.equal(
    spreadOperationResponseSchema.safeParse({
      operationId: "operation_1",
      status: "completed",
      total: 3,
      granted: 2,
      skipped: 1,
      pending: 1,
    }).success,
    false,
  );

  const factions = [1, 2, 3, 4, 5, 6].map((id) => ({
    factionId: `faction_${id}`,
    strength: 50,
  }));
  const board = {
    boardVersion: 2,
    tension: 50,
    factions,
    updatedAt: "2026-09-30T12:00:00.000Z",
    serverTime: "2026-09-30T12:00:00.000Z",
  };

  assert.equal(boardSnapshotResponseSchema.safeParse(board).success, true);
  assert.equal(
    boardSnapshotResponseSchema.safeParse({
      ...board,
      factions: [...factions.slice(0, 5), factions[0]],
    }).success,
    false,
  );
});
