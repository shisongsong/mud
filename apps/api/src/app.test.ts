import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.ts";
import { loadEnvironment } from "./config/env.ts";
import type { PlayerActor } from "./kernel/actor.ts";

let app: FastifyInstance;

before(() => {
  app = createApp(loadEnvironment({ NODE_ENV: "test" }));
});

after(async () => {
  await app.close();
});

test("liveness endpoint returns a minimal response without touching dependencies", async () => {
  const response = await app.inject({ method: "GET", url: "/health/live" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
});

test("query creation requires a server-authenticated player and idempotency key", async () => {
  const player: PlayerActor = {
    kind: "player",
    accountId: "11111111-1111-4111-8111-111111111111",
    playerId: "22222222-2222-4222-8222-222222222222",
  };
  let authenticated = false;
  let commandsCalled = 0;
  const queryApp = createApp(loadEnvironment({ NODE_ENV: "test" }), {
    queries: {
      authenticatePlayer: async () => (authenticated ? player : null),
      commands: {
        create: async (actor) => {
          commandsCalled += 1;
          assert.deepEqual(actor, player);
          return {
            replayed: false,
            result: {
              queryId: "33333333-3333-4333-8333-333333333333",
              aggregateVersion: 1,
            },
          };
        },
      },
    },
  });

  try {
    const unauthenticated = await queryApp.inject({
      method: "POST",
      url: "/queries",
      payload: { templateId: "trial_1", gameplayReleaseId: "gameplay_v1" },
      headers: { "idempotency-key": "create-query-key-0001" },
    });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(commandsCalled, 0);

    authenticated = true;
    const missingKey = await queryApp.inject({
      method: "POST",
      url: "/queries",
      payload: { templateId: "trial_1", gameplayReleaseId: "gameplay_v1" },
    });
    assert.equal(missingKey.statusCode, 400);
    assert.equal(commandsCalled, 0);

    const forgedActor = await queryApp.inject({
      method: "POST",
      url: "/queries",
      payload: {
        templateId: "trial_1",
        gameplayReleaseId: "gameplay_v1",
        playerId: "attacker-controlled",
      },
      headers: { "idempotency-key": "create-query-key-0001" },
    });
    assert.equal(forgedActor.statusCode, 400);
    assert.equal(commandsCalled, 0);

    const created = await queryApp.inject({
      method: "POST",
      url: "/queries",
      payload: { templateId: "trial_1", gameplayReleaseId: "gameplay_v1" },
      headers: { "idempotency-key": "create-query-key-0001" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(
      created.headers.location,
      "/queries/33333333-3333-4333-8333-333333333333",
    );
    assert.deepEqual(created.json(), {
      queryId: "33333333-3333-4333-8333-333333333333",
      aggregateVersion: 1,
    });
    assert.equal(commandsCalled, 1);
  } finally {
    await queryApp.close();
  }
});
