import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { loadEnvironment } from "../../config/env.ts";
import type { PlayerActor } from "../../kernel/actor.ts";
import { PostgresCommandReceipts } from "../transactions/command-receipts.ts";
import { PostgresUnitOfWork, createPostgresPool } from "./postgres.ts";
import { PostgresDeliveryQueue } from "../transactions/delivery-queue.ts";
import { PostgresOutboxDispatcher } from "../transactions/outbox-dispatcher.ts";
import { PostgresOutbox } from "../transactions/outbox.ts";
import { PostgresQueryCommands } from "./query-commands.ts";
import { PostgresQueryRepository } from "./query-repository.ts";

test(
  "PostgresQueryCommands commits one event with its aggregate and receipt",
  { skip: process.env["RUN_DB_INTEGRATION"] !== "1" },
  async () => {
    const pool = createPostgresPool(loadEnvironment());
    const unitOfWork = new PostgresUnitOfWork(pool);
    const queryId = randomUUID();
    const actor: PlayerActor = {
      kind: "player",
      accountId: randomUUID(),
      playerId: randomUUID(),
    };
    const idempotencyKey = `integration-${randomUUID()}`;
    const traceId = randomUUID();
    let idCalls = 0;
    const commands = new PostgresQueryCommands(
      new PostgresQueryRepository(unitOfWork),
      new PostgresCommandReceipts(unitOfWork),
      {
        getActiveGameplayRelease: async () => ({
          releaseId: "gameplay_integration",
          queryEnabled: true,
          templates: ["trial_1"],
        }),
        getGameplayReleaseById: async () => ({
          releaseId: "gameplay_integration",
          queryEnabled: true,
          templates: ["trial_1"],
        }),
      },
      { next: () => (idCalls++ === 0 ? queryId : randomUUID()) },
      { now: () => new Date() },
    );

    try {
      const input = {
        templateId: "trial_1" as const,
        gameplayReleaseId: "gameplay_integration",
      };
      const first = await commands.create(
        actor,
        input,
        idempotencyKey,
        traceId,
      );
      const replay = await commands.create(
        actor,
        input,
        idempotencyKey,
        traceId,
      );
      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, first.result);

      const aggregate = await pool.query<{ aggregateVersion: number | string }>(
        `SELECT "aggregateVersion" AS "aggregateVersion"
         FROM "query"."QueryRooms" WHERE "queryId" = $1;`,
        [queryId],
      );
      const events = await pool.query<{
        eventType: string;
        aggregateVersion: number | string;
        traceId: string;
        payloadJson: { queryId: string };
      }>(
        `SELECT "eventType" AS "eventType",
                "aggregateVersion" AS "aggregateVersion",
                "traceId" AS "traceId", "payloadJson" AS "payloadJson"
         FROM "platform"."OutboxEvents" WHERE "streamId" = $1;`,
        [queryId],
      );
      const receipts = await pool.query(
        `SELECT "idempotencyKey" FROM "platform"."CommandReceipts"
         WHERE "actorScope" = $1 AND "operation" = 'query.create'
           AND "idempotencyKey" = $2;`,
        [`player:${actor.accountId}:${actor.playerId}`, idempotencyKey],
      );
      assert.equal(aggregate.rowCount, 1);
      assert.equal(String(aggregate.rows[0]?.aggregateVersion), "1");
      assert.equal(events.rowCount, 1);
      assert.equal(events.rows[0]?.eventType, "QueryCreated");
      assert.equal(String(events.rows[0]?.aggregateVersion), "1");
      assert.equal(events.rows[0]?.traceId, traceId);
      assert.equal(events.rows[0]?.payloadJson.queryId, queryId);
      assert.equal(receipts.rowCount, 1);
    } finally {
      try {
        await unitOfWork.transaction(async (transaction) => {
          await transaction.query(
            `DELETE FROM "platform"."EventDeliveries" WHERE "streamId" = @queryId;`,
            { queryId },
          );
          await transaction.query(
            `DELETE FROM "platform"."OutboxEvents" WHERE "streamId" = @queryId;`,
            { queryId },
          );
          await transaction.query(
            `DELETE FROM "platform"."OutboxStreams" WHERE "streamId" = @queryId;`,
            { queryId },
          );
          await transaction.query(
            `DELETE FROM "query"."QueryParticipants" WHERE "queryId" = @queryId;`,
            { queryId },
          );
          await transaction.query(
            `DELETE FROM "query"."QueryRooms" WHERE "queryId" = @queryId;`,
            { queryId },
          );
          await transaction.query(
            `DELETE FROM "platform"."CommandReceipts"
             WHERE "actorScope" = @actorScope AND "operation" = 'query.create'
               AND "idempotencyKey" = @idempotencyKey;`,
            {
              actorScope: `player:${actor.accountId}:${actor.playerId}`,
              idempotencyKey,
            },
          );
        });
      } finally {
        await pool.end();
      }
    }
  },
);

