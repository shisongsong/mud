import sql from "mssql";
import { loadEnvironment } from "../../config/env.ts";
import { applyMigrations } from "./migrator.ts";
import { migrations } from "./migrations.ts";
import {
  createSqlServerConfig,
  SqlServerMigrationDatabase,
} from "./sql-server.ts";

const pool = new sql.ConnectionPool(createSqlServerConfig(loadEnvironment()));

try {
  await pool.connect();
  const applied = await applyMigrations(
    new SqlServerMigrationDatabase(pool),
    migrations,
  );
  console.info(
    applied.length === 0
      ? "Database schema is up to date."
      : `Applied migrations: ${applied.join(", ")}`,
  );
} catch (error: unknown) {
  console.error("Database migration failed.", error);
  process.exitCode = 1;
} finally {
  if (pool.connected) await pool.close();
}
