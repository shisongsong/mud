import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ownedKnowledgeItemSchema, toOwnedKnowledgeItem } from "./script.ts";

test("owned Knowledge DTO exposes only the authorized public fields", () => {
  const item = toOwnedKnowledgeItem({
    scriptId: randomUUID(),
    content: "A publicly authorized clue",
    receivedAt: new Date("2025-01-01T00:00:00.000Z"),
    isTruth: false,
    tampered: true,
    hiddenSource: "admin-only-source",
    adminEvidence: { caseId: "private-case" },
  } as Parameters<typeof toOwnedKnowledgeItem>[0]);

  assert.deepEqual(Object.keys(item).sort(), [
    "content",
    "receivedAt",
    "scriptId",
  ]);
  assert.equal("isTruth" in item, false);
  assert.equal("tampered" in item, false);
  assert.equal("hiddenSource" in item, false);
  assert.equal("adminEvidence" in item, false);
  assert.throws(() =>
    ownedKnowledgeItemSchema.parse({
      ...item,
      isTruth: true,
    }),
  );
});
