import sql from "mssql";
export function createSqlServerConfig(environment) {
    if (!environment.SQL_USER || !environment.SQL_PASSWORD) {
        throw new Error("SQL_USER and SQL_PASSWORD must be configured for migrations");
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
export class SqlServerMigrationDatabase {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async transaction(work) {
        const transaction = new sql.Transaction(this.pool);
        await transaction.begin();
        try {
            const result = await work(new SqlServerMigrationSession(transaction));
            await transaction.commit();
            return result;
        }
        catch (error) {
            await transaction.rollback().catch(() => undefined);
            throw error;
        }
    }
}
class SqlServerMigrationSession {
    transaction;
    constructor(transaction) {
        this.transaction = transaction;
    }
    async acquireMigrationLock() {
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
    async ensureHistoryTable() {
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
    async getAppliedMigrationIds() {
        const result = await new sql.Request(this.transaction).query("SELECT migrationId FROM platform.SchemaMigrations ORDER BY migrationId");
        return result.recordset.map(({ migrationId }) => migrationId);
    }
    async execute(statement) {
        await new sql.Request(this.transaction).query(statement);
    }
    async recordAppliedMigration(id) {
        await new sql.Request(this.transaction)
            .input("migrationId", sql.VarChar(128), id)
            .query("INSERT INTO platform.SchemaMigrations (migrationId) VALUES (@migrationId)");
    }
}
