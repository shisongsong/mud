import type { QueryAggregate } from "./query.ts";

export interface QueryRepository {
  create(query: QueryAggregate): Promise<void>;
  get(queryId: string): Promise<QueryAggregate | null>;
  save(query: QueryAggregate, expectedVersion: number): Promise<boolean>;
}
