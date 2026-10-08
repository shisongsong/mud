import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  QueryExecutor,
  SqlParameters,
  UnitOfWork,
} from "./unit-of-work.ts";
import { PostgresDeliveryQueue } from "./delivery-queue.ts";

interface RecordedQuery {
  readonly statement: string;
  readonly parameters: SqlParameters;
}

class FakeDeliveryUnitOfWork implements UnitOfWork {
  readonly queries: RecordedQuery[] = [];
  claimRows: readonly object[] = [];
  completeRows: readonly object[] = [];
  renewRows: readonly object[] = [];
  failureRows: readonly object[] = [];
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
        if (statement.includes("WITH candidates AS")) rows = this.claimRows;
        if (statement.includes('RETURNING "eventId"')) {
          rows = this.completeRows;
        }
        if (statement.includes('RETURNING "leaseUntil"')) {
          rows = this.renewRows;
        }
        if (statement.includes('RETURNING "status", "attempts"')) {
          rows = this.failureRows;
        }
        return rows as readonly Row[];
      },
    };
    return work(executor);
  }
}

const consumer = "query-projection";
const eventId = "11111111-1111-4111-8111-111111111111";
const streamId = "22222222-2222-4222-8222-222222222222";
const leaseUntil = new Date("2026-10-08T12:00:30.000Z");

const claimedRow = {
  consumer,
  eventId,
  streamId,
  sequence: "3",
  predecessorEventId: "33333333-3333-4333-8333-333333333333",
  attempts: 2,
  leaseUntil,
  fencingToken: "7",
  eventType: "QueryCreated",
  schemaVersion: 1,
  source: "query",
  aggregateId: "44444444-4444-4444-8444-444444444444",
  aggregateVersion: "3",
  releaseVersion: "gameplay_v1",
  occurredAt: new Date("2026-10-08T12:00:00.000Z"),
  traceId: "55555555-5555-4555-8555-555555555555",
  correlationId: "66666666-6666-4666-8666-666666666666",
  causationId: null,
  rootEventId: "77777777-7777-4777-8777-777777777777",
  depth: 0,
  payloadJson: { queryId: "44444444-4444-4444-8444-444444444444" },
};

test("delivery claims are ordered, predecessor-gated, and fenced", async () => {
  const unitOfWork = new FakeDeliveryUnitOfWork();
  unitOfWork.claimRows = [claimedRow];
  const queue = new PostgresDeliveryQueue(unitOfWork);

  const deliveries = await queue.claim(consumer, 5);

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.sequence, 3);
  assert.equal(deliveries[0]?.fencingToken, 7);
  assert.equal(deliveries[0]?.event.type, "QueryCreated");
  assert.match(unitOfWork.queries[1]!.statement, /SKIP LOCKED/);
  assert.match(
    unitOfWork.queries[1]!.statement,
    /predecessor\."status" = 'completed'/,
  );
  assert.equal(unitOfWork.queries[1]!.parameters["limit"], 5);
});

test("delivery completion requires the active fencing token", async () => {
  const unitOfWork = new FakeDeliveryUnitOfWork();
  const queue = new PostgresDeliveryQueue(unitOfWork);

  assert.throws(() => queue.complete(consumer, eventId, 0), /Fencing token/);
  assert.equal(unitOfWork.transactionCount, 0);

  unitOfWork.completeRows = [{ eventId }];
  assert.equal(await queue.complete(consumer, eventId, 7), true);
  assert.match(
    unitOfWork.queries[0]!.statement,
    /"fencingToken" = @fencingToken/,
  );
  assert.match(
    unitOfWork.queries[0]!.statement,
    /"leaseUntil" > clock_timestamp\(\)/,
  );
});

test("delivery leases renew and failures use bounded retry or dead-letter state", async () => {
  const unitOfWork = new FakeDeliveryUnitOfWork();
  const queue = new PostgresDeliveryQueue(unitOfWork);
  unitOfWork.renewRows = [{ leaseUntil }];

  assert.equal(await queue.renew(consumer, eventId, 7), leaseUntil);
  assert.match(unitOfWork.queries[0]!.statement, /interval '10 seconds'/);

  unitOfWork.failureRows = [
    { status: "pending", attempts: 3, availableAt: leaseUntil },
  ];
  const retry = await queue.fail(consumer, eventId, 7, "TEMPORARY_FAILURE");
  assert.deepEqual(retry, {
    status: "pending",
    attempts: 3,
    availableAt: leaseUntil,
  });
  assert.match(unitOfWork.queries[1]!.statement, /random\(\)/);
  assert.match(unitOfWork.queries[1]!.statement, /'dead_letter'/);
});

test("delivery queue rejects invalid consumers, limits, identifiers, and errors", async () => {
  const unitOfWork = new FakeDeliveryUnitOfWork();
  const queue = new PostgresDeliveryQueue(unitOfWork);

  assert.throws(() => queue.claim(consumer, 0), /claim limit/);
  assert.throws(() => queue.claim("bad\nconsumer"), /consumer/);
  assert.throws(() => queue.complete(consumer, "bad-id", 1), /UUID/);
  assert.throws(
    () => queue.fail(consumer, eventId, 1, "has spaces"),
    /error code/,
  );
  assert.equal(unitOfWork.transactionCount, 0);
});
