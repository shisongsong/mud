import sql from "mssql";

export type SqlParameter = string | number | boolean | Date | Uint8Array | null;
export type SqlParameters = Readonly<Record<string, SqlParameter>>;

export interface QueryExecutor {
  query<T extends object>(
    statement: string,
    parameters?: SqlParameters,
  ): Promise<readonly T[]>;
}

export interface UnitOfWork {
  transaction<T>(work: (executor: QueryExecutor) => Promise<T>): Promise<T>;
}

export class SqlServerUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: sql.ConnectionPool) {}

  async transaction<T>(
    work: (executor: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

    try {
      const executor = new SqlServerQueryExecutor(transaction);
      const result = await work(executor);
      await transaction.commit();
      return result;
    } catch (error: unknown) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }
}

class SqlServerQueryExecutor implements QueryExecutor {
  constructor(private readonly transaction: sql.Transaction) {}

  async query<T extends object>(
    statement: string,
    parameters: SqlParameters = {},
  ): Promise<readonly T[]> {
    const request = new sql.Request(this.transaction);
    for (const [name, value] of Object.entries(parameters)) {
      request.input(name, value);
    }

    const result = await request.query<T>(statement);
    return result.recordset;
  }
}
