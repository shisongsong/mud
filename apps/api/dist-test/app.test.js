import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "./app.js";
import { loadEnvironment } from "./config/env.js";
let app;
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
