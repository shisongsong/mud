import { loadEnvironment } from "../../config/env.js";
import { applyMigrations } from "./migrator.js";
import { postgresMigrations } from "./postgres-migrations.js";
import { createPostgresPool, PostgresMigrationDatabase } from "./postgres.js";
const pool = createPostgresPool(loadEnvironment());
try {
    const applied = await applyMigrations(new PostgresMigrationDatabase(pool), postgresMigrations);
    console.info(applied.length === 0
        ? "Database schema is up to date."
        : `Applied migrations: ${applied.join(", ")}`);
}
catch (error) {
    console.error("Database migration failed.", error);
    process.exitCode = 1;
}
finally {
    await pool.end();
}
