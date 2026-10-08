import { z } from "zod";
import { uuidSchema } from "./identifiers.js";
export const validationDetailSchema = z
    .object({
    field: z.string().min(1).max(128),
    code: z.string().min(1).max(64),
})
    .strict();
export const apiErrorSchema = z
    .object({
    code: z.string().min(1).max(64),
    messageKey: z.string().min(1).max(128),
    args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    traceId: uuidSchema,
    details: z.array(validationDetailSchema).optional(),
})
    .strict();
