import assert from "node:assert/strict";
import { test } from "node:test";
import { validateModuleGraph } from "./boundary-rules.mjs";

test("allows acyclic dependencies through another module public entry", () => {
  const violations = validateModuleGraph([
    { name: "query", dependencies: [{ name: "player", publicEntry: true }] },
    { name: "player", dependencies: [] },
  ]);

  assert.deepEqual(violations, []);
});

test("rejects imports into another module implementation", () => {
  const violations = validateModuleGraph([
    { name: "query", dependencies: [{ name: "player", publicEntry: false }] },
    { name: "player", dependencies: [] },
  ]);

  assert.match(
    violations.join("\n"),
    /query imports internal implementation of player/,
  );
});

test("rejects cyclic module dependencies", () => {
  const violations = validateModuleGraph([
    { name: "query", dependencies: [{ name: "player", publicEntry: true }] },
    { name: "player", dependencies: [{ name: "query", publicEntry: true }] },
  ]);

  assert.match(violations.join("\n"), /module dependency cycle:/);
});
