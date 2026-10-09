import { createHash } from "node:crypto";
import { canonicalJson } from "../../kernel/idempotency.ts";

export interface DatabaseMigration {
  readonly id: string;
  readonly sql: string;
}

export const trial1GameplaySnapshot = {
  queryEnabled: true,
  templates: ["trial_1"],
  content: {
    trial_1: {
      choices: [
        {
          choiceId: "choice_1",
          messageKey: "trial.choice.mark",
          args: { mark: "K1" },
        },
        {
          choiceId: "choice_2",
          messageKey: "trial.choice.mark",
          args: { mark: "K2" },
        },
      ],
      variants: [
        {
          variantId: "variant_1",
          correctChoiceId: "choice_1",
          explanationKey: "trial.explanation.current_mark",
          evidence: [
            {
              siteId: "site_1",
              messageKey: "trial.evidence.current_mark",
              args: { mark: "K1" },
              isTruth: true,
            },
            {
              siteId: "site_2",
              messageKey: "trial.evidence.same_mark_rule",
              args: {},
              isTruth: true,
            },
            {
              siteId: "site_3",
              messageKey: "trial.evidence.unsigned_rumor",
              args: { mark: "K2" },
              isTruth: false,
            },
          ],
        },
        {
          variantId: "variant_2",
          correctChoiceId: "choice_2",
          explanationKey: "trial.explanation.current_mark",
          evidence: [
            {
              siteId: "site_1",
              messageKey: "trial.evidence.current_mark",
              args: { mark: "K2" },
              isTruth: true,
            },
            {
              siteId: "site_2",
              messageKey: "trial.evidence.same_mark_rule",
              args: {},
              isTruth: true,
            },
            {
              siteId: "site_3",
              messageKey: "trial.evidence.unsigned_rumor",
              args: { mark: "K1" },
              isTruth: false,
            },
          ],
        },
      ],
    },
  },
} as const;

export const trial1GameplayChecksum = createHash("sha256")
  .update(canonicalJson(trial1GameplaySnapshot), "utf8")
  .digest("hex");

export const trial1GlossarySnapshot = {
  locale: "zh-CN",
  entries: {
    "trial.choice.mark": "编号 {mark}",
    "trial.evidence.current_mark": "有效记录：本轮有效印记为编号 {mark}",
    "trial.evidence.same_mark_rule":
      "有效记录：仅选择编号与有效印记相同的候选才符合目标",
    "trial.evidence.unsigned_rumor":
      "未署名传闻：应选编号 {mark}；有效印记记录可能已过时",
    "trial.explanation.current_mark": "选择与本轮有效印记一致的候选。",
  },
} as const;

