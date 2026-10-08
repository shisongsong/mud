import { z } from "zod";
import { nonEmptyIdSchema, positiveVersionSchema, schemaVersionSchema, uuidSchema, } from "./identifiers.js";
export const eventSourceSchema = z.enum([
    "identity",
    "player",
    "query",
    "script",
    "board",
    "social",
    "control",
    "rules",
    "platform",
]);
export const eventEnvelopeSchema = z
    .object({
    eventId: uuidSchema,
    type: nonEmptyIdSchema,
    schemaVersion: schemaVersionSchema,
    source: eventSourceSchema,
    aggregateId: uuidSchema,
    aggregateVersion: positiveVersionSchema,
    streamId: uuidSchema,
    sequence: z.number().int().positive(),
    releaseVersion: nonEmptyIdSchema.nullable(),
    occurredAt: z.string().datetime({ offset: true }),
    traceId: uuidSchema,
    correlationId: uuidSchema,
    causationId: uuidSchema.nullable(),
    rootEventId: uuidSchema,
    depth: z.number().int().nonnegative(),
    payload: z.record(z.string(), z.unknown()),
})
    .strict();
