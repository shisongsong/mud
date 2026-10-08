import { z } from "zod";
import { uuidSchema } from "../contracts/identifiers.js";
export const playerActorSchema = z
    .object({
    kind: z.literal("player"),
    accountId: uuidSchema,
    playerId: uuidSchema,
})
    .strict();
export const managementActorSchema = z
    .object({
    kind: z.literal("management"),
    accountId: uuidSchema,
    capabilities: z.array(z.string().min(1).max(96)).max(64),
})
    .strict();
export const serviceActorSchema = z
    .object({
    kind: z.literal("service"),
    serviceId: z.enum(["api", "worker", "migration"]),
})
    .strict();
export const accountActorSchema = z
    .object({
    kind: z.literal("account"),
    accountId: uuidSchema,
})
    .strict();
export const actorSchema = z.discriminatedUnion("kind", [
    playerActorSchema,
    accountActorSchema,
    managementActorSchema,
    serviceActorSchema,
]);
