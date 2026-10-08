import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  QueryExecutor,
  SqlParameters,
  UnitOfWork,
} from "./unit-of-work.ts";
import { PostgresOutboxDispatcher } from "./outbox-dispatcher.ts";

interface RecordedQuery {
  readonly statement: string;
  readonly parameters: SqlParameters;
}

class FakeDispatcherUnitOfWork implements UnitOfWork {
  readonly queries: RecordedQuery[] = [];
  readonly deliveries: SqlParameters[] = [];
  cursorRows: readonly object[] = [];
  pendingStreamRows: readonly object[] = [];
  eventRows: readonly object[] = [];
  previousDeliveries = new Map<string, string>();
  transactionCount = 0;

  async transaction<T>(
    work: (executor: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    const executor: QueryExecutor = {
      query: async <Row extends object>(
        statement: string,
        parameters: SqlParameters = {},
      ): Promise<readonly Row[]> => {
        this.queries.push({ statement, parameters });
        let rows: readonly object[] = [];
        if (statement.includes('"nextDispatchSequence" < "nextSequence"')) {
          rows = this.pendingStreamRows;
        } else if (statement.includes('SELECT "nextDispatchSequence"')) {
          rows = this.cursorRows;
        } else if (statement.includes('FROM "platform"."OutboxEvents"')) {
          rows = this.eventRows;
        } else if (
          statement.includes('FROM "platform"."EventDeliveries"') &&
          statement.includes('ORDER BY "sequence" DESC')
        ) {
          const predecessor = this.previousDeliveries.get(
            String(parameters["consumer"]),
          );
          rows = predecessor ? [{ eventId: predecessor }] : [];
        } else if (
          statement.includes('INSERT INTO "platform"."EventDeliveries"')
        ) {
          this.deliveries.push(parameters);
          rows = [{ eventId: parameters["eventId"] }];
        } else if (statement.includes('UPDATE "platform"."OutboxStreams"')) {
          rows = [{ streamId: parameters["streamId"] }];
        }
        return rows as readonly Row[];
      },
    };
    return work(executor);
  }
}

const streamId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const predecessorEventId = "33333333-3333-4333-8333-333333333333";
const eventRow = {
  eventId,
  eventType: "QueryCreated",
  schemaVersion: 1,
  source: "query",
  aggregateId: "44444444-4444-4444-8444-444444444444",
  aggregateVersion: "1",
  streamId,
  sequence: "2",
  releaseVersion: "gameplay_v1",
  occurredAt: new Date("2026-10-08T12:00:00.000Z"),
  traceId: "55555555-5555-4555-8555-555555555555",
  correlationId: "66666666-6666-4666-8666-666666666666",
  causationId: null,
  rootEventId: eventId,
  depth: 0,
  payloadJson: { queryId: "44444444-4444-4444-8444-444444444444" },
};

test("dispatcher filters subscriptions and links each consumer's predecessor", async () => {
  const unitOfWork = new FakeDispatcherUnitOfWork();
  unitOfWork.cursorRows = [{ nextDispatchSequence: "2", nextSequence: "4" }];
  unitOfWork.eventRows = [eventRow];
  unitOfWork.previousDeliveries.set("query-projection", predecessorEventId);
  const dispatcher = new PostgresOutboxDispatcher(unitOfWork, [
    { consumer: "query-projection", eventTypes: ["QueryCreated"] },
    { consumer: "audit-projection", eventTypes: ["AccountRegistered"] },
  ]);

  const result = await dispatcher.dispatchNext(streamId);

  assert.deepEqual(result, {
    eventId,
    sequence: 2,
    deliveriesCreated: 1,
  });
  assert.equal(unitOfWork.deliveries.length, 1);
  assert.equal(unitOfWork.deliveries[0]?.["consumer"], "query-projection");
  assert.equal(
    unitOfWork.deliveries[0]?.["predecessorEventId"],
    predecessorEventId,
  );
  assert.match(unitOfWork.queries[0]!.statement, /FOR UPDATE SKIP LOCKED/);
  assert.equal(unitOfWork.queries.at(-1)?.parameters["sequence"], 2);
});

test("dispatcher advances the cursor over events with no matching subscription", async () => {
  const unitOfWork = new FakeDispatcherUnitOfWork();
  unitOfWork.cursorRows = [{ nextDispatchSequence: "1", nextSequence: "2" }];
  unitOfWork.eventRows = [{ ...eventRow, sequence: "1" }];
  const dispatcher = new PostgresOutboxDispatcher(unitOfWork, [
    { consumer: "audit-projection", eventTypes: ["AccountRegistered"] },
  ]);

  const result = await dispatcher.dispatchNext(streamId);

  assert.equal(result?.deliveriesCreated, 0);
  assert.equal(unitOfWork.deliveries.length, 0);
  assert.equal(
    unitOfWork.queries
      .at(-1)
      ?.statement.includes(
        '"nextDispatchSequence" = "nextDispatchSequence" + 1',
      ),
    true,
  );
});

test("dispatcher batch discovers streams without external stream enumeration", async () => {
  const unitOfWork = new FakeDispatcherUnitOfWork();
  unitOfWork.pendingStreamRows = [{ streamId }];
  unitOfWork.cursorRows = [{ nextDispatchSequence: "2", nextSequence: "4" }];
  unitOfWork.eventRows = [eventRow];
  const dispatcher = new PostgresOutboxDispatcher(unitOfWork, []);

  const results = await dispatcher.dispatchAvailable(10);

  assert.deepEqual(results, [{ eventId, sequence: 2, deliveriesCreated: 0 }]);
  assert.match(unitOfWork.queries[0]!.statement, /FOR UPDATE SKIP LOCKED/);
  assert.equal(unitOfWork.queries[0]!.parameters["limit"], 10);
});

test("dispatcher rejects a stream gap and invalid subscription configuration", async () => {
  const unitOfWork = new FakeDispatcherUnitOfWork();
  unitOfWork.cursorRows = [{ nextDispatchSequence: "2", nextSequence: "3" }];
  const dispatcher = new PostgresOutboxDispatcher(unitOfWork, []);

  await assert.rejects(
    dispatcher.dispatchNext(streamId),
    /missing event sequence/,
  );
  assert.throws(
    () =>
      new PostgresOutboxDispatcher(unitOfWork, [
        { consumer: "duplicate" },
        { consumer: "duplicate" },
      ]),
    /must be unique/,
  );
  assert.throws(() => dispatcher.dispatchNext("not-a-uuid"), /stream ID/);
});
