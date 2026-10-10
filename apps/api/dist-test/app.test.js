import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "./app.js";
import { loadEnvironment, resolvePublicOrigin, resolveRedisUrl, } from "./config/env.js";
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
test("play page is served same-origin and root redirects to it", async () => {
    const page = await app.inject({ method: "GET", url: "/play" });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"] ?? "", /text\/html/);
    assert.match(page.body, /有效印记/);
    assert.match(page.body, /\/query\//);
    const root = await app.inject({ method: "GET", url: "/" });
    assert.equal(root.statusCode, 302);
    assert.equal(root.headers.location, "/play");
});
test("public origin follows the Codespaces forwarded host in development", () => {
    const environment = loadEnvironment({
        NODE_ENV: "development",
        PORT: "3000",
    });
    assert.equal(resolvePublicOrigin(environment, {
        CODESPACE_NAME: "echo-archive",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
    }), "https://echo-archive-3000.app.github.dev");
});
test("explicit and non-Codespaces public origins remain unchanged", () => {
    const explicit = loadEnvironment({
        NODE_ENV: "development",
        PUBLIC_ORIGIN: "https://game.example.com",
    });
    assert.equal(resolvePublicOrigin(explicit, {
        CODESPACE_NAME: "echo-archive",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
    }), "https://game.example.com");
    const local = loadEnvironment({ NODE_ENV: "development", PORT: "3000" });
    assert.equal(resolvePublicOrigin(local, {}), "http://127.0.0.1:3000");
});
test("development defaults to the configured Azure Redis TLS endpoint", () => {
    const development = loadEnvironment({ NODE_ENV: "development" });
    assert.equal(resolveRedisUrl(development), "rediss://nse-dev-redis.redis.cache.windows.net:6380");
    const explicit = loadEnvironment({
        NODE_ENV: "development",
        REDIS_URL: "rediss://other-redis.example.com:6380",
    });
    assert.equal(resolveRedisUrl(explicit), "rediss://other-redis.example.com:6380");
    const localOverride = loadEnvironment({
        NODE_ENV: "development",
        REDIS_URL: "redis://127.0.0.1:6379",
    });
    assert.equal(resolveRedisUrl(localOverride), "rediss://nse-dev-redis.redis.cache.windows.net:6380");
    const testEnvironment = loadEnvironment({ NODE_ENV: "test" });
    assert.equal(resolveRedisUrl(testEnvironment), "redis://127.0.0.1:6379");
});
test("readiness endpoint checks its dependency and never exposes failure details", async () => {
    let checks = 0;
    const readyApp = createApp(loadEnvironment({ NODE_ENV: "test" }), {
        checkReadiness: async () => {
            checks += 1;
        },
    });
    const unavailableApp = createApp(loadEnvironment({ NODE_ENV: "test" }), {
        checkReadiness: async () => {
            throw new Error("database connection string must stay private");
        },
    });
    try {
        const ready = await readyApp.inject({
            method: "GET",
            url: "/health/ready",
        });
        assert.equal(ready.statusCode, 200);
        assert.deepEqual(ready.json(), { status: "ok" });
        assert.equal(checks, 1);
        const unavailable = await unavailableApp.inject({
            method: "GET",
            url: "/health/ready",
        });
        assert.equal(unavailable.statusCode, 503);
        assert.deepEqual(unavailable.json(), { status: "not_ready" });
        assert.doesNotMatch(unavailable.body, /connection string/);
    }
    finally {
        await readyApp.close();
        await unavailableApp.close();
    }
});
test("query creation requires a server-authenticated player and idempotency key", async () => {
    const player = {
        kind: "player",
        accountId: "11111111-1111-4111-8111-111111111111",
        playerId: "22222222-2222-4222-8222-222222222222",
    };
    let authenticated = false;
    let commandsCalled = 0;
    const traceIds = [];
    const queryApp = createApp(loadEnvironment({ NODE_ENV: "test" }), {
        queries: {
            authenticatePlayer: async () => (authenticated ? player : null),
            commands: {
                create: async (actor, _input, _key, traceId) => {
                    commandsCalled += 1;
                    assert.deepEqual(actor, player);
                    if (traceId)
                        traceIds.push(traceId);
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
        assert.equal(created.headers.location, "/queries/33333333-3333-4333-8333-333333333333");
        assert.deepEqual(created.json(), {
            queryId: "33333333-3333-4333-8333-333333333333",
            aggregateVersion: 1,
        });
        assert.equal(commandsCalled, 1);
        assert.equal(traceIds.length, 1);
        assert.match(traceIds[0], /^[0-9a-f-]{36}$/);
    }
    finally {
        await queryApp.close();
    }
});
test("Query creation reports unavailable gameplay instead of persisting a room", async () => {
    const player = {
        kind: "player",
        accountId: "11111111-1111-4111-8111-111111111111",
        playerId: "22222222-2222-4222-8222-222222222222",
    };
    const queryApp = createApp(loadEnvironment({ NODE_ENV: "test" }), {
        queries: {
            authenticatePlayer: async () => player,
            commands: {
                create: async () => {
                    throw Object.assign(new Error("no playable release"), {
                        code: "GAMEPLAY_NOT_READY",
                    });
                },
            },
        },
    });
    try {
        const response = await queryApp.inject({
            method: "POST",
            url: "/queries",
            payload: {
                templateId: "trial_1",
                gameplayReleaseId: "gameplay_bootstrap_v1",
            },
            headers: { "idempotency-key": "query-not-ready-key-0001" },
        });
        assert.equal(response.statusCode, 503);
        assert.equal(response.json().code, "GAMEPLAY_NOT_READY");
    }
    finally {
        await queryApp.close();
    }
});
test("query leave and vote routes use authenticated actors and strict request contracts", async () => {
    const player = {
        kind: "player",
        accountId: "11111111-1111-4111-8111-111111111111",
        playerId: "22222222-2222-4222-8222-222222222222",
    };
    const queryId = "33333333-3333-4333-8333-333333333333";
    const calls = [];
    const traceIds = [];
    const queryApp = createApp(loadEnvironment({ NODE_ENV: "test" }), {
        queries: {
            authenticatePlayer: async () => player,
            commands: {
                create: async () => ({
                    replayed: false,
                    result: { queryId, aggregateVersion: 1 },
                }),
                leave: async (actor, receivedQueryId, input, key, traceId) => {
                    assert.deepEqual(actor, player);
                    assert.equal(receivedQueryId, queryId);
                    assert.deepEqual(input, { expectedVersion: 1 });
                    assert.equal(key, "leave-query-key-0001");
                    if (traceId)
                        traceIds.push(traceId);
                    calls.push("leave");
                    return {
                        replayed: false,
                        result: { resourceId: queryId, aggregateVersion: 2 },
                    };
                },
                vote: async (actor, receivedQueryId, input, key, traceId) => {
                    assert.deepEqual(actor, player);
                    assert.equal(receivedQueryId, queryId);
                    assert.deepEqual(input, {
                        choiceId: "choice_1",
                        expectedVersion: 2,
                    });
                    assert.equal(key, "cast-vote-key-0001");
                    if (traceId)
                        traceIds.push(traceId);
                    calls.push("vote");
                    return {
                        replayed: true,
                        result: { resourceId: queryId, aggregateVersion: 3 },
                    };
                },
            },
        },
    });
    try {
        const leave = await queryApp.inject({
            method: "POST",
            url: `/query/${queryId}/leave`,
            payload: { expectedVersion: 1 },
            headers: { "idempotency-key": "leave-query-key-0001" },
        });
        assert.equal(leave.statusCode, 200);
        assert.deepEqual(leave.json(), {
            resourceId: queryId,
            aggregateVersion: 2,
        });
        const vote = await queryApp.inject({
            method: "POST",
            url: `/query/${queryId}/vote`,
            payload: { choiceId: "choice_1", expectedVersion: 2 },
            headers: { "idempotency-key": "cast-vote-key-0001" },
        });
        assert.equal(vote.statusCode, 200);
        assert.deepEqual(vote.json(), {
            resourceId: queryId,
            aggregateVersion: 3,
        });
        assert.equal(traceIds.length, 2);
        assert.ok(traceIds.every((traceId) => /^[0-9a-f-]{36}$/.test(traceId)));
        const forgedActor = await queryApp.inject({
            method: "POST",
            url: `/query/${queryId}/vote`,
            payload: {
                choiceId: "choice_1",
                expectedVersion: 3,
                playerId: "attacker-controlled",
            },
            headers: { "idempotency-key": "cast-vote-key-0002" },
        });
        assert.equal(forgedActor.statusCode, 400);
        assert.deepEqual(calls, ["leave", "vote"]);
    }
    finally {
        await queryApp.close();
    }
});
test("query join route validates input and maps join conflicts to 409", async () => {
    const player = {
        kind: "player",
        accountId: "11111111-1111-4111-8111-111111111111",
        playerId: "22222222-2222-4222-8222-222222222222",
    };
    const queryId = "33333333-3333-4333-8333-333333333333";
    let conflict = false;
    const queryApp = createApp(loadEnvironment({ NODE_ENV: "test" }), {
        queries: {
            authenticatePlayer: async () => player,
            commands: {
                create: async () => ({
                    replayed: false,
                    result: { queryId, aggregateVersion: 1 },
                }),
                join: async (actor, receivedQueryId, key) => {
                    assert.deepEqual(actor, player);
                    assert.equal(receivedQueryId, queryId);
                    assert.equal(key, "join-query-key-0001");
                    if (conflict) {
                        throw Object.assign(new Error("conflict"), {
                            code: "QUERY_JOIN_PLAYER_ALREADY_IN_QUERY",
                        });
                    }
                    return {
                        replayed: false,
                        result: {
                            queryId,
                            aggregateVersion: 4,
                            phase: "exploring",
                        },
                    };
                },
            },
        },
    });
    try {
        const joined = await queryApp.inject({
            method: "POST",
            url: `/query/${queryId}/join`,
            headers: { "idempotency-key": "join-query-key-0001" },
        });
        assert.equal(joined.statusCode, 200);
        assert.deepEqual(joined.json(), {
            queryId,
            aggregateVersion: 4,
            phase: "exploring",
        });
        const missingKey = await queryApp.inject({
            method: "POST",
            url: `/query/${queryId}/join`,
        });
        assert.equal(missingKey.statusCode, 400);
        conflict = true;
        const duplicate = await queryApp.inject({
            method: "POST",
            url: `/query/${queryId}/join`,
            headers: { "idempotency-key": "join-query-key-0001" },
        });
        assert.equal(duplicate.statusCode, 409);
        assert.equal(duplicate.json().code, "QUERY_CONFLICT");
    }
    finally {
        await queryApp.close();
    }
});
