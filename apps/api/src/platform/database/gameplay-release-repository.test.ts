import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalJson } from "../../kernel/idempotency.ts";
import {
  trial1GameplayChecksum,
  trial1GameplaySnapshot,
} from "./postgres-migrations.ts";
import type {
  QueryExecutor,
  UnitOfWork,
} from "../transactions/unit-of-work.ts";
import {
  InvalidGameplayReleaseError,
  PostgresGameplayReleaseRepository,
} from "./gameplay-release-repository.ts";

class ReleaseDatabase implements UnitOfWork {
  constructor(
    private readonly row:
      | {
          readonly releaseId: string;
          readonly manifestChecksum: string;
          readonly snapshotJson: unknown;
        }
      | undefined,
  ) {}

  transaction<T>(work: (transaction: QueryExecutor) => Promise<T>): Promise<T> {
    const transaction: QueryExecutor = {
      query: async <Row extends object>() =>
        (this.row ? [this.row] : []) as unknown as readonly Row[],
    };
    return work(transaction);
  }
}

const validSnapshot = { queryEnabled: false, templates: ["trial_1"] };
const validChecksum =
  "1cfe180ace5d11ee8296524d46345c48a75b42c9c1d47b69f36de13282d56283";
const validTrialSnapshot = trial1GameplaySnapshot;
const trialChecksum = trial1GameplayChecksum;

test("active gameplay release returns only a validated immutable snapshot", async () => {
  const database = new ReleaseDatabase({
    releaseId: "gameplay_bootstrap_v1",
    manifestChecksum: validChecksum,
    snapshotJson: validSnapshot,
  });
  const repository = new PostgresGameplayReleaseRepository();
  const release = await database.transaction((transaction) =>
    repository.getActiveGameplayRelease(transaction),
  );

  assert.deepEqual(release, {
    releaseId: "gameplay_bootstrap_v1",
    queryEnabled: false,
    templates: ["trial_1"],
  });
});

test("invalid active snapshot or checksum fails closed", async () => {
  const repository = new PostgresGameplayReleaseRepository();
  const badChecksum = new ReleaseDatabase({
    releaseId: "gameplay_bootstrap_v1",
    manifestChecksum: "0".repeat(64),
    snapshotJson: validSnapshot,
  });
  await assert.rejects(
    badChecksum.transaction((transaction) =>
      repository.getActiveGameplayRelease(transaction),
    ),
    InvalidGameplayReleaseError,
  );

  const badShape = new ReleaseDatabase({
    releaseId: "gameplay_bootstrap_v1",
    manifestChecksum: validChecksum,
    snapshotJson: { queryEnabled: true, templates: ["unknown"] },
  });
  await assert.rejects(
    badShape.transaction((transaction) =>
      repository.getActiveGameplayRelease(transaction),
    ),
    InvalidGameplayReleaseError,
  );
});

test("active trial release validates both complete variants and their intended answers", async () => {
  const database = new ReleaseDatabase({
    releaseId: "gameplay_trial_1_v1",
    manifestChecksum: trialChecksum,
    snapshotJson: validTrialSnapshot,
  });
  const repository = new PostgresGameplayReleaseRepository();
  const release = await database.transaction((transaction) =>
    repository.getActiveGameplayRelease(transaction),
  );

  assert.equal(release?.queryEnabled, true);
  assert.equal(release?.trial1?.variants[0]?.correctChoiceId, "choice_1");
  assert.equal(release?.trial1?.variants[1]?.correctChoiceId, "choice_2");
  assert.equal(release?.trial1?.variants[0]?.evidence.length, 3);

  const incompleteSnapshot = {
    ...validTrialSnapshot,
    content: {
      trial_1: {
        ...validTrialSnapshot.content.trial_1,
        variants: validTrialSnapshot.content.trial_1.variants.map(
          (variant, variantIndex) =>
            variantIndex === 0
              ? {
                  ...variant,
                  evidence: variant.evidence.map((evidence, evidenceIndex) =>
                    evidenceIndex === 2
                      ? { ...evidence, siteId: "site_1" as const }
                      : evidence,
                  ),
                }
              : variant,
        ),
      },
    },
  };
  const incomplete = new ReleaseDatabase({
    releaseId: "gameplay_trial_1_v1",
    manifestChecksum: createHash("sha256")
      .update(canonicalJson(incompleteSnapshot), "utf8")
      .digest("hex"),
    snapshotJson: incompleteSnapshot,
  });
  await assert.rejects(
    incomplete.transaction((transaction) =>
      repository.getActiveGameplayRelease(transaction),
    ),
    InvalidGameplayReleaseError,
  );

  const wrongAnswerSnapshot = {
    ...validTrialSnapshot,
    content: {
      trial_1: {
        ...validTrialSnapshot.content.trial_1,
        variants: validTrialSnapshot.content.trial_1.variants.map(
          (variant, index) =>
            index === 0
              ? { ...variant, correctChoiceId: "choice_2" as const }
              : variant,
        ),
      },
    },
  };
  const wrongAnswer = new ReleaseDatabase({
    releaseId: "gameplay_trial_1_v1",
    manifestChecksum: createHash("sha256")
      .update(canonicalJson(wrongAnswerSnapshot), "utf8")
      .digest("hex"),
    snapshotJson: wrongAnswerSnapshot,
  });
  await assert.rejects(
    wrongAnswer.transaction((transaction) =>
      repository.getActiveGameplayRelease(transaction),
    ),
    InvalidGameplayReleaseError,
  );
});

test("pinned gameplay lookup reads an immutable trial release by ID", async () => {
  const database = new ReleaseDatabase({
    releaseId: "gameplay_trial_1_v1",
    manifestChecksum: trialChecksum,
    snapshotJson: validTrialSnapshot,
  });
  const repository = new PostgresGameplayReleaseRepository();

  const release = await database.transaction((transaction) =>
    repository.getGameplayReleaseById(transaction, "gameplay_trial_1_v1"),
  );

  assert.equal(release?.releaseId, "gameplay_trial_1_v1");
  assert.equal(release?.trial1?.variants[0]?.variantId, "variant_1");
});

test("missing active gameplay pointer remains distinguishable from a valid bootstrap", async () => {
  const repository = new PostgresGameplayReleaseRepository();
  const release = await new ReleaseDatabase(undefined).transaction(
    (transaction) => repository.getActiveGameplayRelease(transaction),
  );
  assert.equal(release, null);
});
