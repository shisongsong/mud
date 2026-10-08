const migrationIdPattern = /^\d{4}_[a-z0-9_]+$/;
export async function applyMigrations(database, migrations) {
    validateMigrations(migrations);
    return database.transaction(async (session) => {
        await session.acquireMigrationLock();
        await session.ensureHistoryTable();
        const knownIds = new Set(migrations.map(({ id }) => id));
        const appliedIds = await session.getAppliedMigrationIds();
        const unknownAppliedIds = appliedIds.filter((id) => !knownIds.has(id));
        if (unknownAppliedIds.length > 0) {
            throw new Error(`Database contains unknown migrations: ${unknownAppliedIds.join(", ")}`);
        }
        const expectedAppliedIds = migrations
            .slice(0, appliedIds.length)
            .map(({ id }) => id);
        if (expectedAppliedIds.some((id, index) => id !== appliedIds[index])) {
            throw new Error("Applied migrations are not a contiguous ordered prefix");
        }
        const appliedSet = new Set(appliedIds);
        const newlyApplied = [];
        for (const migration of migrations) {
            if (appliedSet.has(migration.id))
                continue;
            await session.execute(migration.sql);
            await session.recordAppliedMigration(migration.id);
            newlyApplied.push(migration.id);
        }
        return newlyApplied;
    });
}
function validateMigrations(migrations) {
    const seen = new Set();
    let previousId = "";
    for (const { id, sql } of migrations) {
        if (!migrationIdPattern.test(id)) {
            throw new Error(`Invalid migration ID: ${id}`);
        }
        if (seen.has(id)) {
            throw new Error(`Duplicate migration ID: ${id}`);
        }
        if (previousId !== "" && id <= previousId) {
            throw new Error("Migrations must be ordered by ascending ID");
        }
        if (sql.trim().length === 0) {
            throw new Error(`Migration ${id} has no SQL`);
        }
        seen.add(id);
        previousId = id;
    }
}
