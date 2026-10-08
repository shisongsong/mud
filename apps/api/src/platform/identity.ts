import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SessionView } from "../contracts/http.ts";
import type { Clock, IdGenerator, RandomSource } from "../kernel/ports.ts";
import type { PasswordHasher } from "./argon2-password-hasher.ts";
import {
  type IdentityRepository,
  type IdentitySessionRecord,
} from "./database/identity-repository.ts";
import type { QueryExecutor, UnitOfWork } from "./transactions/unit-of-work.ts";

const ANONYMOUS_SESSION_MS = 15 * 60 * 1000;
const PLAYER_IDLE_SESSION_MS = 24 * 60 * 60 * 1000;
const PLAYER_ABSOLUTE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_SECRET_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface IssuedSession {
  readonly sessionSecret: string;
  readonly view: SessionView;
  readonly cookieChanged: boolean;
}

export interface AuthenticatedIdentity {
  readonly accountId: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

export class AuthInvalidCredentialsError extends Error {
  readonly code = "AUTH_INVALID_CREDENTIALS";

  constructor() {
    super("Invalid credentials");
    this.name = "AuthInvalidCredentialsError";
  }
}

export class AuthSessionError extends Error {
  readonly code = "AUTH_SESSION_REQUIRED";

  constructor() {
    super("A valid anonymous session and CSRF token are required");
    this.name = "AuthSessionError";
  }
}

export class UsernameUnavailableError extends Error {
  readonly code = "USERNAME_UNAVAILABLE";

