import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Clock, IdGenerator, RandomSource } from "../kernel/ports.ts";
import {
  Argon2idPasswordHasher,
  PasswordWorkCapacityError,
  type Argon2Operations,
} from "./argon2-password-hasher.ts";
import {
  AuthInvalidCredentialsError,
  AuthSessionError,
  PostgresIdentityService,
} from "./identity.ts";
import type {
  IdentityAccountRecord,
  IdentityRepository,
  IdentitySessionRecord,
  NewIdentitySession,
} from "./database/identity-repository.ts";
import type { QueryExecutor, UnitOfWork } from "./transactions/unit-of-work.ts";

type StoredSession = Omit<IdentitySessionRecord, "expiresAt"> & {
  expiresAt: Date;
  revokedAt: Date | null;
};

interface MemoryTransaction {
  accounts: Map<string, IdentityAccountRecord>;
  sessions: Map<string, StoredSession>;
}

class MemoryIdentityDatabase implements UnitOfWork {
  accounts = new Map<string, IdentityAccountRecord>();
  sessions = new Map<string, StoredSession>();

  async transaction<T>(
    work: (transaction: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    const state: MemoryTransaction = {
      accounts: new Map(this.accounts),
      sessions: new Map(
        [...this.sessions].map(([key, value]) => [key, { ...value }]),
      ),
    };
    const result = await work(state as unknown as QueryExecutor);
    this.accounts = state.accounts;
    this.sessions = state.sessions;
    return result;
  }
}

class MemoryIdentityRepository implements IdentityRepository {
  async createAccount(
    transaction: QueryExecutor,
    account: Pick<
      IdentityAccountRecord,
      "accountId" | "username" | "passwordHash"
    >,
  ): Promise<void> {
    const state = memoryTransaction(transaction);
    if (
      [...state.accounts.values()].some(
        ({ username }) => username === account.username,
      )
    ) {
      throw Object.assign(new Error("duplicate username"), {
        code: "23505",
        constraint: "Accounts_username_key",
      });
    }
    state.accounts.set(account.accountId, { ...account, status: "active" });
  }

  async getAccountByUsername(
    transaction: QueryExecutor,
    username: string,
  ): Promise<IdentityAccountRecord | null> {
    return (
      [...memoryTransaction(transaction).accounts.values()].find(
        (account) => account.username === username,
      ) ?? null
    );
  }

  async createSession(
    transaction: QueryExecutor,
    session: NewIdentitySession,
  ): Promise<void> {
    memoryTransaction(transaction).sessions.set(session.sessionHash, {
      sessionHash: session.sessionHash,
      accountId: session.accountId,
      accountStatus: session.accountId
        ? (memoryTransaction(transaction).accounts.get(session.accountId)
            ?.status ?? null)
        : null,
      csrfHash: session.csrfHash,
      expiresAt: session.expiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      revokedAt: null,
    });
  }

  async getActiveSession(
    transaction: QueryExecutor,
    sessionHash: string,
    now: Date,
  ): Promise<IdentitySessionRecord | null> {
    const state = memoryTransaction(transaction);
    const session = state.sessions.get(sessionHash);
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.absoluteExpiresAt <= now
    ) {
      return null;
    }
    if (session.accountId) {
      const account = state.accounts.get(session.accountId);
      if (!account || account.status !== "active") return null;
      return { ...session, accountStatus: account.status };
    }
    return session;
  }

  async touchSession(
    transaction: QueryExecutor,
    sessionHash: string,
    now: Date,
    idleExpiresAt: Date,
  ): Promise<Date | null> {
    const session = memoryTransaction(transaction).sessions.get(sessionHash);
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.absoluteExpiresAt <= now
    ) {
      return null;
    }
    session.expiresAt = new Date(
      Math.min(idleExpiresAt.getTime(), session.absoluteExpiresAt.getTime()),
    );
    return session.expiresAt;
  }

  async revokeSession(
    transaction: QueryExecutor,
    sessionHash: string,
    now: Date,
  ): Promise<void> {
    const session = memoryTransaction(transaction).sessions.get(sessionHash);
    if (session && !session.revokedAt) session.revokedAt = now;
  }
}

class FastPasswordHasher {
  async hash(password: string): Promise<string> {
    return `hash:${password}`;
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    return passwordHash === `hash:${password}`;
  }
}

class SequentialIds implements IdGenerator {
  private calls = 0;

  next(): string {
    this.calls += 1;
    return `11111111-1111-4111-8111-${String(this.calls).padStart(12, "0")}`;
  }
}

class IncrementingRandom implements RandomSource {
  private value = 1;

  bytes(length: number): Uint8Array {
    return new Uint8Array(length).fill(this.value++);
  }
}

class MutableClock implements Clock {
  value = new Date("2026-10-08T12:00:00.000Z");

  now(): Date {
    return new Date(this.value);
  }
}

function memoryTransaction(transaction: QueryExecutor): MemoryTransaction {
  return transaction as unknown as MemoryTransaction;
}

function createFixture() {
  const database = new MemoryIdentityDatabase();
  const clock = new MutableClock();
  const identity = new PostgresIdentityService(
    database,
    new MemoryIdentityRepository(),
    new FastPasswordHasher(),
    new SequentialIds(),
    new IncrementingRandom(),
    clock,
  );
  return { database, identity, clock };
}

