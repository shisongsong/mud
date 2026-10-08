import { uuidSchema } from "../../contracts/identifiers.ts";
import type { QueryExecutor, UnitOfWork } from "./unit-of-work.ts";

export type InboxExecution<T> =
  | { readonly status: "processed"; readonly value: T }
  | { readonly status: "duplicate" };

interface InboxClaim {
  readonly eventId: string;
}

export class PostgresInbox {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute<T>(
    consumer: string,
    generation: number,
    eventId: string,
    handle: (transaction: QueryExecutor) => Promise<T>,
  ): Promise<InboxExecution<T>> {
    validateInboxKey(consumer, generation, eventId);

    return this.unitOfWork.transaction(async (transaction) => {
      const claims = await transaction.query<InboxClaim>(
        `
INSERT INTO "platform"."InboxMessages" ("consumer", "generation", "eventId")
VALUES (@consumer, @generation, @eventId)
ON CONFLICT ("consumer", "generation", "eventId") DO NOTHING
RETURNING "eventId";
`,
        { consumer, generation, eventId },
      );

      if (claims.length === 0) return { status: "duplicate" };

      return {
        status: "processed",
        value: await handle(transaction),
      };
    });
  }
}

function validateInboxKey(
  consumer: string,
  generation: number,
  eventId: string,
): void {
  if (
    consumer.length === 0 ||
    consumer.length > 128 ||
    consumer.trim() !== consumer ||
    /[\x00-\x1f\x7f]/.test(consumer)
  ) {
    throw new TypeError("Inbox consumer must be a valid 1–128 character name");
  }
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation > 2_147_483_647
  ) {
    throw new TypeError(
      "Inbox generation must be a non-negative PostgreSQL integer",
    );
  }
  if (!uuidSchema.safeParse(eventId).success) {
    throw new TypeError("Inbox event ID must be a UUID");
  }
}
