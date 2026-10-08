export interface DatabaseMigration {
  readonly id: string;
  readonly sql: string;
}

export const migrations: readonly DatabaseMigration[] = [
  {
    id: "0001_platform_reliability",
    sql: `
IF SCHEMA_ID(N'platform') IS NULL EXEC(N'CREATE SCHEMA platform');

CREATE TABLE platform.CommandReceipts (
  actorScope varchar(256) NOT NULL,
  operation varchar(128) NOT NULL,
  idempotencyKey varchar(128) NOT NULL,
  requestDigest char(64) NOT NULL,
  status varchar(16) NOT NULL,
  responseJson nvarchar(max) NULL,
  resourceId varchar(128) NULL,
  operationId varchar(128) NULL,
  createdAt datetime2(3) NOT NULL CONSTRAINT DF_CommandReceipts_createdAt DEFAULT SYSUTCDATETIME(),
  updatedAt datetime2(3) NOT NULL CONSTRAINT DF_CommandReceipts_updatedAt DEFAULT SYSUTCDATETIME(),
  expiresAt datetime2(3) NOT NULL,
  CONSTRAINT PK_CommandReceipts PRIMARY KEY (actorScope, operation, idempotencyKey),
  CONSTRAINT CK_CommandReceipts_status CHECK (status IN ('pending', 'completed')),
  CONSTRAINT CK_CommandReceipts_responseJson CHECK (responseJson IS NULL OR ISJSON(responseJson) = 1)
);

CREATE INDEX IX_CommandReceipts_expiry ON platform.CommandReceipts (expiresAt);

CREATE TABLE platform.OutboxStreams (
  streamId uniqueidentifier NOT NULL,
  nextSequence bigint NOT NULL CONSTRAINT DF_OutboxStreams_nextSequence DEFAULT 1,
  CONSTRAINT PK_OutboxStreams PRIMARY KEY (streamId),
  CONSTRAINT CK_OutboxStreams_nextSequence CHECK (nextSequence > 0)
);

CREATE TABLE platform.OutboxEvents (
  eventId uniqueidentifier NOT NULL,
  streamId uniqueidentifier NOT NULL,
  sequence bigint NOT NULL,
  aggregateId uniqueidentifier NOT NULL,
  aggregateVersion bigint NOT NULL,
  eventType varchar(128) NOT NULL,
  schemaVersion int NOT NULL,
  source varchar(32) NOT NULL,
  releaseVersion varchar(128) NULL,
  occurredAt datetimeoffset(3) NOT NULL,
  traceId uniqueidentifier NOT NULL,
  correlationId uniqueidentifier NOT NULL,
  causationId uniqueidentifier NULL,
  rootEventId uniqueidentifier NOT NULL,
  depth int NOT NULL,
  payloadJson nvarchar(max) NOT NULL,
  createdAt datetime2(3) NOT NULL CONSTRAINT DF_OutboxEvents_createdAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_OutboxEvents PRIMARY KEY (eventId),
  CONSTRAINT UQ_OutboxEvents_stream_sequence UNIQUE (streamId, sequence),
  CONSTRAINT FK_OutboxEvents_stream FOREIGN KEY (streamId) REFERENCES platform.OutboxStreams(streamId),
  CONSTRAINT CK_OutboxEvents_payloadJson CHECK (ISJSON(payloadJson) = 1),
  CONSTRAINT CK_OutboxEvents_versions CHECK (sequence > 0 AND aggregateVersion > 0 AND schemaVersion > 0 AND depth >= 0)
);

CREATE INDEX IX_OutboxEvents_pending ON platform.OutboxEvents (createdAt, streamId, sequence);

CREATE TABLE platform.EventDeliveries (
  eventId uniqueidentifier NOT NULL,
  consumer varchar(128) NOT NULL,
  streamId uniqueidentifier NOT NULL,
  sequence bigint NOT NULL,
  predecessorEventId uniqueidentifier NULL,
  status varchar(16) NOT NULL CONSTRAINT DF_EventDeliveries_status DEFAULT 'pending',
  attempts int NOT NULL CONSTRAINT DF_EventDeliveries_attempts DEFAULT 0,
  availableAt datetime2(3) NOT NULL CONSTRAINT DF_EventDeliveries_availableAt DEFAULT SYSUTCDATETIME(),
  leaseUntil datetime2(3) NULL,
  fencingToken bigint NOT NULL CONSTRAINT DF_EventDeliveries_fencingToken DEFAULT 0,
  lastErrorCode varchar(64) NULL,
  completedAt datetime2(3) NULL,
  CONSTRAINT PK_EventDeliveries PRIMARY KEY (consumer, eventId),
  CONSTRAINT FK_EventDeliveries_event FOREIGN KEY (eventId) REFERENCES platform.OutboxEvents(eventId),
  CONSTRAINT CK_EventDeliveries_status CHECK (status IN ('pending', 'leased', 'completed', 'dead_letter')),
  CONSTRAINT CK_EventDeliveries_counters CHECK (sequence > 0 AND attempts >= 0 AND fencingToken >= 0)
);

CREATE INDEX IX_EventDeliveries_claim ON platform.EventDeliveries (consumer, status, availableAt, streamId, sequence)
  INCLUDE (leaseUntil, fencingToken, attempts, predecessorEventId);

CREATE TABLE platform.InboxMessages (
  consumer varchar(128) NOT NULL,
  generation int NOT NULL CONSTRAINT DF_InboxMessages_generation DEFAULT 0,
  eventId uniqueidentifier NOT NULL,
  processedAt datetime2(3) NOT NULL CONSTRAINT DF_InboxMessages_processedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_InboxMessages PRIMARY KEY (consumer, generation, eventId),
  CONSTRAINT CK_InboxMessages_generation CHECK (generation >= 0)
);

CREATE TABLE platform.AuditRecords (
  auditId uniqueidentifier NOT NULL,
  occurredAt datetime2(3) NOT NULL CONSTRAINT DF_AuditRecords_occurredAt DEFAULT SYSUTCDATETIME(),
  actorType varchar(32) NOT NULL,
  actorRef varchar(256) NOT NULL,
  action varchar(128) NOT NULL,
  targetRef varchar(256) NULL,
  outcome varchar(16) NOT NULL,
  reasonCode varchar(64) NULL,
  traceId uniqueidentifier NOT NULL,
  metadataJson nvarchar(max) NULL,
  CONSTRAINT PK_AuditRecords PRIMARY KEY (auditId),
  CONSTRAINT CK_AuditRecords_outcome CHECK (outcome IN ('succeeded', 'denied', 'failed')),
  CONSTRAINT CK_AuditRecords_metadataJson CHECK (metadataJson IS NULL OR ISJSON(metadataJson) = 1)
);

CREATE INDEX IX_AuditRecords_occurredAt ON platform.AuditRecords (occurredAt DESC, auditId);
`,
  },
  {
    id: "0002_query_aggregates",
    sql: `
IF SCHEMA_ID(N'query') IS NULL EXEC(N'CREATE SCHEMA [query]');

CREATE TABLE [query].QueryRooms (
  queryId uniqueidentifier NOT NULL,
  createdByPlayerId uniqueidentifier NOT NULL,
  gameplayReleaseId varchar(128) NOT NULL,
  phase varchar(24) NOT NULL,
  aggregateVersion bigint NOT NULL,
  createdAt datetime2(3) NOT NULL,
  deadline datetime2(3) NULL,
  explorationStartedAt datetime2(3) NULL,
  scenarioVariantId varchar(128) NULL,
  randomSeed varbinary(64) NULL,
  correctChoice varchar(16) NULL,
  selectedChoice varchar(16) NULL,
  CONSTRAINT PK_QueryRooms PRIMARY KEY (queryId),
  CONSTRAINT CK_QueryRooms_phase CHECK (phase IN ('waiting', 'exploring', 'voting', 'settling', 'settlement_failed', 'completed', 'cancelled')),
  CONSTRAINT CK_QueryRooms_version CHECK (aggregateVersion > 0),
  CONSTRAINT CK_QueryRooms_choices CHECK (
    (correctChoice IS NULL OR correctChoice IN ('choice_1', 'choice_2')) AND
    (selectedChoice IS NULL OR selectedChoice IN ('choice_1', 'choice_2'))
  ),
  CONSTRAINT CK_QueryRooms_scenario CHECK (
    (phase IN ('waiting', 'cancelled') AND scenarioVariantId IS NULL AND randomSeed IS NULL AND correctChoice IS NULL) OR
    (phase NOT IN ('waiting', 'cancelled') AND scenarioVariantId IS NOT NULL AND randomSeed IS NOT NULL AND correctChoice IS NOT NULL)
  )
);

CREATE INDEX IX_QueryRooms_waiting ON [query].QueryRooms (phase, deadline, createdAt)
  INCLUDE (gameplayReleaseId, aggregateVersion)
  WHERE phase = 'waiting';

CREATE TABLE [query].QueryParticipants (
  queryId uniqueidentifier NOT NULL,
  playerId uniqueidentifier NOT NULL,
  joinedAt datetime2(3) NOT NULL,
  participationStatus varchar(16) NOT NULL CONSTRAINT DF_QueryParticipants_status DEFAULT 'confirmed',
  CONSTRAINT PK_QueryParticipants PRIMARY KEY (queryId, playerId),
  CONSTRAINT FK_QueryParticipants_room FOREIGN KEY (queryId) REFERENCES [query].QueryRooms(queryId),
  CONSTRAINT CK_QueryParticipants_status CHECK (participationStatus IN ('reserved', 'confirmed'))
);

CREATE UNIQUE INDEX UX_QueryParticipants_confirmed_player ON [query].QueryParticipants (playerId)
  WHERE participationStatus = 'confirmed';

CREATE TABLE [query].ParticipationSlots (
  playerId uniqueidentifier NOT NULL,
  queryId uniqueidentifier NOT NULL,
  status varchar(16) NOT NULL,
  claimedAt datetime2(3) NOT NULL CONSTRAINT DF_ParticipationSlots_claimedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_ParticipationSlots PRIMARY KEY (playerId),
  CONSTRAINT FK_ParticipationSlots_room FOREIGN KEY (queryId) REFERENCES [query].QueryRooms(queryId),
  CONSTRAINT CK_ParticipationSlots_status CHECK (status IN ('active', 'release_pending', 'settlement_failed'))
);

CREATE INDEX IX_ParticipationSlots_query ON [query].ParticipationSlots (queryId, status, playerId);

CREATE TABLE [query].JoinReservations (
  reservationId uniqueidentifier NOT NULL,
  queryId uniqueidentifier NOT NULL,
  playerId uniqueidentifier NOT NULL,
  status varchar(16) NOT NULL,
  createdAt datetime2(3) NOT NULL CONSTRAINT DF_JoinReservations_createdAt DEFAULT SYSUTCDATETIME(),
  expiresAt datetime2(3) NOT NULL,
  CONSTRAINT PK_JoinReservations PRIMARY KEY (reservationId),
  CONSTRAINT FK_JoinReservations_room FOREIGN KEY (queryId) REFERENCES [query].QueryRooms(queryId),
  CONSTRAINT CK_JoinReservations_status CHECK (status IN ('reserved', 'slot_claimed', 'confirmed', 'released', 'expired'))
);

CREATE UNIQUE INDEX UX_JoinReservations_open_player ON [query].JoinReservations (playerId)
  WHERE status IN ('reserved', 'slot_claimed');

CREATE INDEX IX_JoinReservations_expiry ON [query].JoinReservations (status, expiresAt, queryId);

CREATE TABLE [query].QueryActions (
  queryId uniqueidentifier NOT NULL,
  playerId uniqueidentifier NOT NULL,
  actionOrdinal tinyint NOT NULL,
  siteId varchar(16) NOT NULL,
  cardId uniqueidentifier NOT NULL,
  evidenceText nvarchar(4000) NOT NULL,
  isTruth bit NOT NULL,
  acceptedAt datetime2(3) NOT NULL,
  CONSTRAINT PK_QueryActions PRIMARY KEY (queryId, playerId, actionOrdinal),
  CONSTRAINT UQ_QueryActions_player_site UNIQUE (queryId, playerId, siteId),
  CONSTRAINT UQ_QueryActions_card UNIQUE (cardId),
  CONSTRAINT FK_QueryActions_participant FOREIGN KEY (queryId, playerId) REFERENCES [query].QueryParticipants(queryId, playerId),
  CONSTRAINT CK_QueryActions_ordinal CHECK (actionOrdinal BETWEEN 1 AND 2),
  CONSTRAINT CK_QueryActions_site CHECK (siteId IN ('site_1', 'site_2', 'site_3'))
);

CREATE TABLE [query].QueryVotes (
  queryId uniqueidentifier NOT NULL,
  playerId uniqueidentifier NOT NULL,
  choice varchar(16) NOT NULL,
  updatedAt datetime2(3) NOT NULL,
  CONSTRAINT PK_QueryVotes PRIMARY KEY (queryId, playerId),
  CONSTRAINT FK_QueryVotes_participant FOREIGN KEY (queryId, playerId) REFERENCES [query].QueryParticipants(queryId, playerId),
  CONSTRAINT CK_QueryVotes_choice CHECK (choice IN ('choice_1', 'choice_2', 'abstain'))
);
`,
  },
];
