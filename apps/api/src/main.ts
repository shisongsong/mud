import { createApp } from "./app.ts";
import {
  loadEnvironment,
  resolvePublicOrigin,
  resolveRedisUrl,
} from "./config/env.ts";
import {
  cryptoIdGenerator,
  cryptoRandomSource,
} from "./kernel/crypto-adapters.ts";
import { systemClock } from "./kernel/ports.ts";
import { Argon2idPasswordHasher } from "./platform/argon2-password-hasher.ts";
import { RedisAuthRateLimiter } from "./platform/auth-rate-limiter.ts";
import { PostgresCommandReceipts } from "./platform/transactions/command-receipts.ts";
import { PostgresOutbox } from "./platform/transactions/outbox.ts";
import { PostgresIdentityRepository } from "./platform/database/identity-repository.ts";
import { PostgresGameplayReleaseRepository } from "./platform/database/gameplay-release-repository.ts";
import {
  createPostgresPool,
  PostgresUnitOfWork,
} from "./platform/database/postgres.ts";
import { PostgresQueryCommands } from "./platform/database/query-commands.ts";
import { PostgresQueryRepository } from "./platform/database/query-repository.ts";
import { PostgresBoardCommands } from "./platform/database/board-commands.ts";
import { PostgresBoardViews } from "./platform/database/board-views.ts";
import { QuerySettlementCoordinator } from "./platform/database/query-settlement.ts";
import { PostgresQueryViews } from "./platform/database/query-views.ts";
import { PostgresScriptCommands } from "./platform/database/script-commands.ts";
import { PostgresScriptRepository } from "./platform/database/script-repository.ts";
import { startMaintenance } from "./platform/maintenance.ts";
import { PostgresPlayerCommands } from "./platform/database/player-commands.ts";
import {
  PostgresPlayerFactionReader,
  PostgresPlayerRepository,
} from "./platform/database/player-repository.ts";
import { PostgresIdentityService } from "./platform/identity.ts";
import { readSessionSecret } from "./server/auth-routes.ts";
import { createClient } from "redis";

const environment = loadEnvironment();
const pool = createPostgresPool(environment);
const unitOfWork = new PostgresUnitOfWork(pool);
const identity = new PostgresIdentityService(
  unitOfWork,
  new PostgresIdentityRepository(),
  new Argon2idPasswordHasher(),
  cryptoIdGenerator,
  cryptoRandomSource,
  systemClock,
);
const playerRepository = new PostgresPlayerRepository();
const gameplayReleases = new PostgresGameplayReleaseRepository();
const commandReceipts = new PostgresCommandReceipts(unitOfWork);
const playerCommands = new PostgresPlayerCommands(
  playerRepository,
  commandReceipts,
  new PostgresOutbox(),
  gameplayReleases,
  cryptoIdGenerator,
  systemClock,
);
const scriptCommands = new PostgresScriptCommands(
  new PostgresScriptRepository(unitOfWork),
  commandReceipts,
  new PostgresOutbox(),
  cryptoIdGenerator,
  systemClock,
);
const queryRepository = new PostgresQueryRepository(unitOfWork);
const queryCommands = new PostgresQueryCommands(
  queryRepository,
  commandReceipts,
  gameplayReleases,
  cryptoIdGenerator,
  systemClock,
  cryptoRandomSource,
  new PostgresPlayerFactionReader(unitOfWork, playerRepository),
);
const boardCommands = new PostgresBoardCommands(unitOfWork, systemClock);
const boardViews = new PostgresBoardViews(unitOfWork, systemClock);
const querySettlement = new QuerySettlementCoordinator(
  queryRepository,
  queryCommands,
  boardCommands,
  playerCommands,
  scriptCommands,
  cryptoIdGenerator,
  (queryId, error) => {
    app.log.error({ err: error, queryId }, "Query settlement recovery failed");
  },
);
const queryViews = new PostgresQueryViews(
  unitOfWork,
  queryRepository,
  playerRepository,
  systemClock,
  gameplayReleases,
);
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
    {
      name: "advance-due-settlements",
      run: () => querySettlement.advanceDueSettlements(),
    },
  ],
  onError: (taskName, error) => {
    app.log.error({ err: error, task: taskName }, "Query maintenance failed");
  },
});
const secureCookies = environment.NODE_ENV === "production";
const redisUrl = resolveRedisUrl(environment);
const redisUrlParts = new URL(redisUrl);
const createRedisClient = () => {
  const client = createClient({
    url: redisUrl,
    ...(environment.REDIS_PASSWORD
      ? { password: environment.REDIS_PASSWORD }
      : {}),
    socket: {
      ...(redisUrlParts.protocol === "rediss:" || redisUrlParts.port === "6380"
        ? { tls: true }
        : {}),
      connectTimeout: 3000,
      reconnectStrategy: false,
    },
  });
  client.on("error", () => undefined);
  return client;
};
let redis = createRedisClient();
let redisConnection: Promise<void> | null = null;
const connectRedis = async () => {
  if (redis.isReady) return;
  if (!redisConnection) {
    const client = redis;
    redisConnection = client
      .connect()
      .then(() => undefined)
      .catch((error: unknown) => {
        if (redis === client) {
          if (client.isOpen) client.destroy();
          redis = createRedisClient();
        }
        throw error;
      })
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
    publicOrigin: resolvePublicOrigin(environment),
    secureCookies,
    allowHostOriginFallback: environment.NODE_ENV === "development",
  },
  players: {
    identity,
    commands: playerCommands,
    getByAccountId: (accountId) =>
      unitOfWork.transaction((transaction) =>
        playerRepository.getByAccountId(transaction, accountId),
      ),
    listOwnedKnowledge: (actor) => scriptCommands.listOwnedKnowledge(actor),
    secureCookies,
  },
  gameplay: {
    getActiveGameplayRelease: () =>
      unitOfWork.transaction((transaction) =>
        gameplayReleases.getActiveGameplayRelease(transaction),
      ),
  },
  queries: {
    commands: queryCommands,
    views: queryViews,
    authenticatePlayer: async (request) => {
      const session = await identity.authenticate(
        readSessionSecret(request, secureCookies),
      );
      if (!session) return null;
      const profile = await unitOfWork.transaction((transaction) =>
        playerRepository.getByAccountId(transaction, session.accountId),
      );
      if (!profile) return null;
      return {
        kind: "player",
        accountId: session.accountId,
        playerId: profile.playerId,
      };
    },
  },
  board: {
    identity,
    secureCookies,
    getPlayerActor: async (accountId) => {
      const profile = await unitOfWork.transaction((transaction) =>
        playerRepository.getByAccountId(transaction, accountId),
      );
      return profile
        ? { kind: "player", accountId, playerId: profile.playerId }
        : null;
    },
    views: boardViews,
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
} catch (error: unknown) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
