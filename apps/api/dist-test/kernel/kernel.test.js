import assert from "node:assert/strict";
import { test } from "node:test";
import { cryptoIdGenerator, cryptoRandomSource } from "./crypto-adapters.js";
import { canonicalJson, requestDigest } from "./idempotency.js";
const actor = {
    kind: "player",
    accountId: "11111111-1111-4111-8111-111111111111",
    playerId: "22222222-2222-4222-8222-222222222222",
};
test("canonical JSON sorts object keys and preserves array order", () => {
    assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});
test("request digest scopes canonical input", () => {
    const first = requestDigest("CastVote", actor, {
        choiceId: "choice_1",
        expectedVersion: 2,
    });
    const reordered = requestDigest("CastVote", actor, {
        expectedVersion: 2,
        choiceId: "choice_1",
    });
    const otherActor = requestDigest("CastVote", { ...actor, playerId: "33333333-3333-4333-8333-333333333333" }, { choiceId: "choice_1", expectedVersion: 2 });
    assert.equal(first, reordered);
    assert.notEqual(first, otherActor);
    assert.notEqual(first, requestDigest("SubmitAction", actor, {
        choiceId: "choice_1",
        expectedVersion: 2,
    }));
});
test("canonical input rejects invalid JSON values", () => {
    const circular = {};
    circular.self = circular;
    let deeplyNested = null;
    for (let depth = 0; depth < 66; depth += 1) {
        deeplyNested = { child: deeplyNested };
    }
    assert.throws(() => canonicalJson(circular), /circular references/);
    assert.throws(() => canonicalJson(deeplyNested), /maximum nesting depth/);
    assert.throws(() => canonicalJson({ missing: undefined }), /undefined values/);
    assert.throws(() => canonicalJson(Number.NaN), /non-finite numbers/);
});
test("crypto adapters provide UUIDs and bounded random bytes", () => {
    assert.match(cryptoIdGenerator.next(), /^[0-9a-f-]{36}$/i);
    assert.equal(cryptoRandomSource.bytes(24).length, 24);
    assert.throws(() => cryptoRandomSource.bytes(0), RangeError);
});
