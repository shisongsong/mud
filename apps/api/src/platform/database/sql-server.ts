import sql from "mssql";
import type { AppEnvironment } from "../../config/env.ts";
import type { MigrationDatabase, MigrationSession } from "./migrator.ts";

export function createSqlServerConfig(environment: AppEnvironment): sql.config {
  if (!environment.SQL_USER || !environment.SQL_PASSWORD) {
    throw new Error(
      "SQL_USER and SQL_PASSWORD must be configured for migrations",
    );
  }

  return {
    server: environment.SQL_SERVER,
    port: environment.SQL_PORT,
    database: environment.SQL_DATABASE,
    user: environment.SQL_USER,
    password: environment.SQL_PASSWORD,
    options: {
      encrypt: environment.SQL_ENCRYPT,
      trustServerCertificate: environment.SQL_TRUST_SERVER_CERTIFICATE,
    },
    pool: { min: 0, max: 5, idleTimeoutMillis: 30_000 },
  };
}

export class SqlServerMigrationDatabase implements MigrationDatabase {
  constructor(private readonly pool: sql.ConnectionPool) {}

  async transaction<T>(
    work: (session: MigrationSession) => Promise<T>,
  ): Promise<T> {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin();

    try {
      const result = await work(new SqlServerMigrationSession(transaction));
      await transaction.commit();
      return result;
    } catch (error: unknown) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }
}

class SqlServerMigrationSession implements MigrationSession {
  constructor(private readonly transaction: sql.Transaction) {}

  async acquireMigrationLock(): Promise<void> {
    await new sql.Request(this.transaction).query(`
DECLARE @lockResult int;
EXEC @lockResult = sys.sp_getapplock
  @Resource = N'mud:database:migrations',
  @LockMode = N'Exclusive',
  @LockOwner = N'Transaction',
  @LockTimeout = 15000;
IF @lockResult < 0 THROW 51000, 'Could not acquire database migration lock', 1;
`);
  }

  async ensureHistoryTable(): Promise<void> {
    await new sql.Request(this.transaction).query(`
IF SCHEMA_ID(N'platform') IS NULL EXEC(N'CREATE SCHEMA platform');
IF OBJECT_ID(N'platform.SchemaMigrations', N'U') IS NULL
BEGIN
  CREATE TABLE platform.SchemaMigrations (
    migrationId varchar(128) NOT NULL CONSTRAINT PK_SchemaMigrations PRIMARY KEY,
    appliedAt datetime2(3) NOT NULL CONSTRAINT DF_SchemaMigrations_appliedAt DEFAULT SYSUTCDATETIME()
  );
END;
`);
  }

  async getAppliedMigrationIds(): Promise<readonly string[]> {
    const result = await new sql.Request(this.transaction).query<{
      migrationId: string;
    }>(
      "SELECT migrationId FROM platform.SchemaMigrations ORDER BY migrationId",
    );
    return result.recordset.map(({ migrationId }) => migrationId);
  }

  async execute(statement: string): Promise<void> {
    await new sql.Request(this.transaction).query(statement);
  }

  async recordAppliedMigration(id: string): Promise<void> {
    await new sql.Request(this.transaction)
      .input("migrationId", sql.VarChar(128), id)
      .query(
        "INSERT INTO platform.SchemaMigrations (migrationId) VALUES (@migrationId)",
      );
  }
}
