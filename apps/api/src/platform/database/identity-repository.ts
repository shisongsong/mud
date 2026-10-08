import type { QueryExecutor } from "../transactions/unit-of-work.ts";

export type IdentityAccountStatus =
  | "active"
  | "disabled"
  | "bootstrap_pending";

export interface IdentityAccountRecord {
  readonly accountId: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly status: IdentityAccountStatus;
}

export interface IdentitySessionRecord {
  readonly sessionHash: string;
  readonly accountId: string | null;
  readonly accountStatus: IdentityAccountStatus | null;
  readonly csrfHash: string;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface NewIdentitySession {
  readonly sessionHash: string;
  readonly accountId: string | null;
  readonly csrfHash: string;
  readonly now: Date;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface IdentityRepository {
  createAccount(
    transaction: QueryExecutor,
    account: Pick<IdentityAccountRecord, "accountId" | "username" | "passwordHash">,
  ): Promise<void>;
  getAccountByUsername(
    transaction: QueryExecutor,
    username: string,
  ): Promise<IdentityAccountRecord | null>;
  createSession(
    transaction: QueryExecutor,
    session: NewIdentitySession,
  ): Promise<void>;
  getActiveSession(
    transaction: QueryExecutor,
    sessionHash: string,
    now: Date,
  ): Promise<IdentitySessionRecord | null>;
  touchSession(
    transaction: QueryExecutor,
    sessionHash: string,
    now: Date,
    idleExpiresAt: Date,
  ): Promise<Date | null>;
  revokeSession(
    transaction: QueryExecutor,
    sessionHash: string,
    now: Date,
  ): Promise<void>;
}

export class PostgresIdentityRepository implements IdentityRepository {
  async createAccount(
    transaction: QueryExecutor,
    account: Pick<IdentityAccountRecord, "accountId" | "username" | "passwordHash">,
  ): Promise<void> {
    await transaction.query(
      `
INSERT INTO "identity"."Accounts" ("accountId", "username", "passwordHash")
VALUES (@accountId, @username, @passwordHash);
`,
      account,
    );
  }

  async getAccountByUsername(
    transaction: QueryExecutor,
    username: string,
  ): Promise<IdentityAccountRecord | null> {
    const rows = await transaction.query<IdentityAccountRecord>(
      `
SELECT "accountId" AS "accountId", "username" AS "username",
       "passwordHash" AS "passwordHash", "status" AS "status"
FROM "identity"."Accounts"
WHERE "username" = @username;
`,
      { username },
    );
    return rows[0] ?? null;
  }

  async createSession(
    transaction: QueryExecutor,
    session: NewIdentitySession,
  ): Promise<void> {
    await transaction.query(
      `
INSERT INTO "identity"."Sessions"
  ("sessionHash", "accountId", "csrfHash", "createdAt", "lastSeenAt",
   "expiresAt", "absoluteExpiresAt")
VALUES
  (@sessionHash, @accountId, @csrfHash, @now, @now, @expiresAt, @absoluteExpiresAt);
`,
  { ...session },
    );
  }

  async getActiveSession(
    transaction: QueryExecutor,
    sessionHash: string,
    now: Date,
  ): Promise<IdentitySessionRecord | null> {
    const rows = await transaction.query<IdentitySessionRecord>(
      `
SELECT s."sessionHash" AS "sessionHash", s."accountId" AS "accountId",
       a."status" AS "accountStatus", s."csrfHash" AS "csrfHash",
       s."expiresAt" AS "expiresAt", s."absoluteExpiresAt" AS "absoluteExpiresAt"
FROM "identity"."Sessions" s
LEFT JOIN "identity"."Accounts" a ON a."accountId" = s."accountId"
WHERE s."sessionHash" = @sessionHash AND s."revokedAt" IS NULL
  AND s."expiresAt" > @now AND s."absoluteExpiresAt" > @now
  AND (s."accountId" IS NULL OR a."status" = 'active');
`,
      { sessionHash, now },
    );
    return rows[0] ?? null;
  }

  async touchSession(
    transaction: QueryExecutor,
    sessionHash: string,
    now: Date,
    idleExpiresAt: Date,
  ): Promise<Date | null> {
    const rows = await transaction.query<{ expiresAt: Date }>(
      `
UPDATE "identity"."Sessions"
SET "lastSeenAt" = @now,
    "expiresAt" = LEAST("absoluteExpiresAt", @idleExpiresAt)
WHERE "sessionHash" = @sessionHash AND "revokedAt" IS NULL
  AND "expiresAt" > @now AND "absoluteExpiresAt" > @now
RETURNING "expiresAt" AS "expiresAt";
`,
      { sessionHash, now, idleExpiresAt },
    );
    return rows[0]?.expiresAt ?? null;
  }

  async revokeSession(
    transaction: QueryExecutor,
    sessionHash: string,
    now: Date,
  ): Promise<void> {
    await transaction.query(
      `
UPDATE "identity"."Sessions"
SET "revokedAt" = @now
WHERE "sessionHash" = @sessionHash AND "revokedAt" IS NULL;
`,
      { sessionHash, now },
    );
  }
}