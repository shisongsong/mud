import { z } from "zod";

export const uuidSchema = z.string().uuid();
export const nonEmptyIdSchema = z.string().trim().min(1).max(128);
export const positiveVersionSchema = z.number().int().positive();

export const schemaVersionSchema = positiveVersionSchema;

export type Uuid = z.infer<typeof uuidSchema>;
