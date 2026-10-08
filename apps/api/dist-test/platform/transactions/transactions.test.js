import assert from "node:assert/strict";
import { test } from "node:test";
import { IdempotencyConflictError, SqlServerCommandReceipts, } from "./command-receipts.js";
class FakeUnitOfWork {
    receipts = new Map();
    domainWriteCount = 0;
    async transaction(work) {
        const receipts = new Map(this.receipts);
        let domainWriteCount = this.domainWriteCount;
        const executor = {
            query: async (statement, parameters = {}) => {
                if (statement.includes("sp_getapplock"))
                    return [];
                if (statement.includes("FROM platform.CommandReceipts")) {
                    const row = receipts.get(receiptKey(parameters));
                    return (row ? [row] : []);
                }
                if (statement.includes("INSERT INTO domain.Aggregates")) {
                    domainWriteCount += 1;
                    return [];
                }
                if (statement.includes("INSERT INTO platform.CommandReceipts")) {
                    const key = receiptKey(parameters);
                    receipts.set(key, {
                        requestDigest: String(parameters["requestDigest"]),
                        status: "completed",
                        responseJson: String(parameters["responseJson"]),
                    });
                    return [];
                }
                throw new Error("Unexpected SQL in receipt test");
            },
        };
        const result = await work(executor);
        this.receipts = receipts;
        this.domainWriteCount = domainWriteCount;
        return result;
    }
}
function receiptKey(parameters) {
    return JSON.stringify([
        parameters["actorScope"],
        parameters["operation"],
        parameters["idempotencyKey"],
    ]);
}
const command = {
    actorScope: "player:account_1:player_1",
    operation: "CreateQuery",
    idempotencyKey: "key_0123456789ab",
    requestDigest: "a".repeat(64),
    expiresAt: new Date("2026-10-07T12:00:00.000Z"),
};
function decodeResult(value) {
    if (typeof value !== "object" ||
        value === null ||
        !("queryId" in value) ||
        typeof value.queryId !== "string") {
        throw new TypeError("Invalid stored query result");
    }
    return { queryId: value.queryId };
}
test("same key and digest replays the original response without repeating writes", async () => {
    const unitOfWork = new FakeUnitOfWork();
    const receipts = new SqlServerCommandReceipts(unitOfWork);
    let handlerCalls = 0;
    const handle = async (transaction) => {
        handlerCalls += 1;
        await transaction.query("INSERT INTO domain.Aggregates");
        return { result: { queryId: "query_1" }, resourceId: "query_1" };
    };
    const first = await receipts.execute(command, decodeResult, handle);
    const replay = await receipts.execute(command, decodeResult, handle);
    assert.deepEqual(first, { result: { queryId: "query_1" }, replayed: false });
    assert.deepEqual(replay, { result: { queryId: "query_1" }, replayed: true });
    assert.equal(handlerCalls, 1);
    assert.equal(unitOfWork.domainWriteCount, 1);
});
test("same key with a different request digest conflicts", async () => {
    const receipts = new SqlServerCommandReceipts(new FakeUnitOfWork());
    await receipts.execute(command, decodeResult, async () => ({
        result: { queryId: "query_1" },
    }));
    await assert.rejects(receipts.execute({ ...command, requestDigest: "b".repeat(64) }, decodeResult, async () => ({ result: { queryId: "query_2" } })), IdempotencyConflictError);
});
test("failed domain work commits neither a receipt nor transactional writes", async () => {
    const unitOfWork = new FakeUnitOfWork();
    const receipts = new SqlServerCommandReceipts(unitOfWork);
    await assert.rejects(receipts.execute(command, decodeResult, async (transaction) => {
        await transaction.query("INSERT INTO domain.Aggregates");
        throw new Error("domain write failed");
    }), /domain write failed/);
    assert.equal(unitOfWork.domainWriteCount, 0);
    const retry = await receipts.execute(command, decodeResult, async () => ({
        result: { queryId: "query_retry" },
    }));
    assert.equal(retry.replayed, false);
});
test("receipt command rejects malformed identifiers and digests", async () => {
    const receipts = new SqlServerCommandReceipts(new FakeUnitOfWork());
    await assert.rejects(receipts.execute({ ...command, idempotencyKey: "short" }, decodeResult, async () => ({ result: { queryId: "query_1" } })), /Idempotency key/);
    await assert.rejects(receipts.execute({ ...command, requestDigest: "not-a-digest" }, decodeResult, async () => ({ result: { queryId: "query_1" } })), /SHA-256/);
});
