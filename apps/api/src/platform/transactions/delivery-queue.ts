import { eventEnvelopeSchema } from "../../contracts/event.ts";
import type { EventEnvelope } from "../../contracts/event.ts";
import { uuidSchema } from "../../contracts/identifiers.ts";
import type { QueryExecutor, UnitOfWork } from "./unit-of-work.ts";

const MAX_DELIVERY_ATTEMPTS = 12;

export interface ClaimedDelivery {
  readonly consumer: string;
  readonly eventId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly predecessorEventId: string | null;
  readonly attempts: number;
  readonly leaseUntil: Date;
  readonly fencingToken: number;
  readonly event: EventEnvelope;
}

export type DeliveryFailure = {
  readonly status: "pending" | "dead_letter";
  readonly attempts: number;
  readonly availableAt: Date;
};

interface DeliveryRow {
  readonly consumer: string;
  readonly eventId: string;
  readonly streamId: string;
  readonly sequence: number | string;
  readonly predecessorEventId: string | null;
  readonly attempts: number;
  readonly leaseUntil: Date;
  readonly fencingToken: number | string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly source: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number | string;
  readonly releaseVersion: string | null;
  readonly occurredAt: Date;
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly rootEventId: string;
  readonly depth: number;
  readonly payloadJson: Record<string, unknown>;
}

interface RenewedLeaseRow {
  readonly leaseUntil: Date;
}

interface FailedDeliveryRow {
  readonly status: "pending" | "dead_letter";
  readonly attempts: number;
  readonly availableAt: Date;
}

export class PostgresDeliveryQueue {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  claim(consumer: string, limit = 20): Promise<readonly ClaimedDelivery[]> {
    validateClaim(consumer, limit);
    return this.unitOfWork.transaction((transaction) =>
      this.claimInTransaction(transaction, consumer, limit),
    );
  }

  async claimInTransaction(
    transaction: QueryExecutor,
    consumer: string,
    limit = 20,
  ): Promise<readonly ClaimedDelivery[]> {
    validateClaim(consumer, limit);

    await transaction.query(
      `
UPDATE "platform"."EventDeliveries"
SET "status" = 'dead_letter', "leaseUntil" = NULL,
    "lastErrorCode" = COALESCE("lastErrorCode", 'MAX_ATTEMPTS_EXCEEDED')
WHERE "consumer" = @consumer AND "status" = 'leased'
  AND "leaseUntil" <= clock_timestamp() AND "attempts" >= @maxAttempts;
`,
      { consumer, maxAttempts: MAX_DELIVERY_ATTEMPTS },
    );

    const rows = await transaction.query<DeliveryRow>(
      `
WITH candidates AS (
  SELECT d."consumer", d."eventId"
  FROM "platform"."EventDeliveries" AS d
  WHERE d."consumer" = @consumer
    AND d."attempts" < @maxAttempts
    AND ((d."status" = 'pending' AND d."availableAt" <= clock_timestamp())
      OR (d."status" = 'leased' AND d."leaseUntil" <= clock_timestamp()))
    AND (d."predecessorEventId" IS NULL OR EXISTS (
      SELECT 1
      FROM "platform"."EventDeliveries" AS predecessor
      WHERE predecessor."consumer" = d."consumer"
        AND predecessor."eventId" = d."predecessorEventId"
        AND predecessor."streamId" = d."streamId"
        AND predecessor."status" = 'completed'
    ))
  ORDER BY d."availableAt", d."streamId", d."sequence"
  FOR UPDATE OF d SKIP LOCKED
  LIMIT @limit
), claimed AS (
  UPDATE "platform"."EventDeliveries" AS d
  SET "status" = 'leased',
      "attempts" = d."attempts" + 1,
      "leaseUntil" = clock_timestamp() + interval '30 seconds',
      "fencingToken" = d."fencingToken" + 1
  FROM candidates AS c
  WHERE d."consumer" = c."consumer" AND d."eventId" = c."eventId"
  RETURNING d."consumer", d."eventId", d."streamId", d."sequence",
            d."predecessorEventId", d."attempts", d."leaseUntil", d."fencingToken"
)
SELECT c."consumer" AS "consumer", c."eventId" AS "eventId",
       c."streamId" AS "streamId", c."sequence" AS "sequence",
       c."predecessorEventId" AS "predecessorEventId",
       c."attempts" AS "attempts", c."leaseUntil" AS "leaseUntil",
       c."fencingToken" AS "fencingToken",
       e."eventType" AS "eventType", e."schemaVersion" AS "schemaVersion",
       e."source" AS "source", e."aggregateId" AS "aggregateId",
       e."aggregateVersion" AS "aggregateVersion",
       e."releaseVersion" AS "releaseVersion", e."occurredAt" AS "occurredAt",
       e."traceId" AS "traceId", e."correlationId" AS "correlationId",
       e."causationId" AS "causationId", e."rootEventId" AS "rootEventId",
       e."depth" AS "depth", e."payloadJson" AS "payloadJson"
FROM claimed AS c
JOIN "platform"."OutboxEvents" AS e ON e."eventId" = c."eventId"
ORDER BY c."streamId", c."sequence";
`,
      { consumer, limit, maxAttempts: MAX_DELIVERY_ATTEMPTS },
    );

    return rows.map(mapClaimedDelivery);
  }

  complete(
    consumer: string,
    eventId: string,
    fencingToken: number,
  ): Promise<boolean> {
    validateLeaseKey(consumer, eventId, fencingToken);
    return this.unitOfWork.transaction((transaction) =>
      this.completeInTransaction(transaction, consumer, eventId, fencingToken),
    );
  }

