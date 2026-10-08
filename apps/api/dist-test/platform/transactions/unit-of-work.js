import sql from "mssql";
export class SqlServerUnitOfWork {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async transaction(work) {
        const transaction = new sql.Transaction(this.pool);
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
        try {
            const executor = new SqlServerQueryExecutor(transaction);
            const result = await work(executor);
            await transaction.commit();
            return result;
        }
        catch (error) {
            await transaction.rollback().catch(() => undefined);
            throw error;
        }
    }
}
class SqlServerQueryExecutor {
    transaction;
    constructor(transaction) {
        this.transaction = transaction;
    }
    async query(statement, parameters = {}) {
        const request = new sql.Request(this.transaction);
        for (const [name, value] of Object.entries(parameters)) {
            request.input(name, value);
        }
        const result = await request.query(statement);
        return result.recordset;
    }
}