export const trial1GlossaryChecksum = createHash("sha256")
  .update(canonicalJson(trial1GlossarySnapshot), "utf8")
  .digest("hex");

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
  {
    id: "0003_outbox_dispatch_cursor",
    sql: `
ALTER TABLE "platform"."OutboxStreams"
ADD COLUMN "nextDispatchSequence" bigint NOT NULL DEFAULT 1
CHECK ("nextDispatchSequence" > 0);
`,
  },
  {
    id: "0004_identity_accounts_sessions",
    sql: `
CREATE SCHEMA IF NOT EXISTS "identity";
CREATE TABLE "identity"."Accounts" (
  "accountId" uuid PRIMARY KEY,
  "username" varchar(32) COLLATE "C" NOT NULL UNIQUE
    CHECK ("username" ~ '^[a-z0-9_]{3,32}$'),
  "passwordHash" varchar(255) NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'active'
    CHECK ("status" IN ('active', 'disabled', 'bootstrap_pending')),
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE "identity"."Sessions" (
  "sessionHash" char(64) PRIMARY KEY,
  "accountId" uuid NULL REFERENCES "identity"."Accounts"("accountId") ON DELETE CASCADE,
  "csrfHash" char(64) NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  "lastSeenAt" timestamptz(3) NOT NULL DEFAULT now(),
  "expiresAt" timestamptz(3) NOT NULL,
  "absoluteExpiresAt" timestamptz(3) NOT NULL,
  "revokedAt" timestamptz(3) NULL,
  CHECK ("expiresAt" <= "absoluteExpiresAt")
);
CREATE INDEX "IX_IdentitySessions_account" ON "identity"."Sessions" ("accountId", "expiresAt")
  WHERE "accountId" IS NOT NULL AND "revokedAt" IS NULL;
CREATE INDEX "IX_IdentitySessions_expiry" ON "identity"."Sessions" ("expiresAt");
`,
  },
  {
    id: "0005_player_profiles",
    sql: `
CREATE SCHEMA IF NOT EXISTS "player";
CREATE TABLE "player"."Players" (
  "playerId" uuid PRIMARY KEY,
  "accountId" uuid NOT NULL UNIQUE
    REFERENCES "identity"."Accounts"("accountId") ON DELETE CASCADE,
  "displayName" varchar(80) NOT NULL
    CHECK (char_length("displayName") BETWEEN 2 AND 20),
  "factionId" varchar(32) NOT NULL
    CHECK ("factionId" IN ('faction_1', 'faction_2', 'faction_3', 'faction_4', 'faction_5', 'faction_6')),
  "powerId" varchar(32) NOT NULL
    CHECK ("powerId" IN ('power_1', 'power_2')),
  "professionId" varchar(32) NOT NULL
    CHECK ("professionId" IN ('profession_1', 'profession_2', 'profession_3', 'profession_4', 'profession_5', 'profession_6')),
  "gameplayReleaseId" varchar(128) NOT NULL,
  "score" integer NOT NULL DEFAULT 1000 CHECK ("score" BETWEEN 0 AND 2147483647),
  "aggregateVersion" bigint NOT NULL DEFAULT 1 CHECK ("aggregateVersion" > 0),
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamptz(3) NOT NULL DEFAULT now()
);
`,
  },
  {
    id: "0006_bootstrap_releases",
    sql: `
CREATE SCHEMA IF NOT EXISTS "control";
CREATE TABLE "control"."ConfigReleases" (
  "releaseKind" varchar(16) NOT NULL CHECK ("releaseKind" IN ('gameplay', 'glossary')),
  "releaseId" varchar(128) NOT NULL,
  "manifestChecksum" char(64) NOT NULL CHECK ("manifestChecksum" ~ '^[a-f0-9]{64}$'),
  "snapshotJson" jsonb NOT NULL CHECK (jsonb_typeof("snapshotJson") = 'object'),
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("releaseKind", "releaseId")
);
CREATE TABLE "control"."ActiveReleasePointers" (
  "releaseKind" varchar(16) PRIMARY KEY CHECK ("releaseKind" IN ('gameplay', 'glossary')),
  "releaseId" varchar(128) NOT NULL,
  "version" bigint NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "updatedAt" timestamptz(3) NOT NULL DEFAULT now(),
  FOREIGN KEY ("releaseKind", "releaseId")
    REFERENCES "control"."ConfigReleases"("releaseKind", "releaseId")
);
CREATE FUNCTION "control"."reject_config_release_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'configuration releases are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER "TR_ConfigReleases_immutable"
BEFORE UPDATE OR DELETE ON "control"."ConfigReleases"
FOR EACH ROW EXECUTE FUNCTION "control"."reject_config_release_mutation"();

INSERT INTO "control"."ConfigReleases"
  ("releaseKind", "releaseId", "manifestChecksum", "snapshotJson")
VALUES
  ('gameplay', 'gameplay_bootstrap_v1',
   '1cfe180ace5d11ee8296524d46345c48a75b42c9c1d47b69f36de13282d56283',
   '{"queryEnabled":false,"templates":["trial_1"]}'::jsonb),
  ('glossary', 'glossary_bootstrap_v1',
   'a21e6c786546b559f5797e2adf887d169eb28be0120a83a3ddda898395b92290',
   '{"entries":{},"locale":"zh-CN"}'::jsonb)
ON CONFLICT ("releaseKind", "releaseId") DO NOTHING;
INSERT INTO "control"."ActiveReleasePointers" ("releaseKind", "releaseId")
VALUES
  ('gameplay', 'gameplay_bootstrap_v1'),
  ('glossary', 'glossary_bootstrap_v1')
ON CONFLICT ("releaseKind") DO NOTHING;
`,
  },
  {
    id: "0007_trial_1_content_release",
    sql: `
INSERT INTO "control"."ConfigReleases"
  ("releaseKind", "releaseId", "manifestChecksum", "snapshotJson")
VALUES
  ('gameplay', 'gameplay_trial_1_v1', '${trial1GameplayChecksum}',
   ${sqlStringLiteral(JSON.stringify(trial1GameplaySnapshot))}::jsonb)
ON CONFLICT ("releaseKind", "releaseId") DO NOTHING;
INSERT INTO "control"."ConfigReleases"
  ("releaseKind", "releaseId", "manifestChecksum", "snapshotJson")
VALUES
  ('glossary', 'glossary_trial_1_v1', '${trial1GlossaryChecksum}',
   ${sqlStringLiteral(JSON.stringify(trial1GlossarySnapshot))}::jsonb)
ON CONFLICT ("releaseKind", "releaseId") DO NOTHING;
`,
  },
  {
    id: "0008_query_settlement_plan",
    sql: `
CREATE TABLE "query"."SettlementPlans" (
  "queryId" uuid PRIMARY KEY REFERENCES "query"."QueryRooms"("queryId"),
  "settlementId" varchar(128) NOT NULL UNIQUE
);
CREATE TABLE "query"."SettlementTargets" (
  "queryId" uuid NOT NULL REFERENCES "query"."SettlementPlans"("queryId"),
  "effectKey" varchar(256) NOT NULL,
  PRIMARY KEY ("queryId", "effectKey")
);
`,
  },
  {
    id: "0009_query_settlement_confirmations",
    sql: `
CREATE TABLE "query"."SettlementConfirmations" (
  "queryId" uuid NOT NULL,
  "effectKey" varchar(256) NOT NULL,
  "resultReference" varchar(512) NOT NULL CHECK (length(btrim("resultReference")) > 0),
  "confirmedAt" timestamptz(3) NOT NULL,
  PRIMARY KEY ("queryId", "effectKey"),
  FOREIGN KEY ("queryId", "effectKey")
    REFERENCES "query"."SettlementTargets"("queryId", "effectKey")
);
`,
  },
  {
    id: "0010_player_score_ledger",
    sql: `
ALTER TABLE "player"."Players" DROP CONSTRAINT "Players_score_check";
ALTER TABLE "player"."Players"
  ADD CONSTRAINT "CK_Players_score_range" CHECK ("score" BETWEEN 0 AND 1000000000);
CREATE TABLE "player"."ScoreEntries" (
  "effectId" varchar(256) PRIMARY KEY,
  "playerId" uuid NOT NULL REFERENCES "player"."Players"("playerId") ON DELETE CASCADE,
  "requestedDelta" integer NOT NULL CHECK ("requestedDelta" BETWEEN 0 AND 1000000000),
  "effectiveDelta" integer NOT NULL CHECK ("effectiveDelta" BETWEEN 0 AND 1000000000),
  "scoreBefore" integer NOT NULL CHECK ("scoreBefore" BETWEEN 0 AND 1000000000),
  "scoreAfter" integer NOT NULL CHECK ("scoreAfter" BETWEEN 0 AND 1000000000),
  "aggregateVersion" bigint NOT NULL CHECK ("aggregateVersion" > 0),
  "clamped" boolean NOT NULL,
  "reasonRef" varchar(256) NOT NULL CHECK (length(btrim("reasonRef")) > 0),
  "appliedAt" timestamptz(3) NOT NULL,
  CHECK ("scoreAfter" - "scoreBefore" = "effectiveDelta"),
  CHECK ("effectiveDelta" <= "requestedDelta"),
  CHECK ("clamped" = ("effectiveDelta" < "requestedDelta"))
);
CREATE INDEX "IX_PlayerScoreEntries_player" ON "player"."ScoreEntries" ("playerId", "appliedAt", "effectId");
`,
  },
  {
    id: "0011_query_settlement_point_awards",
    sql: `
CREATE TABLE "query"."SettlementPointAwards" (
  "queryId" uuid NOT NULL REFERENCES "query"."SettlementPlans"("queryId"),
  "playerId" uuid NOT NULL,
  "requestedDelta" smallint NOT NULL CHECK ("requestedDelta" BETWEEN 0 AND 25),
  PRIMARY KEY ("queryId", "playerId"),
  FOREIGN KEY ("queryId", "playerId")
    REFERENCES "query"."QueryParticipants"("queryId", "playerId")
);
`,
  },
];