test(
  "PostgresOutbox allocates stream sequences transactionally and rolls back on failure",
  { skip: process.env["RUN_DB_INTEGRATION"] !== "1" },
  async () => {
    const pool = createPostgresPool(loadEnvironment());
    const unitOfWork = new PostgresUnitOfWork(pool);
    const streamId = randomUUID();
    const aggregateId = randomUUID();
    const eventIds = [randomUUID(), randomUUID()];
    const outbox = new PostgresOutbox();

    try {
      await assert.rejects(
        unitOfWork.transaction(async (transaction) => {
          const commonEvent = {
            type: "QueryCreated",
            schemaVersion: 1,
            source: "query" as const,
            aggregateId,
            streamId,
            releaseVersion: "gameplay_v1",
            occurredAt: new Date().toISOString(),
            traceId: randomUUID(),
            correlationId: randomUUID(),
            causationId: null,
            rootEventId: eventIds[0]!,
            depth: 0,
            payload: { queryId: aggregateId },
          };
          const first = await outbox.append(transaction, {
            ...commonEvent,
            eventId: eventIds[0]!,
            aggregateVersion: 1,
          });
          const second = await outbox.append(transaction, {
            ...commonEvent,
            eventId: eventIds[1]!,
            aggregateVersion: 2,
          });

          assert.deepEqual([first.sequence, second.sequence], [1, 2]);
          throw new Error("force transaction rollback");
        }),
        /force transaction rollback/,
      );

      const streams = await pool.query(
        `SELECT "streamId" FROM "platform"."OutboxStreams"
         WHERE "streamId" = $1;`,
        [streamId],
      );
      const events = await pool.query(
        `SELECT "eventId" FROM "platform"."OutboxEvents"
         WHERE "eventId" = ANY($1::uuid[]);`,
        [eventIds],
      );
      assert.equal(streams.rowCount, 0);
      assert.equal(events.rowCount, 0);
    } finally {
      await pool.end();
    }
  },
);

