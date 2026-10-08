import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../app.ts";
import { loadEnvironment } from "../config/env.ts";

test("gameplay release endpoint exposes only the active public release fields", async () => {
  const app = createApp(loadEnvironment({ NODE_ENV: "test" }), {
    gameplay: {
      getActiveGameplayRelease: async () => ({
        releaseId: "gameplay_bootstrap_v1",
        queryEnabled: false,
        templates: ["trial_1"],
      }),
    },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/gameplay/release" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      gameplayReleaseId: "gameplay_bootstrap_v1",
      queryEnabled: false,
      templateIds: ["trial_1"],
    });
  } finally {
    await app.close();
  }
});

test("gameplay release endpoint fails closed without a valid pointer", async () => {
  const app = createApp(loadEnvironment({ NODE_ENV: "test" }), {
    gameplay: {
      getActiveGameplayRelease: async () => null,
    },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/gameplay/release" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "GAMEPLAY_NOT_READY");
    assert.equal(typeof response.json().traceId, "string");
  } finally {
    await app.close();
  }
});