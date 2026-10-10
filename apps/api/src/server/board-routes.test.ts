import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { BoardSnapshotResponse } from "../contracts/http.ts";
import type { PlayerActor } from "../kernel/actor.ts";
import { registerBoardRoutes } from "./board-routes.ts";
import type { BoardRouteDependencies } from "./board-routes.ts";

const actor: PlayerActor = {
  kind: "player",
  accountId: "11111111-1111-4111-8111-111111111111",
  playerId: "22222222-2222-4222-8222-222222222222",
};
const snapshot: BoardSnapshotResponse = {
  boardVersion: 3,
  tension: 48,
  factions: [1, 2, 3, 4, 5, 6].map((id) => ({
    factionId: `faction_${id}` as BoardSnapshotResponse["factions"][number]["factionId"],
    strength: 50 + id,
  })) as BoardSnapshotResponse["factions"],
  updatedAt: "2026-10-10T10:00:00.000Z",
  serverTime: "2026-10-10T10:00:01.000Z",
};

function buildApp(options: {
  readonly authenticated?: boolean;
  readonly playerExists?: boolean;
  readonly failRead?: boolean;
} = {}) {
  const app = Fastify();
  const dependencies: BoardRouteDependencies = {
    identity: {
      authenticate: async () =>
        options.authenticated === false ? null : { accountId: actor.accountId },
    },
    secureCookies: false,
    getPlayerActor: async () =>
      options.playerExists === false ? null : actor,
    views: {
      getSnapshot: async () => {
        if (options.failRead) throw new Error("database details must not leak");
        return snapshot;
      },
    },
  };
  registerBoardRoutes(app, dependencies);
  return app;
}

test("board route returns the authenticated player's public world snapshot", async () => {
  const app = buildApp();
  try {
    const response = await app.inject({ method: "GET", url: "/board" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), snapshot);
  } finally {
    await app.close();
  }
});

test("board route rejects unauthenticated callers and missing player profiles", async () => {
  const unauthenticated = buildApp({ authenticated: false });
  const missingPlayer = buildApp({ playerExists: false });
  try {
    const denied = await unauthenticated.inject({ method: "GET", url: "/board" });
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.json().code, "UNAUTHENTICATED");

    const missing = await missingPlayer.inject({ method: "GET", url: "/board" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().code, "PLAYER_NOT_FOUND");
  } finally {
    await Promise.all([unauthenticated.close(), missingPlayer.close()]);
  }
});

test("board route hides snapshot dependency failures", async () => {
  const app = buildApp({ failRead: true });
  try {
    const response = await app.inject({ method: "GET", url: "/board" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "BOARD_UNAVAILABLE");
    assert.doesNotMatch(response.body, /database details/);
  } finally {
    await app.close();
  }
});
