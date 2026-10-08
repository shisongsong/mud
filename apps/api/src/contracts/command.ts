import { z } from "zod";
import { actorSchema } from "../kernel/actor.ts";
import {
  nonEmptyIdSchema,
  positiveVersionSchema,
  uuidSchema,
} from "./identifiers.ts";

export const idempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{16,128}$/);

// Internal command metadata only: construct actor from the authenticated server context.
// Never parse this schema directly from an untrusted HTTP request body.
export const commandMetadataSchema = z
  .object({
    commandId: uuidSchema,
    actor: actorSchema,
    traceId: uuidSchema,
    idempotencyKey: idempotencyKeySchema.optional(),
    expectedVersion: positiveVersionSchema.optional(),
  })
  .strict();

export const durableOperationStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "partial_failed",
  "failed",
  "cancelled",
]);

export const operationStatusSchema = z
  .object({
    operationId: nonEmptyIdSchema,
    status: durableOperationStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    messageKey: z.string().min(1).max(128).optional(),
    progress: z
      .object({
        total: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CommandMetadata = z.infer<typeof commandMetadataSchema>;
export type OperationStatus = z.infer<typeof operationStatusSchema>;
