import { z } from "zod";
import { apiErrorSchema } from "./errors.js";
import { nonEmptyIdSchema, schemaVersionSchema, uuidSchema, } from "./identifiers.js";
const clientMessageBase = {
    requestId: uuidSchema,
    schemaVersion: schemaVersionSchema,
};
export const subscribeMessageSchema = z
    .object({
    ...clientMessageBase,
    type: z.literal("Subscribe"),
    payload: z
        .object({
        resourceType: z.enum(["query", "board", "lobby"]),
        resourceId: nonEmptyIdSchema,
    })
        .strict(),
})
    .strict();
export const unsubscribeMessageSchema = z
    .object({
    ...clientMessageBase,
    type: z.literal("Unsubscribe"),
    payload: z
        .object({
        resourceType: z.enum(["query", "board", "lobby"]),
        resourceId: nonEmptyIdSchema,
    })
        .strict(),
})
    .strict();
export const pingMessageSchema = z
    .object({
    ...clientMessageBase,
    type: z.literal("Ping"),
    payload: z.object({}).strict(),
})
    .strict();
export const clientWebSocketMessageSchema = z.discriminatedUnion("type", [
    subscribeMessageSchema,
    unsubscribeMessageSchema,
    pingMessageSchema,
]);
export const serverWebSocketAckSchema = z
    .object({
    requestId: uuidSchema,
    status: z.enum(["accepted", "rejected"]),
    operationId: nonEmptyIdSchema.optional(),
    error: apiErrorSchema.optional(),
})
    .strict();
