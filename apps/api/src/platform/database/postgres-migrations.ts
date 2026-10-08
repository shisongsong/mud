export interface DatabaseMigration {
  readonly id: string;
  readonly sql: string;
}

export const postgresMigrations: readonly DatabaseMigration[] = [
  {
    id: "0001_platform_reliability",
    sql: `
CREATE SCHEMA IF NOT EXISTS "platform";
CREATE TABLE "platform"."CommandReceipts" (
  "actorScope" varchar(256) NOT NULL,
  "operation" varchar(128) NOT NULL,
  "idempotencyKey" varchar(128) NOT NULL,
  "requestDigest" char(64) NOT NULL,
  "status" varchar(16) NOT NULL CHECK ("status" IN ('pending', 'completed')),
  "responseJson" text NULL,
  "resourceId" varchar(128) NULL,
  "operationId" varchar(128) NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamptz(3) NOT NULL DEFAULT now(),
  "expiresAt" timestamptz(3) NOT NULL,
  PRIMARY KEY ("actorScope", "operation", "idempotencyKey"),
  CHECK ("responseJson" IS NULL OR "responseJson"::jsonb IS NOT NULL)
);
CREATE INDEX "IX_CommandReceipts_expiry" ON "platform"."CommandReceipts" ("expiresAt");

CREATE TABLE "platform"."OutboxStreams" (
  "streamId" uuid PRIMARY KEY,
  "nextSequence" bigint NOT NULL DEFAULT 1 CHECK ("nextSequence" > 0)
);
CREATE TABLE "platform"."OutboxEvents" (
  "eventId" uuid PRIMARY KEY,
  "streamId" uuid NOT NULL REFERENCES "platform"."OutboxStreams"("streamId"),
  "sequence" bigint NOT NULL,
  "aggregateId" uuid NOT NULL,
  "aggregateVersion" bigint NOT NULL,
  "eventType" varchar(128) NOT NULL,
  "schemaVersion" integer NOT NULL,
  "source" varchar(32) NOT NULL,
  "releaseVersion" varchar(128) NULL,
  "occurredAt" timestamptz(3) NOT NULL,
  "traceId" uuid NOT NULL,
  "correlationId" uuid NOT NULL,
  "causationId" uuid NULL,
  "rootEventId" uuid NOT NULL,
  "depth" integer NOT NULL,
  "payloadJson" jsonb NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE ("streamId", "sequence"),
  CHECK (jsonb_typeof("payloadJson") IS NOT NULL),
  CHECK ("sequence" > 0 AND "aggregateVersion" > 0 AND "schemaVersion" > 0 AND "depth" >= 0)
);
CREATE INDEX "IX_OutboxEvents_pending" ON "platform"."OutboxEvents" ("createdAt", "streamId", "sequence");

CREATE TABLE "platform"."EventDeliveries" (
  "eventId" uuid NOT NULL REFERENCES "platform"."OutboxEvents"("eventId"),
  "consumer" varchar(128) NOT NULL,
  "streamId" uuid NOT NULL,
  "sequence" bigint NOT NULL,
  "predecessorEventId" uuid NULL,
  "status" varchar(16) NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'leased', 'completed', 'dead_letter')),
  "attempts" integer NOT NULL DEFAULT 0,
  "availableAt" timestamptz(3) NOT NULL DEFAULT now(),
  "leaseUntil" timestamptz(3) NULL,
  "fencingToken" bigint NOT NULL DEFAULT 0,
  "lastErrorCode" varchar(64) NULL,
  "completedAt" timestamptz(3) NULL,
  PRIMARY KEY ("consumer", "eventId"),
  CHECK ("sequence" > 0 AND "attempts" >= 0 AND "fencingToken" >= 0)
);
CREATE INDEX "IX_EventDeliveries_claim" ON "platform"."EventDeliveries" ("consumer", "status", "availableAt", "streamId", "sequence") INCLUDE ("leaseUntil", "fencingToken", "attempts", "predecessorEventId");

CREATE TABLE "platform"."InboxMessages" (
  "consumer" varchar(128) NOT NULL,
  "generation" integer NOT NULL DEFAULT 0 CHECK ("generation" >= 0),
  "eventId" uuid NOT NULL,
  "processedAt" timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("consumer", "generation", "eventId")
);
CREATE TABLE "platform"."AuditRecords" (
  "auditId" uuid PRIMARY KEY,
  "occurredAt" timestamptz(3) NOT NULL DEFAULT now(),
  "actorType" varchar(32) NOT NULL,
  "actorRef" varchar(256) NOT NULL,
  "action" varchar(128) NOT NULL,
  "targetRef" varchar(256) NULL,
  "outcome" varchar(16) NOT NULL CHECK ("outcome" IN ('succeeded', 'denied', 'failed')),
  "reasonCode" varchar(64) NULL,
  "traceId" uuid NOT NULL,
  "metadataJson" jsonb NULL,
  CHECK ("metadataJson" IS NULL OR jsonb_typeof("metadataJson") IS NOT NULL)
);
CREATE INDEX "IX_AuditRecords_occurredAt" ON "platform"."AuditRecords" ("occurredAt" DESC, "auditId");
`,
  },
  {
    id: "0002_query_aggregates",
    sql: `
CREATE SCHEMA IF NOT EXISTS "query";
CREATE TABLE "query"."QueryRooms" (
  "queryId" uuid PRIMARY KEY,
  "createdByPlayerId" uuid NOT NULL,
  "gameplayReleaseId" varchar(128) NOT NULL,
  "phase" varchar(24) NOT NULL CHECK ("phase" IN ('waiting', 'exploring', 'voting', 'settling', 'settlement_failed', 'completed', 'cancelled')),
  "aggregateVersion" bigint NOT NULL CHECK ("aggregateVersion" > 0),
  "createdAt" timestamptz(3) NOT NULL,
  "deadline" timestamptz(3) NULL,
  "explorationStartedAt" timestamptz(3) NULL,
  "scenarioVariantId" varchar(128) NULL,
  "randomSeed" bytea NULL CHECK ("randomSeed" IS NULL OR octet_length("randomSeed") <= 64),
  "correctChoice" varchar(16) NULL CHECK ("correctChoice" IS NULL OR "correctChoice" IN ('choice_1', 'choice_2')),
  "selectedChoice" varchar(16) NULL CHECK ("selectedChoice" IS NULL OR "selectedChoice" IN ('choice_1', 'choice_2')),
  CHECK (("phase" IN ('waiting', 'cancelled') AND "scenarioVariantId" IS NULL AND "randomSeed" IS NULL AND "correctChoice" IS NULL) OR ("phase" NOT IN ('waiting', 'cancelled') AND "scenarioVariantId" IS NOT NULL AND "randomSeed" IS NOT NULL AND "correctChoice" IS NOT NULL))
);
CREATE INDEX "IX_QueryRooms_waiting" ON "query"."QueryRooms" ("phase", "deadline", "createdAt") INCLUDE ("gameplayReleaseId", "aggregateVersion") WHERE "phase" = 'waiting';

CREATE TABLE "query"."QueryParticipants" (
  "queryId" uuid NOT NULL REFERENCES "query"."QueryRooms"("queryId"),
  "playerId" uuid NOT NULL,
  "joinedAt" timestamptz(3) NOT NULL,
  "participationStatus" varchar(16) NOT NULL DEFAULT 'confirmed' CHECK ("participationStatus" IN ('reserved', 'confirmed')),
  PRIMARY KEY ("queryId", "playerId")
);
CREATE UNIQUE INDEX "UX_QueryParticipants_confirmed_player" ON "query"."QueryParticipants" ("playerId") WHERE "participationStatus" = 'confirmed';

CREATE TABLE "query"."ParticipationSlots" (
  "playerId" uuid PRIMARY KEY,
  "queryId" uuid NOT NULL REFERENCES "query"."QueryRooms"("queryId"),
  "status" varchar(16) NOT NULL CHECK ("status" IN ('active', 'release_pending', 'settlement_failed')),
  "claimedAt" timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX "IX_ParticipationSlots_query" ON "query"."ParticipationSlots" ("queryId", "status", "playerId");

CREATE TABLE "query"."JoinReservations" (
  "reservationId" uuid PRIMARY KEY,
  "queryId" uuid NOT NULL REFERENCES "query"."QueryRooms"("queryId"),
  "playerId" uuid NOT NULL,
  "status" varchar(16) NOT NULL CHECK ("status" IN ('reserved', 'slot_claimed', 'confirmed', 'released', 'expired')),
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  "expiresAt" timestamptz(3) NOT NULL
);
CREATE UNIQUE INDEX "UX_JoinReservations_open_player" ON "query"."JoinReservations" ("playerId") WHERE "status" IN ('reserved', 'slot_claimed');
CREATE INDEX "IX_JoinReservations_expiry" ON "query"."JoinReservations" ("status", "expiresAt", "queryId");

CREATE TABLE "query"."QueryActions" (
  "queryId" uuid NOT NULL,
  "playerId" uuid NOT NULL,
  "actionOrdinal" smallint NOT NULL CHECK ("actionOrdinal" BETWEEN 1 AND 2),
  "siteId" varchar(16) NOT NULL CHECK ("siteId" IN ('site_1', 'site_2', 'site_3')),
  "cardId" uuid NOT NULL UNIQUE,
  "evidenceText" varchar(4000) NOT NULL,
  "isTruth" boolean NOT NULL,
  "acceptedAt" timestamptz(3) NOT NULL,
  PRIMARY KEY ("queryId", "playerId", "actionOrdinal"),
  UNIQUE ("queryId", "playerId", "siteId"),
  FOREIGN KEY ("queryId", "playerId") REFERENCES "query"."QueryParticipants"("queryId", "playerId")
);
CREATE TABLE "query"."QueryVotes" (
  "queryId" uuid NOT NULL,
  "playerId" uuid NOT NULL,
  "choice" varchar(16) NOT NULL CHECK ("choice" IN ('choice_1', 'choice_2', 'abstain')),
  "updatedAt" timestamptz(3) NOT NULL,
  PRIMARY KEY ("queryId", "playerId"),
  FOREIGN KEY ("queryId", "playerId") REFERENCES "query"."QueryParticipants"("queryId", "playerId")
);
`,
  },
];
