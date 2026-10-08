import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryExecutor, SqlParameters } from "./unit-of-work.ts";
import { PostgresOutbox } from "./outbox.ts";

class FakeOutboxExecutor implements QueryExecutor {
  readonly statements: string[] = [];
  readonly events: SqlParameters[] = [];
  private readonly nextSequences = new Map<string, number>();

  async query<Row extends object>(
    statement: string,
    parameters: SqlParameters = {},
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    const streamId = String(parameters["streamId"]);

    if (statement.includes('INSERT INTO "platform"."OutboxStreams"')) {
      if (!this.nextSequences.has(streamId))
        this.nextSequences.set(streamId, 1);
      return [];
    }
    if (statement.includes('UPDATE "platform"."OutboxStreams"')) {
      const sequence = this.nextSequences.get(streamId);
      if (sequence === undefined)
        throw new Error("Outbox stream was not created");
      this.nextSequences.set(streamId, sequence + 1);
      return [{ sequence }] as unknown as readonly Row[];
    }
    if (statement.includes('INSERT INTO "platform"."OutboxEvents"')) {
      this.events.push(parameters);
      return [];
    }
    throw new Error("Unexpected SQL in outbox test");
  }
}

const streamId = "33333333-3333-4333-8333-333333333333";
const baseEvent = {
  eventId: "11111111-1111-4111-8111-111111111111",
  type: "QueryCreated",
  schemaVersion: 1,
  source: "query" as const,
  aggregateId: "22222222-2222-4222-8222-222222222222",
  aggregateVersion: 1,
  streamId,
  releaseVersion: "gameplay_v1",
  occurredAt: "2026-10-08T12:00:00.000Z",
  traceId: "44444444-4444-4444-8444-444444444444",
  correlationId: "55555555-5555-4555-8555-555555555555",
  causationId: null,
  rootEventId: "11111111-1111-4111-8111-111111111111",
  depth: 0,
  payload: { queryId: "22222222-2222-4222-8222-222222222222" },
};

test("Outbox assigns contiguous sequences for each stream", async () => {
  const outbox = new PostgresOutbox();
  const transaction = new FakeOutboxExecutor();

  const first = await outbox.append(transaction, baseEvent);
  const second = await outbox.append(transaction, {
    ...baseEvent,
    eventId: "66666666-6666-4666-8666-666666666666",
  });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(
    transaction.events.map((event) => event["sequence"]),
    [1, 2],
  );
  assert.equal(
    transaction.events[0]?.["payloadJson"],
    '{"queryId":"22222222-2222-4222-8222-222222222222"}',
  );
});

test("Outbox rejects invalid event envelopes before touching the transaction", async () => {
  const outbox = new PostgresOutbox();
  const transaction = new FakeOutboxExecutor();

  await assert.rejects(
    outbox.append(transaction, { ...baseEvent, depth: -1 }),
    /Invalid outbox event envelope/,
  );
  assert.equal(transaction.statements.length, 0);
});

test("Outbox rejects non-JSON payload values before touching the transaction", async () => {
  const outbox = new PostgresOutbox();
  const transaction = new FakeOutboxExecutor();

  await assert.rejects(
    outbox.append(transaction, {
      ...baseEvent,
      payload: { missing: undefined },
    }),
    /undefined values/,
  );
  assert.equal(transaction.statements.length, 0);
});
