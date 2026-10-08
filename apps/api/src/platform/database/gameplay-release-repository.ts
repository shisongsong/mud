import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../kernel/idempotency.ts";
import type { QueryExecutor } from "../transactions/unit-of-work.ts";

const trial1ChoiceSchema = z
  .object({
    choiceId: z.enum(["choice_1", "choice_2"]),
    messageKey: z.string().min(1).max(128),
    args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  })
  .strict();

const trial1EvidenceSchema = z
  .object({
    siteId: z.enum(["site_1", "site_2", "site_3"]),
    messageKey: z.string().min(1).max(128),
    args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    isTruth: z.boolean(),
  })
  .strict();

const trial1VariantSchema = z
  .object({
    variantId: z.enum(["variant_1", "variant_2"]),
    correctChoiceId: z.enum(["choice_1", "choice_2"]),
    explanationKey: z.string().min(1).max(128),
    evidence: z.array(trial1EvidenceSchema).length(3),
  })
  .strict()
  .superRefine((variant, context) => {
    if (new Set(variant.evidence.map(({ siteId }) => siteId)).size !== 3) {
      context.addIssue({
        code: "custom",
        message: "Each site must appear once",
      });
    }
  });

const trial1TemplateSchema = z
  .object({
    choices: z.array(trial1ChoiceSchema).length(2),
    variants: z.array(trial1VariantSchema).length(2),
  })
  .strict()
  .superRefine((template, context) => {
    if (
      new Set(template.choices.map(({ choiceId }) => choiceId)).size !== 2 ||
      new Set(template.variants.map(({ variantId }) => variantId)).size !== 2
    ) {
      context.addIssue({
        code: "custom",
        message: "Choice and variant IDs must be unique",
      });
    }

    for (const [choiceId, mark] of [
      ["choice_1", "K1"],
      ["choice_2", "K2"],
    ] as const) {
      const choice = template.choices.find(
        (item) => item.choiceId === choiceId,
      );
      if (
        choice?.messageKey !== "trial.choice.mark" ||
        choice.args["mark"] !== mark
      ) {
        context.addIssue({
          code: "custom",
          message: `${choiceId} must identify ${mark}`,
        });
      }
    }

    for (const expected of [
      {
        variantId: "variant_1",
        correctChoiceId: "choice_1",
        currentMark: "K1",
        rumorMark: "K2",
      },
      {
        variantId: "variant_2",
        correctChoiceId: "choice_2",
        currentMark: "K2",
        rumorMark: "K1",
      },
    ] as const) {
      const variant = template.variants.find(
        (item) => item.variantId === expected.variantId,
      );
      if (!variant) continue;
      const evidence = new Map(
        variant.evidence.map((item) => [item.siteId, item]),
      );
      const currentRecord = evidence.get("site_1");
      const matchingRule = evidence.get("site_2");
      const rumor = evidence.get("site_3");
      if (
        variant.correctChoiceId !== expected.correctChoiceId ||
        variant.explanationKey !== "trial.explanation.current_mark" ||
        currentRecord?.messageKey !== "trial.evidence.current_mark" ||
        currentRecord.args["mark"] !== expected.currentMark ||
        currentRecord.isTruth !== true ||
        matchingRule?.messageKey !== "trial.evidence.same_mark_rule" ||
        matchingRule.isTruth !== true ||
        rumor?.messageKey !== "trial.evidence.unsigned_rumor" ||
        rumor.args["mark"] !== expected.rumorMark ||
        rumor.isTruth !== false
      ) {
        context.addIssue({
          code: "custom",
          message: `${expected.variantId} does not match the published deduction`,
        });
      }
    }
  });

const gameplaySnapshotSchema = z
  .object({
    queryEnabled: z.boolean(),
    templates: z.array(z.literal("trial_1")),
    content: z.object({ trial_1: trial1TemplateSchema }).strict().optional(),
  })
  .strict()
  .refine(
    (snapshot) => !snapshot.queryEnabled || snapshot.content !== undefined,
  );

type Trial1Template = z.infer<typeof trial1TemplateSchema>;

