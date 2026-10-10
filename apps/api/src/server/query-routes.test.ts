import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { QuerySnapshotResponse } from "../contracts/http.ts";
import type { PlayerActor } from "../kernel/actor.ts";
import { QueryRuleError } from "../modules/query/public.ts";
import type { QueryCreationCommand, QueryViewReader } from "./query-routes.ts";
import { registerQueryRoutes } from "./query-routes.ts";

const QUERY_ID = "33333333-3333-4333-8333-333333333333";
const KEY = "inspect-key-0000001";
const actor: PlayerActor = {
  kind: "player",
  accountId: "11111111-1111-4111-8111-111111111111",
  playerId: "22222222-2222-4222-8222-222222222222",
};

interface InspectCall {
  readonly actorPlayerId: string;
  readonly queryId: string;
  readonly input: unknown;
  readonly idempotencyKey: string;
}

function buildApp(options: {
  readonly authenticated?: boolean;
  readonly inspectError?: Error;
  readonly views?: QueryViewReader;
  readonly inspectCalls?: InspectCall[];
}) {
  const app = Fastify();
  const commands: QueryCreationCommand = {
    create: async () => {
      throw new Error("create is not exercised by these tests");
    },
    inspect: async (callActor, queryId, input, idempotencyKey) => {
      options.inspectCalls?.push({
        actorPlayerId: callActor.playerId,
        queryId,
        input,
        idempotencyKey,
      });
      if (options.inspectError) {
        throw options.inspectError;
      }
      return {
        result: { resourceId: QUERY_ID, aggregateVersion: 3 },
        replayed: false,
      };
    },
  };
  registerQueryRoutes(app, {
    commands,
    ...(options.views ? { views: options.views } : {}),
    authenticatePlayer: async () =>
      options.authenticated === false ? null : actor,
  });
  return app;
}

function inspectRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = { "idempotency-key": KEY },
) {
  return {
    method: "POST" as const,
    url: `/query/${QUERY_ID}/inspect`,
    headers,
    payload: body,
  };
}

test("inspect route passes the parsed action and key to the command and returns the receipt", async () => {
  const calls: InspectCall[] = [];
  const app = buildApp({ inspectCalls: calls });
  try {
    const response = await app.inject(
      inspectRequest({ actionType: "inspect", siteId: "site_1" }),
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      resourceId: QUERY_ID,
      aggregateVersion: 3,
    });
    assert.deepEqual(calls, [
      {
        actorPlayerId: actor.playerId,
        queryId: QUERY_ID,
        input: { actionType: "inspect", siteId: "site_1" },
        idempotencyKey: KEY,
      },
    ]);
  } finally {
    await app.close();
  }
});

test("inspect route rejects unauthenticated callers before reading the body", async () => {
  const calls: InspectCall[] = [];
  const app = buildApp({ authenticated: false, inspectCalls: calls });
  try {
    const response = await app.inject(
      inspectRequest({ actionType: "inspect", siteId: "site_1" }),
    );
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, "UNAUTHENTICATED");
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test("inspect route rejects invalid bodies, unknown sites, and missing keys", async () => {
  const calls: InspectCall[] = [];
  const app = buildApp({ inspectCalls: calls });
  try {
    const unknownSite = await app.inject(
      inspectRequest({ actionType: "inspect", siteId: "site_9" }),
    );
    assert.equal(unknownSite.statusCode, 400);
    assert.equal(unknownSite.json().code, "INVALID_REQUEST");

    const extraField = await app.inject(
      inspectRequest({ actionType: "inspect", siteId: "site_1", text: "x" }),
    );
    assert.equal(extraField.statusCode, 400);

    const missingKey = await app.inject(
      inspectRequest({ actionType: "inspect", siteId: "site_1" }, {}),
    );
    assert.equal(missingKey.statusCode, 400);
    assert.equal(missingKey.json().code, "INVALID_REQUEST");
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

const ruleErrorCases: readonly [code: string, status: number, body: string][] =
  [
    ["QUERY_NOT_EXPLORING", 409, "QUERY_CONFLICT"],
    ["QUERY_EXPIRED", 409, "QUERY_CONFLICT"],
    ["SITE_ALREADY_INSPECTED", 409, "QUERY_CONFLICT"],
    ["ACTION_LIMIT_REACHED", 409, "QUERY_CONFLICT"],
    ["INVALID_SCENARIO", 409, "QUERY_CONFLICT"],
    ["QUERY_NOT_MEMBER", 404, "NOT_FOUND"],
  ];

for (const [code, status, body] of ruleErrorCases) {
  test(`inspect route maps QueryRuleError ${code} to ${status} ${body}`, async () => {
    const app = buildApp({
      inspectError: new QueryRuleError(code as QueryRuleError["code"]),
    });
    try {
      const response = await app.inject(
        inspectRequest({ actionType: "inspect", siteId: "site_1" }),
      );
      assert.equal(response.statusCode, status);
      assert.equal(response.json().code, body);
    } finally {
      await app.close();
    }
  });
}

test("inspect route reports unexpected failures as 500 without leaking details", async () => {
  const app = buildApp({
    inspectError: new Error("Pinned gameplay release has no evidence for site"),
  });
  try {
    const response = await app.inject(
      inspectRequest({ actionType: "inspect", siteId: "site_1" }),
    );
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().code, "INTERNAL_ERROR");
    assert.doesNotMatch(response.body, /pinned gameplay/i);
  } finally {
    await app.close();
  }
});

const snapshot: QuerySnapshotResponse = {
  queryId: QUERY_ID,
  phase: "exploring",
  deadline: "2026-10-08T12:02:00.000Z",
  serverTime: "2026-10-08T12:00:00.000Z",
  gameplayReleaseId: "gameplay_v1",
  aggregateVersion: 4,
  participants: [
    { displayName: "Ada", isSelf: true },
    { displayName: "Lin", isSelf: false },
  ],
  self: {
    actionsUsed: 1,
    voteChoice: null,
    evidenceCards: [
      {
        cardId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        siteId: "site_1",
        text: "own",
      },
    ],
  },
  result: null,
};

test("snapshot route returns the caller's view", async () => {
  const app = buildApp({
    views: { getSnapshot: async () => snapshot },
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: `/query/${QUERY_ID}`,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), snapshot);
  } finally {
    await app.close();
  }
});

test("snapshot route answers 404 for unknown rooms and non-members alike", async () => {
  const app = buildApp({ views: { getSnapshot: async () => null } });
  try {
    const response = await app.inject({
      method: "GET",
      url: `/query/${QUERY_ID}`,
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, "NOT_FOUND");
  } finally {
    await app.close();
  }
});

test("snapshot route requires authentication and a valid query id", async () => {
  const unauthenticated = buildApp({
    authenticated: false,
    views: { getSnapshot: async () => snapshot },
  });
  const malformed = buildApp({
    views: { getSnapshot: async () => snapshot },
  });
  try {
    const denied = await unauthenticated.inject({
      method: "GET",
      url: `/query/${QUERY_ID}`,
    });
    assert.equal(denied.statusCode, 401);

    const badId = await malformed.inject({
      method: "GET",
      url: "/query/not-a-uuid",
    });
    assert.equal(badId.statusCode, 400);
  } finally {
    await unauthenticated.close();
    await malformed.close();
  }
});
