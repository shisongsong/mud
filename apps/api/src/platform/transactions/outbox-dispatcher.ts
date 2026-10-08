import { eventEnvelopeSchema } from "../../contracts/event.ts";
import type { EventEnvelope } from "../../contracts/event.ts";
import { uuidSchema } from "../../contracts/identifiers.ts";
import type { QueryExecutor, UnitOfWork } from "./unit-of-work.ts";

export interface EventSubscription {
  readonly consumer: string;
  readonly eventTypes?: readonly string[];
}

export interface DispatchResult {
  readonly eventId: string;
  readonly sequence: number;
  readonly deliveriesCreated: number;
}

interface StreamCursorRow {
  readonly nextDispatchSequence: number | string;
  readonly nextSequence: number | string;
}

interface PendingStreamRow {
  readonly streamId: string;
}

interface EventRow {
  readonly eventId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly source: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number | string;
  readonly streamId: string;
  readonly sequence: number | string;
  readonly releaseVersion: string | null;
  readonly occurredAt: Date;
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly rootEventId: string;
  readonly depth: number;
  readonly payloadJson: Record<string, unknown>;
}

interface PreviousDeliveryRow {
  readonly eventId: string;
}

export class PostgresOutboxDispatcher {
  private readonly subscriptions: readonly EventSubscription[];

  constructor(
    private readonly unitOfWork: UnitOfWork,
    subscriptions: readonly EventSubscription[],
  ) {
    this.subscriptions = validateSubscriptions(subscriptions);
  }

  dispatchAvailable(limit = 20): Promise<readonly DispatchResult[]> {
    validateBatchLimit(limit);
    return this.unitOfWork.transaction((transaction) =>
      this.dispatchAvailableInTransaction(transaction, limit),
    );
  }

  async dispatchAvailableInTransaction(
    transaction: QueryExecutor,
    limit = 20,
  ): Promise<readonly DispatchResult[]> {
    validateBatchLimit(limit);
    const streams = await transaction.query<PendingStreamRow>(
      `
SELECT "streamId" AS "streamId"
FROM "platform"."OutboxStreams"
WHERE "nextDispatchSequence" < "nextSequence"
ORDER BY "streamId"
FOR UPDATE SKIP LOCKED
LIMIT @limit;
`,
      { limit },
    );
    const dispatched: DispatchResult[] = [];
    for (const { streamId } of streams) {
      const result = await this.dispatchNextInTransaction(
        transaction,
        streamId,
      );
      if (result) dispatched.push(result);
    }
    return dispatched;
  }

  dispatchNext(streamId: string): Promise<DispatchResult | null> {
    validateStreamId(streamId);
    return this.unitOfWork.transaction((transaction) =>
      this.dispatchNextInTransaction(transaction, streamId),
    );
  }