test(
  "PostgresOutboxDispatcher preserves filtered predecessor chains",
  { skip: process.env["RUN_DB_INTEGRATION"] !== "1" },
  async () => {
    const pool = createPostgresPool(loadEnvironment());
    const unitOfWork = new PostgresUnitOfWork(pool);
    const outbox = new PostgresOutbox();
    const streamId = randomUUID();
    const eventIds = [randomUUID(), randomUUID(), randomUUID()];
    const projectionConsumer = `projection-${randomUUID()}`;
    const auditConsumer = `audit-${randomUUID()}`;
    const dispatcher = new PostgresOutboxDispatcher(unitOfWork, [
      {
        consumer: projectionConsumer,
        eventTypes: ["QueryCreated", "QueryVoteCast"],
      },
      { consumer: auditConsumer },
    ]);

    try {
      await assert.rejects(
        unitOfWork.transaction(async (transaction) => {
          const eventTypes = ["QueryCreated", "NoiseEvent", "QueryVoteCast"];
          for (let index = 0; index < eventIds.length; index += 1) {
            await outbox.append(transaction, {
              eventId: eventIds[index]!,
              type: eventTypes[index]!,
              schemaVersion: 1,
              source: "query",
              aggregateId: streamId,
              aggregateVersion: index + 1,
              streamId,
              releaseVersion: "gameplay_v1",
              occurredAt: new Date().toISOString(),
              traceId: randomUUID(),
              correlationId: randomUUID(),
              causationId: index === 0 ? null : eventIds[index - 1]!,
              rootEventId: eventIds[0]!,
              depth: index,
              payload: { index },
            });
          }

          const dispatched = [];
          for (let index = 0; index < eventIds.length; index += 1) {
            const batch = await dispatcher.dispatchAvailableInTransaction(
              transaction,
              10,
            );
            assert.equal(batch.length, 1);
            dispatched.push(batch[0]!);
          }
          assert.deepEqual(
            dispatched.map((result) => result?.deliveriesCreated),
            [2, 1, 2],
          );
          assert.deepEqual(
            dispatched.map((result) => result?.sequence),
            [1, 2, 3],
          );

          const deliveries = await transaction.query<{
            consumer: string;
            eventId: string;
            sequence: number | string;
            predecessorEventId: string | null;
          }>(
            `
SELECT "consumer" AS "consumer", "eventId" AS "eventId",
       "sequence" AS "sequence", "predecessorEventId" AS "predecessorEventId"
FROM "platform"."EventDeliveries"
WHERE "eventId" IN (@eventId0, @eventId1, @eventId2)
ORDER BY "consumer", "sequence";
`,
            {
              eventId0: eventIds[0]!,
              eventId1: eventIds[1]!,
              eventId2: eventIds[2]!,
            },
          );
          const byConsumerAndEvent = new Map(
            deliveries.map((delivery) => [
              `${delivery.consumer}:${delivery.eventId}`,
              delivery,
            ]),
          );
          assert.equal(deliveries.length, 5);
          assert.equal(
            byConsumerAndEvent.get(`${projectionConsumer}:${eventIds[2]}`)
              ?.predecessorEventId,
            eventIds[0],
          );
          assert.equal(
            byConsumerAndEvent.get(`${auditConsumer}:${eventIds[2]}`)
              ?.predecessorEventId,
            eventIds[1],
          );
          throw new Error("force dispatcher transaction rollback");
        }),
        /force dispatcher transaction rollback/,
      );

      const events = await pool.query(
        `SELECT "eventId" FROM "platform"."OutboxEvents"
         WHERE "eventId" = ANY($1::uuid[]);`,
        [eventIds],
      );
      const deliveries = await pool.query(
        `SELECT "eventId" FROM "platform"."EventDeliveries"
         WHERE "eventId" = ANY($1::uuid[]);`,
        [eventIds],
      );
      assert.equal(events.rowCount, 0);
      assert.equal(deliveries.rowCount, 0);
    } finally {
      await pool.end();
    }
  },
);

