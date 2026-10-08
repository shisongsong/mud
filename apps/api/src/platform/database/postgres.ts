import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import type { AppEnvironment } from "../../config/env.ts";
import type {
  QueryExecutor,
  SqlParameters,
  UnitOfWork,
} from "../transactions/unit-of-work.ts";
import type { MigrationDatabase, MigrationSession } from "./migrator.ts";

export function createPostgresPool(environment: AppEnvironment): Pool {
  if (!environment.DATABASE_URL) {
    throw new Error("DATABASE_URL must be configured for database access");
  }
  const url = new URL(environment.DATABASE_URL);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new TypeError("DATABASE_URL must use the PostgreSQL protocol");
  }
  const verifyCertificate = environment.NODE_ENV === "production";
  return new Pool({
    connectionString: environment.DATABASE_URL,
    ssl: verifyCertificate
      ? {
          rejectUnauthorized: true,
          ...(environment.DATABASE_SSL_CA_FILE
            ? {
                ca: readFileSync(
                  resolve(process.cwd(), environment.DATABASE_SSL_CA_FILE),
                  "utf8",
                ),
              }
            : {}),
        }
      : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(
    work: (executor: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const result = await work(new PostgresQueryExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresQueryExecutor implements QueryExecutor {
  constructor(private readonly client: PoolClient) {}

  async query<T extends object>(
    statement: string,
    parameters: SqlParameters = {},
  ): Promise<readonly T[]> {
    const { text, values } = bindNamedParameters(statement, parameters);
    const result = await this.client.query<T & QueryResultRow>(text, [
      ...values,
    ]);
    return result.rows;
  }
}

export class PostgresMigrationDatabase implements MigrationDatabase {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(
    work: (session: MigrationSession) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new PostgresMigrationSession(client));
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

class PostgresMigrationSession implements MigrationSession {
  constructor(private readonly client: PoolClient) {}

  async acquireMigrationLock(): Promise<void> {
    await this.client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["mud:database:migrations"],
    );
  }

  async ensureHistoryTable(): Promise<void> {
    await this.client.query('CREATE SCHEMA IF NOT EXISTS "platform"');
    await this.client.query(`
CREATE TABLE IF NOT EXISTS "platform"."SchemaMigrations" (
  "migrationId" varchar(128) PRIMARY KEY,
  "appliedAt" timestamptz(3) NOT NULL DEFAULT now()
)`);
  }

  async getAppliedMigrationIds(): Promise<readonly string[]> {
    const result = await this.client.query<{ migrationId: string }>(
      'SELECT "migrationId" AS "migrationId" FROM "platform"."SchemaMigrations" ORDER BY "migrationId"',
    );
    return result.rows.map(({ migrationId }) => migrationId);
  }

  async execute(statement: string): Promise<void> {
    await this.client.query(statement);
  }

  async recordAppliedMigration(id: string): Promise<void> {
    await this.client.query(
      'INSERT INTO "platform"."SchemaMigrations" ("migrationId") VALUES ($1)',
      [id],
    );
  }
}

export function bindNamedParameters(
  statement: string,
  parameters: SqlParameters,
): { text: string; values: readonly unknown[] } {
  const values: unknown[] = [];
  const positions = new Map<string, number>();
  const text = statement.replace(
    /@([A-Za-z][A-Za-z0-9_]*)/g,
    (token, name: string) => {
      if (!(name in parameters)) {
        throw new TypeError(`Missing SQL parameter: ${name}`);
      }
      let position = positions.get(name);
      if (position === undefined) {
        values.push(parameters[name]);
        position = values.length;
        positions.set(name, position);
      }
      return `$${position}`;
    },
  );
  return { text, values };
}
