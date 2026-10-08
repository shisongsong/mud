import sql from "mssql";
import { loadEnvironment } from "../../config/env.js";
import { applyMigrations } from "./migrator.js";
import { migrations } from "./migrations.js";
import { createSqlServerConfig, SqlServerMigrationDatabase, } from "./sql-server.js";
const pool = new sql.ConnectionPool(createSqlServerConfig(loadEnvironment()));
try {
    await pool.connect();
    const applied = await applyMigrations(new SqlServerMigrationDatabase(pool), migrations);
    console.info(applied.length === 0
        ? "Database schema is up to date."
        : `Applied migrations: ${applied.join(", ")}`);
}
catch (error) {
    console.error("Database migration failed.", error);
    process.exitCode = 1;
}
finally {
    if (pool.connected)
        await pool.close();
}
