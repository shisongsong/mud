import { eventEnvelopeSchema } from "../../contracts/event.ts";
import type { EventEnvelope } from "../../contracts/event.ts";
import { canonicalJson } from "../../kernel/idempotency.ts";
import type { QueryExecutor } from "./unit-of-work.ts";

export type OutboxEventInput = Omit<EventEnvelope, "sequence">;

interface SequenceRow {
  readonly sequence: number | string;
}

export class PostgresOutbox {
  async append(
    transaction: QueryExecutor,
    event: OutboxEventInput,
  ): Promise<EventEnvelope> {
    const parsed = eventEnvelopeSchema.safeParse({ ...event, sequence: 1 });
    if (!parsed.success) {
      throw new TypeError("Invalid outbox event envelope");
    }
    const normalized = parsed.data;
    const payloadJson = canonicalJson(normalized.payload);

    await transaction.query(
      `
INSERT INTO "platform"."OutboxStreams" ("streamId")
VALUES (@streamId)
ON CONFLICT ("streamId") DO NOTHING;
`,
      { streamId: normalized.streamId },
    );

    const sequenceRows = await transaction.query<SequenceRow>(
      `
UPDATE "platform"."OutboxStreams"
SET "nextSequence" = "nextSequence" + 1
WHERE "streamId" = @streamId
RETURNING "nextSequence" - 1 AS "sequence";
`,
      { streamId: normalized.streamId },
    );
    const sequence = Number(sequenceRows[0]?.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new RangeError("Outbox stream sequence is outside the safe range");
    }

    await transaction.query(
      `
INSERT INTO "platform"."OutboxEvents"
  ("eventId", "streamId", "sequence", "aggregateId", "aggregateVersion",
   "eventType", "schemaVersion", "source", "releaseVersion", "occurredAt",
   "traceId", "correlationId", "causationId", "rootEventId", "depth", "payloadJson")
VALUES
  (@eventId, @streamId, @sequence, @aggregateId, @aggregateVersion,
   @eventType, @schemaVersion, @source, @releaseVersion, @occurredAt,
   @traceId, @correlationId, @causationId, @rootEventId, @depth, @payloadJson);
`,
      {
        eventId: normalized.eventId,
        streamId: normalized.streamId,
        sequence,
        aggregateId: normalized.aggregateId,
        aggregateVersion: normalized.aggregateVersion,
        eventType: normalized.type,
        schemaVersion: normalized.schemaVersion,
        source: normalized.source,
        releaseVersion: normalized.releaseVersion,
        occurredAt: new Date(normalized.occurredAt),
        traceId: normalized.traceId,
        correlationId: normalized.correlationId,
        causationId: normalized.causationId,
        rootEventId: normalized.rootEventId,
        depth: normalized.depth,
        payloadJson,
      },
    );

    return { ...normalized, sequence };
  }
}
