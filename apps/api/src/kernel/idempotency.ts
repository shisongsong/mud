import { createHash } from "node:crypto";
import type { Actor } from "./actor.ts";

const MAX_CANONICAL_DEPTH = 64;

export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set(), 0);
}

export function requestDigest(
  operation: string,
  actor: Actor,
  normalizedInput: unknown,
): string {
  const actorScope = actorScopeKey(actor);
  const canonicalInput = canonicalJson(normalizedInput);
  const material = JSON.stringify([operation, actorScope, canonicalInput]);

  return createHash("sha256").update(material, "utf8").digest("hex");
}

function actorScopeKey(actor: Actor): string {
  switch (actor.kind) {
    case "player":
      return `player:${actor.accountId}:${actor.playerId}`;
    case "account":
      return `account:${actor.accountId}`;
    case "management":
      return `management:${actor.accountId}`;
    case "service":
      return `service:${actor.serviceId}`;
  }
}

function canonicalize(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new TypeError("Canonical input exceeds the maximum nesting depth");
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical input cannot contain non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return withCycleCheck(
      value,
      ancestors,
      () =>
        `[${value
          .map((entry) => canonicalize(entry, ancestors, depth + 1))
          .join(",")}]`,
    );
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical input must contain only plain objects");
    }

    return withCycleCheck(value, ancestors, () => {
      const entries = Object.entries(value).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      return `{${entries
        .map(([key, entry]) => {
          if (entry === undefined) {
            throw new TypeError(
              "Canonical input cannot contain undefined values",
            );
          }
          return `${JSON.stringify(key)}:${canonicalize(
            entry,
            ancestors,
            depth + 1,
          )}`;
        })
        .join(",")}}`;
    });
  }

  throw new TypeError(`Unsupported canonical input type: ${typeof value}`);
}

function withCycleCheck<T>(
  value: object,
  ancestors: Set<object>,
  operation: () => T,
): T {
  if (ancestors.has(value)) {
    throw new TypeError("Canonical input cannot contain circular references");
  }

  ancestors.add(value);
  try {
    return operation();
  } finally {
    ancestors.delete(value);
  }
}
