import { loadEnvironment } from "../../config/env.ts";
import { applyMigrations } from "./migrator.ts";
import { postgresMigrations } from "./postgres-migrations.ts";
import { createPostgresPool, PostgresMigrationDatabase } from "./postgres.ts";

const pool = createPostgresPool(loadEnvironment());

try {
  const applied = await applyMigrations(
    new PostgresMigrationDatabase(pool),
    postgresMigrations,
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
  await pool.end();
}