test(
  "PostgresDeliveryQueue gates successors and fences expired lease holders",
  { skip: process.env["RUN_DB_INTEGRATION"] !== "1" },
  async () => {
    const pool = createPostgresPool(loadEnvironment());
    const unitOfWork = new PostgresUnitOfWork(pool);
    const outbox = new PostgresOutbox();
    const queue = new PostgresDeliveryQueue(unitOfWork);
    const consumer = `integration-${randomUUID()}`;
    const streamIds = [randomUUID(), randomUUID()];
    const eventIds = [randomUUID(), randomUUID(), randomUUID()];

    try {
      await assert.rejects(
        unitOfWork.transaction(async (transaction) => {
          const appendDelivery = async (
            eventIndex: number,
            streamIndex: number,
            predecessorEventId: string | null,
          ) => {
            const streamId = streamIds[streamIndex]!;
            const eventId = eventIds[eventIndex]!;
            const event = await outbox.append(transaction, {
              eventId,
              type: "QueryCreated",
              schemaVersion: 1,
              source: "query",
              aggregateId: streamId,
              aggregateVersion: eventIndex + 1,
              streamId,
              releaseVersion: "gameplay_v1",
              occurredAt: new Date().toISOString(),
              traceId: randomUUID(),
              correlationId: randomUUID(),
              causationId: null,
              rootEventId: eventIds[0]!,
              depth: 0,
              payload: { queryId: streamId },
            });
            await transaction.query(
              `
INSERT INTO "platform"."EventDeliveries"
  ("eventId", "consumer", "streamId", "sequence", "predecessorEventId")
VALUES (@eventId, @consumer, @streamId, @sequence, @predecessorEventId);
`,
              {
                eventId,
                consumer,
                streamId,
                sequence: event.sequence,
                predecessorEventId,
              },
            );
          };

          await appendDelivery(0, 0, null);
          await appendDelivery(1, 0, eventIds[0]!);
          await appendDelivery(2, 1, null);

          const initialClaims = await queue.claimInTransaction(
            transaction,
            consumer,
            10,
          );
          assert.deepEqual(
            initialClaims.map(({ eventId }) => eventId).sort(),
            [eventIds[0]!, eventIds[2]!].sort(),
          );

          const firstLease = initialClaims.find(
            ({ eventId }) => eventId === eventIds[0],
          )!;
          assert.equal(
            await queue.completeInTransaction(
              transaction,
              consumer,
              firstLease.eventId,
              firstLease.fencingToken + 1,
            ),
            false,
          );
          assert.equal(
            await queue.completeInTransaction(
              transaction,
              consumer,
              firstLease.eventId,
              firstLease.fencingToken,
            ),
            true,
          );

          const successorClaims = await queue.claimInTransaction(
            transaction,
            consumer,
            10,
          );
          assert.deepEqual(
            successorClaims.map(({ eventId }) => eventId),
            [eventIds[1]!],
          );

          const expiredLease = initialClaims.find(
            ({ eventId }) => eventId === eventIds[2],
          )!;
          await transaction.query(
            `UPDATE "platform"."EventDeliveries"
             SET "leaseUntil" = clock_timestamp() - interval '1 second'
             WHERE "consumer" = @consumer AND "eventId" = @eventId;`,
            { consumer, eventId: expiredLease.eventId },
          );
          const reclaimed = await queue.claimInTransaction(
            transaction,
            consumer,
            10,
          );
          const renewedLease = reclaimed.find(
            ({ eventId }) => eventId === expiredLease.eventId,
          )!;
          assert.equal(
            renewedLease.fencingToken,
            expiredLease.fencingToken + 1,
          );
          assert.equal(
            await queue.completeInTransaction(
              transaction,
              consumer,
              expiredLease.eventId,
              expiredLease.fencingToken,
            ),
            false,
          );
          assert.ok(
            await queue.renewInTransaction(
              transaction,
              consumer,
              renewedLease.eventId,
              renewedLease.fencingToken,
            ),
          );
          assert.equal(
            (
              await queue.failInTransaction(
                transaction,
                consumer,
                eventIds[1]!,
                successorClaims[0]!.fencingToken,
                "INTEGRATION_FAILURE",
              )
            )?.status,
            "pending",
          );
          throw new Error("force delivery transaction rollback");
        }),
        /force delivery transaction rollback/,
      );

      const events = await pool.query(
        `SELECT "eventId" FROM "platform"."OutboxEvents"
         WHERE "eventId" = ANY($1::uuid[]);`,
        [eventIds],
      );
      const deliveries = await pool.query(
        `SELECT "eventId" FROM "platform"."EventDeliveries"
         WHERE "eventId" = ANY($1::uuid[]);`,
        [eventIds],
      );
      assert.equal(events.rowCount, 0);
      assert.equal(deliveries.rowCount, 0);
    } finally {
      await pool.end();
    }
  },
);