  constructor() {
    super("The username is unavailable");
    this.name = "UsernameUnavailableError";
  }
}

export class PostgresIdentityService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly repository: IdentityRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly idGenerator: IdGenerator,
    private readonly randomSource: RandomSource,
    private readonly clock: Clock,
  ) {}

  async getOrCreateSession(secret: string | null): Promise<IssuedSession> {
    const now = this.clock.now();
    return this.unitOfWork.transaction(async (transaction) => {
      if (secret && TOKEN_PATTERN.test(secret)) {
        const existing = await this.findSession(transaction, secret, now);
        if (existing) {
          const idleMs = existing.accountId
            ? PLAYER_IDLE_SESSION_MS
            : ANONYMOUS_SESSION_MS;
          const expiresAt = await this.repository.touchSession(
            transaction,
            existing.sessionHash,
            now,
            new Date(now.getTime() + idleMs),
          );
          if (expiresAt) return this.issueView(secret, existing, expiresAt, false);
        }
      }

      return this.createSession(transaction, null, now, true);
    });
  }

  async register(
    secret: string,
    csrfToken: string,
    username: string,
    password: string,
  ): Promise<IssuedSession> {
    const normalizedUsername = normalizeUsername(username);
    await this.requireAnonymousSession(secret, csrfToken);
    const passwordHash = await this.passwordHasher.hash(password);
    const now = this.clock.now();

    try {
      return await this.unitOfWork.transaction(async (transaction) => {
        await this.requireAnonymousSessionInTransaction(
          transaction,
          secret,
          csrfToken,
          now,
        );
        const accountId = this.idGenerator.next();
        await this.repository.createAccount(transaction, {
          accountId,
          username: normalizedUsername,
          passwordHash,
        });
        await this.repository.revokeSession(
          transaction,
          hashToken(secret),
          now,
        );
        return this.createSession(transaction, accountId, now, true);
      });
    } catch (error: unknown) {
      if (isUsernameConstraintViolation(error)) {
        throw new UsernameUnavailableError();
      }
      throw error;
    }
  }

  async login(
    secret: string,
    csrfToken: string,
    username: string,
    password: string,
  ): Promise<IssuedSession> {
    const normalizedUsername = normalizeUsername(username);
    await this.requireAnonymousSession(secret, csrfToken);
    const account = await this.unitOfWork.transaction((transaction) =>
      this.repository.getAccountByUsername(transaction, normalizedUsername),
    );
    const passwordMatches = account
      ? await this.passwordHasher.verify(account.passwordHash, password)
      : await this.passwordHasher.hash(password).then(() => false);
    if (!account || account.status !== "active" || !passwordMatches) {
      throw new AuthInvalidCredentialsError();
    }

    const now = this.clock.now();
    return this.unitOfWork.transaction(async (transaction) => {
      await this.requireAnonymousSessionInTransaction(
        transaction,
        secret,
        csrfToken,
        now,
      );
      const currentAccount = await this.repository.getAccountByUsername(
        transaction,
        normalizedUsername,
      );
      if (
        !currentAccount ||
        currentAccount.status !== "active" ||
        currentAccount.passwordHash !== account.passwordHash
      ) {
        throw new AuthInvalidCredentialsError();
      }
      await this.repository.revokeSession(
        transaction,
        hashToken(secret),
        now,
      );
      return this.createSession(
        transaction,
        currentAccount.accountId,
        now,
        true,
      );
    });
  }

  async authenticate(secret: string | null): Promise<AuthenticatedIdentity | null> {
    if (!secret || !TOKEN_PATTERN.test(secret)) return null;
    const now = this.clock.now();
    return this.unitOfWork.transaction(async (transaction) => {
      const session = await this.findSession(transaction, secret, now);
      if (!session?.accountId) return null;
      const expiresAt = await this.repository.touchSession(
        transaction,
        session.sessionHash,
        now,
        new Date(now.getTime() + PLAYER_IDLE_SESSION_MS),
      );
      if (!expiresAt) return null;
      return {
        accountId: session.accountId,
        csrfToken: deriveCsrfToken(secret),
        expiresAt,
      };
    });
  }

  async validateCsrf(secret: string | null, csrfToken: string | null): Promise<boolean> {
    if (!secret || !csrfToken || !TOKEN_PATTERN.test(secret)) return false;
    const now = this.clock.now();
    return this.unitOfWork.transaction(async (transaction) => {
      const session = await this.findSession(transaction, secret, now);
      return session !== null && verifyTokenHash(csrfToken, session.csrfHash);
    });
  }

  async logout(secret: string, csrfToken: string): Promise<void> {
    const now = this.clock.now();
    await this.unitOfWork.transaction(async (transaction) => {
      await this.requireSessionInTransaction(
        transaction,
        secret,
        csrfToken,
        now,
      );
      await this.repository.revokeSession(
        transaction,
        hashToken(secret),
        now,
      );
    });
  }

  private async requireAnonymousSession(
    secret: string,
    csrfToken: string,
  ): Promise<void> {
    const now = this.clock.now();
    await this.unitOfWork.transaction((transaction) =>
      this.requireAnonymousSessionInTransaction(
        transaction,
        secret,
        csrfToken,
        now,
      ),
    );
  }

  private async requireAnonymousSessionInTransaction(
    transaction: QueryExecutor,
    secret: string,
    csrfToken: string,
    now: Date,
  ): Promise<IdentitySessionRecord> {
    const session = await this.findSession(transaction, secret, now);
    if (
      !session ||
      session.accountId !== null ||
      !verifyTokenHash(csrfToken, session.csrfHash)
    ) {
      throw new AuthSessionError();
    }
    return session;
  }

  private async requireSessionInTransaction(
    transaction: QueryExecutor,
    secret: string,
    csrfToken: string,
    now: Date,
  ): Promise<IdentitySessionRecord> {
    if (!TOKEN_PATTERN.test(secret)) throw new AuthSessionError();
    const session = await this.findSession(transaction, secret, now);
    if (!session || !verifyTokenHash(csrfToken, session.csrfHash)) {
      throw new AuthSessionError();
    }
    return session;
  }

  private findSession(
    transaction: QueryExecutor,
    secret: string,
    now: Date,
  ): Promise<IdentitySessionRecord | null> {
    return this.repository.getActiveSession(transaction, hashToken(secret), now);
  }

  private async createSession(
    transaction: QueryExecutor,
    accountId: string | null,
    now: Date,
    cookieChanged: boolean,
  ): Promise<IssuedSession> {
    const secret = Buffer.from(
      this.randomSource.bytes(SESSION_SECRET_BYTES),
    ).toString("base64url");
    const csrfToken = deriveCsrfToken(secret);
    const anonymous = accountId === null;
    const idleMs = anonymous ? ANONYMOUS_SESSION_MS : PLAYER_IDLE_SESSION_MS;
    const absoluteMs = anonymous
      ? ANONYMOUS_SESSION_MS
      : PLAYER_ABSOLUTE_SESSION_MS;
    const expiresAt = new Date(now.getTime() + idleMs);
    const absoluteExpiresAt = new Date(now.getTime() + absoluteMs);
    await this.repository.createSession(transaction, {
      sessionHash: hashToken(secret),
      accountId,
      csrfHash: hashToken(csrfToken),
      now,
      expiresAt,
      absoluteExpiresAt,
    });
    return {
      sessionSecret: secret,
      cookieChanged,
      view: {
        authenticated: accountId !== null,
        ...(accountId ? { accountId } : {}),
        expiresAt: expiresAt.toISOString(),
        csrfToken,
        mfaRequired: false,
      },
    };
  }

  private issueView(
    secret: string,
    session: IdentitySessionRecord,
    expiresAt: Date,
    cookieChanged: boolean,
  ): IssuedSession {
    const accountId = session.accountId;
    return {
      sessionSecret: secret,
      cookieChanged,
      view: {
        authenticated: accountId !== null,
        ...(accountId ? { accountId } : {}),
        expiresAt: expiresAt.toISOString(),
        csrfToken: deriveCsrfToken(secret),
        mfaRequired: false,
      },
    };
  }
}

export function normalizeUsername(username: string): string {
  return username.toLowerCase();
}

function deriveCsrfToken(secret: string): string {
  return createHmac("sha256", secret)
    .update("mud:csrf:v1")
    .digest("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function verifyTokenHash(token: string, expectedHash: string): boolean {
  if (!TOKEN_PATTERN.test(token) || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    return false;
  }
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return timingSafeEqual(actual, expected);
}

function isUsernameConstraintViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly constraint?: unknown };
  return (
    candidate.code === "23505" &&
    candidate.constraint === "Accounts_username_key"
  );
}