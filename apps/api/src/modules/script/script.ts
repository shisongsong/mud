import { z } from "zod";
import { uuidSchema } from "../../contracts/identifiers.ts";

const contentTextSchema = z
  .string()
  .min(1)
  .max(4000)
  .refine((text) => text.trim().length > 0);

export const queryCardScriptInputSchema = z
  .object({
    queryId: uuidSchema,
    playerId: uuidSchema,
    cardId: uuidSchema,
    contentText: contentTextSchema,
    gameplayReleaseId: z.string().trim().min(1).max(128),
  })
  .strict();

export type QueryCardScriptInput = z.infer<typeof queryCardScriptInputSchema>;

export const ownedKnowledgeItemSchema = z
  .object({
    scriptId: uuidSchema,
    content: contentTextSchema,
    receivedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type OwnedKnowledgeItem = z.infer<typeof ownedKnowledgeItemSchema>;

export interface KnowledgeItemRow {
  readonly scriptId: string;
  readonly content: string;
  readonly receivedAt: Date;
}

export function toOwnedKnowledgeItem(
  row: KnowledgeItemRow,
): OwnedKnowledgeItem {
  return ownedKnowledgeItemSchema.parse({
    scriptId: row.scriptId,
    content: row.content,
    receivedAt: row.receivedAt.toISOString(),
  });
}
