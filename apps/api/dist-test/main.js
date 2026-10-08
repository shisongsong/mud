import { createApp } from "./app.js";
import { loadEnvironment } from "./config/env.js";
import { cryptoIdGenerator, cryptoRandomSource, } from "./kernel/crypto-adapters.js";
import { systemClock } from "./kernel/ports.js";
import { Argon2idPasswordHasher } from "./platform/argon2-password-hasher.js";
import { RedisAuthRateLimiter } from "./platform/auth-rate-limiter.js";
import { PostgresCommandReceipts } from "./platform/transactions/command-receipts.js";
import { PostgresOutbox } from "./platform/transactions/outbox.js";
import { PostgresIdentityRepository } from "./platform/database/identity-repository.js";
import { PostgresGameplayReleaseRepository } from "./platform/database/gameplay-release-repository.js";
import { createPostgresPool, PostgresUnitOfWork, } from "./platform/database/postgres.js";
import { PostgresQueryCommands } from "./platform/database/query-commands.js";
import { PostgresQueryRepository } from "./platform/database/query-repository.js";
import { PostgresQueryViews } from "./platform/database/query-views.js";
import { startMaintenance } from "./platform/maintenance.js";
import { PostgresPlayerCommands } from "./platform/database/player-commands.js";
import { PostgresPlayerRepository } from "./platform/database/player-repository.js";
import { PostgresIdentityService } from "./platform/identity.js";
import { readSessionSecret } from "./server/auth-routes.js";
import { createClient } from "redis";
const environment = loadEnvironment();
const pool = createPostgresPool(environment);
const unitOfWork = new PostgresUnitOfWork(pool);
const identity = new PostgresIdentityService(unitOfWork, new PostgresIdentityRepository(), new Argon2idPasswordHasher(), cryptoIdGenerator, cryptoRandomSource, systemClock);
const playerRepository = new PostgresPlayerRepository();
const gameplayReleases = new PostgresGameplayReleaseRepository();
const commandReceipts = new PostgresCommandReceipts(unitOfWork);
const playerCommands = new PostgresPlayerCommands(playerRepository, commandReceipts, new PostgresOutbox(), gameplayReleases, cryptoIdGenerator, systemClock);
const queryRepository = new PostgresQueryRepository(unitOfWork);
const queryCommands = new PostgresQueryCommands(queryRepository, commandReceipts, gameplayReleases, cryptoIdGenerator, systemClock);
const queryViews = new PostgresQueryViews(unitOfWork, queryRepository, playerRepository, systemClock);
const QUERY_MAINTENANCE_INTERVAL_MS = 5000;
const stopQueryMaintenance = startMaintenance({
    intervalMs: QUERY_MAINTENANCE_INTERVAL_MS,
    tasks: [
        {
            name: "release-expired-join-reservations",
            run: () => queryCommands.releaseExpiredJoinReservations(),
        },
        {
            name: "advance-due-queries",
            run: () => queryCommands.advanceDueQueries(),
        },
    ],
    onError: (taskName, error) => {
        app.log.error({ err: error, task: taskName }, "Query maintenance failed");
    },
});
const secureCookies = environment.NODE_ENV === "production";
const redis = createClient({ url: environment.REDIS_URL });
redis.on("error", () => undefined);
let redisConnection = null;
const connectRedis = async () => {
    if (redis.isReady)
        return;
    if (!redisConnection) {
        redisConnection = redis
            .connect()
            .then(() => undefined)
            .finally(() => {
            redisConnection = null;
        });
    }
    await redisConnection;
};
const app = createApp(environment, {
    auth: {
        identity,
        rateLimiter: new RedisAuthRateLimiter({
            eval: async (script, options) => {
                await connectRedis();
                return redis.eval(script, {
                    keys: [...options.keys],
                    arguments: [...options.arguments],
                });
            },
        }),
        publicOrigin: new URL(environment.PUBLIC_ORIGIN ??
            `http://${environment.HOST}:${environment.PORT}`).origin,
        secureCookies,
    },
    players: {
        identity,
        commands: playerCommands,
        getByAccountId: (accountId) => unitOfWork.transaction((transaction) => playerRepository.getByAccountId(transaction, accountId)),
        secureCookies,
    },
    gameplay: {
        getActiveGameplayRelease: () => unitOfWork.transaction((transaction) => gameplayReleases.getActiveGameplayRelease(transaction)),
    },
    queries: {
        commands: queryCommands,
        views: queryViews,
        authenticatePlayer: async (request) => {
            const session = await identity.authenticate(readSessionSecret(request, secureCookies));
            if (!session)
                return null;
            const profile = await unitOfWork.transaction((transaction) => playerRepository.getByAccountId(transaction, session.accountId));
            if (!profile)
                return null;
            return {
                kind: "player",
                accountId: session.accountId,
                playerId: profile.playerId,
            };
        },
    },
    checkReadiness: async () => {
        await pool.query("SELECT 1");
        await connectRedis();
        await redis.ping();
    },
});
app.addHook("onClose", async () => {
    await stopQueryMaintenance();
    await Promise.all([
        pool.end(),
        redis.isOpen ? redis.quit().catch(() => undefined) : Promise.resolve(),
    ]);
});
process.once("SIGINT", () => void app.close());
process.once("SIGTERM", () => void app.close());
try {
    await app.listen({ host: environment.HOST, port: environment.PORT });
}
catch (error) {
    app.log.error(error);
    process.exitCode = 1;
    await app.close();
}
