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