test("anonymous sessions expose CSRF but persist only token digests", async () => {
  const { database, identity } = createFixture();
  const created = await identity.getOrCreateSession(null);
  const resumed = await identity.getOrCreateSession(created.sessionSecret);

  assert.equal(created.view.authenticated, false);
  assert.equal(created.view.csrfToken.length, 43);
  assert.equal(created.cookieChanged, true);
  assert.equal(resumed.cookieChanged, false);
  assert.equal(resumed.sessionSecret, created.sessionSecret);
  assert.equal(resumed.view.csrfToken, created.view.csrfToken);
  assert.equal(database.sessions.size, 1);
  assert.equal(
    [...database.sessions.keys()][0],
    createHashForTest(created.sessionSecret),
  );
  assert.notEqual([...database.sessions.keys()][0], created.sessionSecret);
  assert.notEqual(
    [...database.sessions.values()][0]?.csrfHash,
    created.view.csrfToken,
  );
});

test("registration rotates the anonymous session and normalizes usernames", async () => {
  const { database, identity } = createFixture();
  const anonymous = await identity.getOrCreateSession(null);
  const registered = await identity.register(
    anonymous.sessionSecret,
    anonymous.view.csrfToken,
    "Player_01",
    "a sufficiently long password",
  );

  assert.equal(registered.view.authenticated, true);
  assert.equal(
    registered.view.accountId,
    "11111111-1111-4111-8111-000000000001",
  );
  assert.notEqual(registered.sessionSecret, anonymous.sessionSecret);
  assert.equal(
    database.accounts.get(registered.view.accountId!)?.username,
    "player_01",
  );
  assert.equal(await identity.authenticate(anonymous.sessionSecret), null);
  assert.equal(
    (await identity.authenticate(registered.sessionSecret))?.accountId,
    registered.view.accountId,
  );
  assert.equal(
    [...database.sessions.values()].filter(({ revokedAt }) => revokedAt).length,
    1,
  );
});

test("registration rejects invalid CSRF without committing an account", async () => {
  const { database, identity } = createFixture();
  const anonymous = await identity.getOrCreateSession(null);

  await assert.rejects(
    identity.register(
      anonymous.sessionSecret,
      "A".repeat(43),
      "player_02",
      "a sufficiently long password",
    ),
    AuthSessionError,
  );
  assert.equal(database.accounts.size, 0);
  assert.equal(database.sessions.size, 1);
});

test("login uses generic invalid credentials and rotates valid sessions", async () => {
  const { identity } = createFixture();
  const initial = await identity.getOrCreateSession(null);
  const registered = await identity.register(
    initial.sessionSecret,
    initial.view.csrfToken,
    "player_03",
    "a sufficiently long password",
  );
  const anonymous = await identity.getOrCreateSession(null);

  await assert.rejects(
    identity.login(
      anonymous.sessionSecret,
      anonymous.view.csrfToken,
      "missing_user",
      "a sufficiently long password",
    ),
    AuthInvalidCredentialsError,
  );
  const loggedIn = await identity.login(
    anonymous.sessionSecret,
    anonymous.view.csrfToken,
    "PLAYER_03",
    "a sufficiently long password",
  );

  assert.equal(loggedIn.view.accountId, registered.view.accountId);
  assert.notEqual(loggedIn.sessionSecret, anonymous.sessionSecret);
  assert.equal(await identity.authenticate(anonymous.sessionSecret), null);
});

test("logout requires CSRF and revokes the authenticated session", async () => {
  const { identity } = createFixture();
  const anonymous = await identity.getOrCreateSession(null);
  const registered = await identity.register(
    anonymous.sessionSecret,
    anonymous.view.csrfToken,
    "player_04",
    "a sufficiently long password",
  );

  await assert.rejects(
    identity.logout(registered.sessionSecret, "B".repeat(43)),
    AuthSessionError,
  );
  assert.ok(await identity.authenticate(registered.sessionSecret));
  await identity.logout(registered.sessionSecret, registered.view.csrfToken);
  assert.equal(await identity.authenticate(registered.sessionSecret), null);
});

test("Argon2id adapter uses the approved cost and verifies passwords", async () => {
  const hasher = new Argon2idPasswordHasher();
  const passwordHash = await hasher.hash("a sufficiently long password");

  assert.match(passwordHash, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  assert.equal(
    await hasher.verify(passwordHash, "a sufficiently long password"),
    true,
  );
  assert.equal(await hasher.verify(passwordHash, "wrong password"), false);
});

test("Argon2id adapter bounds concurrent and queued password work", async () => {
  let active = 0;
  let maximumActive = 0;
  const releases: Array<() => void> = [];
  const operations: Argon2Operations = {
    async hash(password) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return password;
    },
    async verify() {
      return true;
    },
  };
  const hasher = new Argon2idPasswordHasher(operations, 1, 1);

  const first = hasher.hash("first");
  const second = hasher.hash("second");
  await assert.rejects(hasher.hash("third"), PasswordWorkCapacityError);
  releases.shift()?.();
  assert.equal(await first, "first");
  releases.shift()?.();
  assert.equal(await second, "second");
  assert.equal(maximumActive, 1);
});

function createHashForTest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