export interface ActiveGameplayRelease {
  readonly releaseId: string;
  readonly queryEnabled: boolean;
  readonly templates: readonly "trial_1"[];
  readonly trial1?: Trial1Template;
}

interface ReleaseRow {
  readonly releaseId: string;
  readonly manifestChecksum: string;
  readonly snapshotJson: unknown;
}

export class InvalidGameplayReleaseError extends Error {
  constructor() {
    super("The active gameplay release is invalid or has a checksum mismatch");
    this.name = "InvalidGameplayReleaseError";
  }
}

export interface GameplayReleaseReader {
  getActiveGameplayRelease(
    transaction: QueryExecutor,
  ): Promise<ActiveGameplayRelease | null>;
  getGameplayReleaseById(
    transaction: QueryExecutor,
    releaseId: string,
  ): Promise<ActiveGameplayRelease | null>;
}

export class GameplayNotReadyError extends Error {
  readonly code = "GAMEPLAY_NOT_READY";

  constructor() {
    super("No usable gameplay release is active");
    this.name = "GameplayNotReadyError";
  }
}

export class GameplayReleaseChangedError extends Error {
  readonly code = "GAMEPLAY_RELEASE_CHANGED";

  constructor() {
    super("The requested gameplay release is no longer active");
    this.name = "GameplayReleaseChangedError";
  }
}

export async function requireGameplayRelease(
  reader: GameplayReleaseReader,
  transaction: QueryExecutor,
  requestedReleaseId: string,
  requireQueryEnabled: boolean,
): Promise<ActiveGameplayRelease> {
  const release = await reader.getActiveGameplayRelease(transaction);
  if (!release || (requireQueryEnabled && !release.queryEnabled)) {
    throw new GameplayNotReadyError();
  }
  if (release.releaseId !== requestedReleaseId) {
    throw new GameplayReleaseChangedError();
  }
  return release;
}

export class PostgresGameplayReleaseRepository implements GameplayReleaseReader {
  async getActiveGameplayRelease(
    transaction: QueryExecutor,
  ): Promise<ActiveGameplayRelease | null> {
    const rows = await transaction.query<ReleaseRow>(
      `
SELECT r."releaseId" AS "releaseId",
       r."manifestChecksum" AS "manifestChecksum",
       r."snapshotJson" AS "snapshotJson"
FROM "control"."ActiveReleasePointers" p
JOIN "control"."ConfigReleases" r
  ON r."releaseKind" = p."releaseKind" AND r."releaseId" = p."releaseId"
WHERE p."releaseKind" = 'gameplay';
`,
    );
    return rows[0] ? parseGameplayRelease(rows[0]) : null;
  }

  async getGameplayReleaseById(
    transaction: QueryExecutor,
    releaseId: string,
  ): Promise<ActiveGameplayRelease | null> {
    const rows = await transaction.query<ReleaseRow>(
      `
SELECT "releaseId" AS "releaseId",
       "manifestChecksum" AS "manifestChecksum",
       "snapshotJson" AS "snapshotJson"
FROM "control"."ConfigReleases"
WHERE "releaseKind" = 'gameplay' AND "releaseId" = @releaseId;
`,
      { releaseId },
    );
    return rows[0] ? parseGameplayRelease(rows[0]) : null;
  }
}

function parseGameplayRelease(row: ReleaseRow): ActiveGameplayRelease {
  const parsed = gameplaySnapshotSchema.safeParse(row.snapshotJson);
  if (!parsed.success || !/^[a-f0-9]{64}$/.test(row.manifestChecksum)) {
    throw new InvalidGameplayReleaseError();
  }
  const checksum = createHash("sha256")
    .update(canonicalJson(parsed.data), "utf8")
    .digest("hex");
  if (checksum !== row.manifestChecksum) {
    throw new InvalidGameplayReleaseError();
  }
  return {
    releaseId: row.releaseId,
    queryEnabled: parsed.data.queryEnabled,
    templates: parsed.data.templates,
    ...(parsed.data.content ? { trial1: parsed.data.content.trial_1 } : {}),
  };
}