  renew(
    consumer: string,
    eventId: string,
    fencingToken: number,
  ): Promise<Date | null> {
    validateLeaseKey(consumer, eventId, fencingToken);
    return this.unitOfWork.transaction((transaction) =>
      this.renewInTransaction(transaction, consumer, eventId, fencingToken),
    );
  }

  async completeInTransaction(
    transaction: QueryExecutor,
    consumer: string,
    eventId: string,
    fencingToken: number,
  ): Promise<boolean> {
    validateLeaseKey(consumer, eventId, fencingToken);
    const rows = await transaction.query<{ eventId: string }>(
      `
UPDATE "platform"."EventDeliveries"
SET "status" = 'completed', "completedAt" = clock_timestamp(), "leaseUntil" = NULL
WHERE "consumer" = @consumer AND "eventId" = @eventId
  AND "status" = 'leased' AND "fencingToken" = @fencingToken
  AND "leaseUntil" > clock_timestamp()
RETURNING "eventId";
`,
      { consumer, eventId, fencingToken },
    );
    return rows.length === 1;
  }

  async renewInTransaction(
    transaction: QueryExecutor,
    consumer: string,
    eventId: string,
    fencingToken: number,
  ): Promise<Date | null> {
    validateLeaseKey(consumer, eventId, fencingToken);
    const rows = await transaction.query<RenewedLeaseRow>(
      `
UPDATE "platform"."EventDeliveries"
SET "leaseUntil" = clock_timestamp() + interval '10 seconds'
WHERE "consumer" = @consumer AND "eventId" = @eventId
  AND "status" = 'leased' AND "fencingToken" = @fencingToken
  AND "leaseUntil" > clock_timestamp()
RETURNING "leaseUntil";
`,
      { consumer, eventId, fencingToken },
    );
    return rows[0]?.leaseUntil ?? null;
  }

  async failInTransaction(
    transaction: QueryExecutor,
    consumer: string,
    eventId: string,
    fencingToken: number,
    errorCode: string,
  ): Promise<DeliveryFailure | null> {
    validateLeaseKey(consumer, eventId, fencingToken);
    validateErrorCode(errorCode);

    const rows = await transaction.query<FailedDeliveryRow>(
      `
UPDATE "platform"."EventDeliveries"
SET "status" = CASE WHEN "attempts" >= @maxAttempts THEN 'dead_letter' ELSE 'pending' END,
    "availableAt" = CASE WHEN "attempts" >= @maxAttempts THEN "availableAt"
      ELSE clock_timestamp() +
        (random() * LEAST(300000.0, 1000.0 * power(2.0, LEAST("attempts" - 1, 20))))
        * interval '1 millisecond'
      END,
    "leaseUntil" = NULL, "lastErrorCode" = @errorCode
WHERE "consumer" = @consumer AND "eventId" = @eventId
  AND "status" = 'leased' AND "fencingToken" = @fencingToken
  AND "leaseUntil" > clock_timestamp()
RETURNING "status", "attempts", "availableAt";
`,
      {
        consumer,
        eventId,
        fencingToken,
        errorCode,
        maxAttempts: MAX_DELIVERY_ATTEMPTS,
      },
    );
    const failure = rows[0];
    return failure ?? null;
  }

  fail(
    consumer: string,
    eventId: string,
    fencingToken: number,
    errorCode: string,
  ): Promise<DeliveryFailure | null> {
    validateLeaseKey(consumer, eventId, fencingToken);
    validateErrorCode(errorCode);
    return this.unitOfWork.transaction((transaction) =>
      this.failInTransaction(
        transaction,
        consumer,
        eventId,
        fencingToken,
        errorCode,
      ),
    );
  }
}

function mapClaimedDelivery(row: DeliveryRow): ClaimedDelivery {
  const sequence = safeInteger(row.sequence, "sequence");
  const fencingToken = safeInteger(row.fencingToken, "fencing token");
  const aggregateVersion = safeInteger(
    row.aggregateVersion,
    "aggregate version",
  );
  const event = eventEnvelopeSchema.parse({
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

  return {
    consumer: row.consumer,
    eventId: row.eventId,
    streamId: row.streamId,
    sequence,
    predecessorEventId: row.predecessorEventId,
    attempts: row.attempts,
    leaseUntil: row.leaseUntil,
    fencingToken,
    event,
  };
}

function validateClaim(consumer: string, limit: number): void {
  validateConsumer(consumer);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError(
      "Delivery claim limit must be an integer from 1 to 100",
    );
  }
}

function validateLeaseKey(
  consumer: string,
  eventId: string,
  fencingToken: number,
): void {
  validateConsumer(consumer);
  if (!uuidSchema.safeParse(eventId).success) {
    throw new TypeError("Delivery event ID must be a UUID");
  }
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    throw new RangeError("Fencing token must be a positive safe integer");
  }
}

function validateConsumer(consumer: string): void {
  if (
    consumer.length === 0 ||
    consumer.length > 128 ||
    consumer.trim() !== consumer ||
    /[\x00-\x1f\x7f]/.test(consumer)
  ) {
    throw new TypeError(
      "Delivery consumer must be a valid 1–128 character name",
    );
  }
}

function validateErrorCode(errorCode: string): void {
  if (!/^[\x21-\x7e]{1,64}$/.test(errorCode)) {
    throw new TypeError(
      "Delivery error code must be 1–64 visible ASCII characters",
    );
  }
}

function safeInteger(value: number | string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`Delivery ${name} is outside the safe range`);
  }
  return parsed;
}