  async dispatchNextInTransaction(
    transaction: QueryExecutor,
    streamId: string,
  ): Promise<DispatchResult | null> {
    validateStreamId(streamId);
    const cursors = await transaction.query<StreamCursorRow>(
      `
SELECT "nextDispatchSequence" AS "nextDispatchSequence",
       "nextSequence" AS "nextSequence"
FROM "platform"."OutboxStreams"
WHERE "streamId" = @streamId
FOR UPDATE SKIP LOCKED;
`,
      { streamId },
    );
    const cursor = cursors[0];
    if (!cursor) return null;

    const nextDispatchSequence = safeSequence(
      cursor.nextDispatchSequence,
      "dispatch cursor",
    );
    const nextSequence = safeSequence(cursor.nextSequence, "next sequence");
    if (nextDispatchSequence > nextSequence) {
      throw new Error("Outbox dispatch cursor is ahead of the stream");
    }
    if (nextDispatchSequence === nextSequence) return null;

    const events = await transaction.query<EventRow>(
      `
SELECT "eventId" AS "eventId", "eventType" AS "eventType",
       "schemaVersion" AS "schemaVersion", "source" AS "source",
       "aggregateId" AS "aggregateId", "aggregateVersion" AS "aggregateVersion",
       "streamId" AS "streamId", "sequence" AS "sequence",
       "releaseVersion" AS "releaseVersion", "occurredAt" AS "occurredAt",
       "traceId" AS "traceId", "correlationId" AS "correlationId",
       "causationId" AS "causationId", "rootEventId" AS "rootEventId",
       "depth" AS "depth", "payloadJson" AS "payloadJson"
FROM "platform"."OutboxEvents"
WHERE "streamId" = @streamId AND "sequence" = @sequence;
`,
      { streamId, sequence: nextDispatchSequence },
    );
    const row = events[0];
    if (!row) {
      throw new Error("Outbox stream contains a missing event sequence");
    }

    const event = mapEvent(row);
    let deliveriesCreated = 0;
    for (const subscription of this.subscriptions) {
      if (
        subscription.eventTypes &&
        !subscription.eventTypes.includes(event.type)
      ) {
        continue;
      }

      const previous = await transaction.query<PreviousDeliveryRow>(
        `
SELECT "eventId" AS "eventId"
FROM "platform"."EventDeliveries"
WHERE "consumer" = @consumer AND "streamId" = @streamId
ORDER BY "sequence" DESC
LIMIT 1;
`,
        { consumer: subscription.consumer, streamId },
      );
      const inserted = await transaction.query<{ eventId: string }>(
        `
INSERT INTO "platform"."EventDeliveries"
  ("eventId", "consumer", "streamId", "sequence", "predecessorEventId")
VALUES (@eventId, @consumer, @streamId, @sequence, @predecessorEventId)
ON CONFLICT ("consumer", "eventId") DO NOTHING
RETURNING "eventId";
`,
        {
          eventId: event.eventId,
          consumer: subscription.consumer,
          streamId,
          sequence: event.sequence,
          predecessorEventId: previous[0]?.eventId ?? null,
        },
      );
      deliveriesCreated += inserted.length;
    }

    const advanced = await transaction.query<{ streamId: string }>(
      `
UPDATE "platform"."OutboxStreams"
SET "nextDispatchSequence" = "nextDispatchSequence" + 1
WHERE "streamId" = @streamId
  AND "nextDispatchSequence" = @sequence
RETURNING "streamId";
`,
      { streamId, sequence: nextDispatchSequence },
    );
    if (advanced.length !== 1) {
      throw new Error("Outbox dispatch cursor changed unexpectedly");
    }

    return {
      eventId: event.eventId,
      sequence: event.sequence,
      deliveriesCreated,
    };
  }
}

function validateSubscriptions(
  subscriptions: readonly EventSubscription[],
): readonly EventSubscription[] {
  const consumers = new Set<string>();
  for (const subscription of subscriptions) {
    if (
      subscription.consumer.length === 0 ||
      subscription.consumer.length > 128 ||
      subscription.consumer.trim() !== subscription.consumer ||
      /[\x00-\x1f\x7f]/.test(subscription.consumer)
    ) {
      throw new TypeError(
        "Event consumer must be a valid 1–128 character name",
      );
    }
    if (consumers.has(subscription.consumer)) {
      throw new TypeError("Event consumer subscriptions must be unique");
    }
    consumers.add(subscription.consumer);
    if (
      subscription.eventTypes?.some(
        (eventType) =>
          eventType.trim() !== eventType ||
          eventType.length === 0 ||
          eventType.length > 128,
      )
    ) {
      throw new TypeError("Subscribed event types must be valid event names");
    }
    if (
      subscription.eventTypes &&
      new Set(subscription.eventTypes).size !== subscription.eventTypes.length
    ) {
      throw new TypeError("Subscribed event types must be unique");
    }
  }
  return subscriptions.map((subscription) =>
    subscription.eventTypes
      ? {
          consumer: subscription.consumer,
          eventTypes: [...subscription.eventTypes],
        }
      : { consumer: subscription.consumer },
  );
}

function validateStreamId(streamId: string): void {
  if (!uuidSchema.safeParse(streamId).success) {
    throw new TypeError("Outbox stream ID must be a UUID");
  }
}

function validateBatchLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError(
      "Outbox dispatch limit must be an integer from 1 to 100",
    );
  }
}

function mapEvent(row: EventRow): EventEnvelope {
  const sequence = safeSequence(row.sequence, "event sequence");
  const aggregateVersion = safeSequence(
    row.aggregateVersion,
    "aggregate version",
  );
  return eventEnvelopeSchema.parse({
    eventId: row.eventId,
    type: row.eventType,
    schemaVersion: row.schemaVersion,
    source: row.source,
    aggregateId: row.aggregateId,
    aggregateVersion,
    streamId: row.streamId,
    sequence,
    releaseVersion: row.releaseVersion,
    occurredAt: row.occurredAt.toISOString(),
    traceId: row.traceId,
    correlationId: row.correlationId,
    causationId: row.causationId,
    rootEventId: row.rootEventId,
    depth: row.depth,
    payload: row.payloadJson,
  });
}

function safeSequence(value: number | string, name: string): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError(`Outbox ${name} is outside the safe range`);
  }
  return sequence;
}
