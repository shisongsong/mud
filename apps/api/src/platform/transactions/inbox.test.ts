import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  QueryExecutor,
  SqlParameters,
  UnitOfWork,
} from "./unit-of-work.ts";
import { PostgresInbox } from "./inbox.ts";

class FakeInboxUnitOfWork implements UnitOfWork {
  private processedEvents = new Set<string>();
  domainWriteCount = 0;
  transactionCount = 0;

  async transaction<T>(
    work: (executor: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    const processedEvents = new Set(this.processedEvents);
    let domainWriteCount = this.domainWriteCount;
    const executor: QueryExecutor = {
      query: async <Row extends object>(
        statement: string,
        parameters: SqlParameters = {},
      ): Promise<readonly Row[]> => {
        if (statement.includes('INSERT INTO "platform"."InboxMessages"')) {
          const key = JSON.stringify([
            parameters["consumer"],
            parameters["generation"],
            parameters["eventId"],
          ]);
          if (processedEvents.has(key)) return [];
          processedEvents.add(key);
          return [
            { eventId: parameters["eventId"] },
          ] as unknown as readonly Row[];
        }
        if (statement.includes("INSERT INTO domain.Messages")) {
          domainWriteCount += 1;
          return [];
        }
        throw new Error("Unexpected SQL in inbox test");
      },
    };

    const result = await work(executor);
    this.processedEvents = processedEvents;
    this.domainWriteCount = domainWriteCount;
    return result;
  }
}

const consumer = "query-projection";
const generation = 0;
const eventId = "11111111-1111-4111-8111-111111111111";

test("Inbox ignores duplicate delivery without repeating business work", async () => {
  const unitOfWork = new FakeInboxUnitOfWork();
  const inbox = new PostgresInbox(unitOfWork);
  let handlerCalls = 0;

  const first = await inbox.execute(
    consumer,
    generation,
    eventId,
    async (tx) => {
      handlerCalls += 1;
      await tx.query("INSERT INTO domain.Messages");
      return "projected";
    },
  );
  const duplicate = await inbox.execute(
    consumer,
    generation,
    eventId,
    async () => {
      handlerCalls += 1;
      return "unexpected";
    },
  );

  assert.deepEqual(first, { status: "processed", value: "projected" });
  assert.deepEqual(duplicate, { status: "duplicate" });
  assert.equal(handlerCalls, 1);
  assert.equal(unitOfWork.domainWriteCount, 1);
});

test("Inbox rolls back the claim when business work fails", async () => {
  const unitOfWork = new FakeInboxUnitOfWork();
  const inbox = new PostgresInbox(unitOfWork);

  await assert.rejects(
    inbox.execute(consumer, generation, eventId, async (tx) => {
      await tx.query("INSERT INTO domain.Messages");
      throw new Error("projection failed");
    }),
    /projection failed/,
  );
  assert.equal(unitOfWork.domainWriteCount, 0);

  const retry = await inbox.execute(
    consumer,
    generation,
    eventId,
    async () => "retried",
  );
  assert.deepEqual(retry, { status: "processed", value: "retried" });
});

test("Inbox validates consumer, generation, and event identifiers", async () => {
  const unitOfWork = new FakeInboxUnitOfWork();
  const inbox = new PostgresInbox(unitOfWork);

  await assert.rejects(
    inbox.execute("bad\nconsumer", generation, eventId, async () => undefined),
    /consumer/,
  );
  await assert.rejects(
    inbox.execute(consumer, -1, eventId, async () => undefined),
    /generation/,
  );
  await assert.rejects(
    inbox.execute(consumer, generation, "not-a-uuid", async () => undefined),
    /event ID/,
  );
  assert.equal(unitOfWork.transactionCount, 0);
});
