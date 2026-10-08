import { createHash } from "node:crypto";
export class IdempotencyConflictError extends Error {
    code = "IDEMPOTENCY_CONFLICT";
    constructor() {
        super("The idempotency key was already used for a different request");
        this.name = "IdempotencyConflictError";
    }
}
export class CommandStillPendingError extends Error {
    code = "COMMAND_STILL_PENDING";
    constructor() {
        super("The command associated with this idempotency key is still pending");
        this.name = "CommandStillPendingError";
    }
}
export class PostgresCommandReceipts {
    unitOfWork;
    constructor(unitOfWork) {
        this.unitOfWork = unitOfWork;
    }
    async execute(command, decodeResult, handle) {
        validateCommand(command);
        return this.unitOfWork.transaction(async (transaction) => {
            await acquireReceiptLock(transaction, command);
            const existing = await loadReceipt(transaction, command);
            if (existing) {
                if (existing.requestDigest !== command.requestDigest) {
                    throw new IdempotencyConflictError();
                }
                if (existing.status !== "completed" || existing.responseJson === null) {
                    throw new CommandStillPendingError();
                }
                return {
                    result: decodeResult(JSON.parse(existing.responseJson)),
                    replayed: true,
                };
            }
            const receipt = await handle(transaction);
            const responseJson = JSON.stringify(receipt.result);
            if (responseJson === undefined) {
                throw new TypeError("Command receipt result must be JSON serializable");
            }
            await persistReceipt(transaction, command, receipt, responseJson);
            return { result: receipt.result, replayed: false };
        });
    }
}
function validateCommand(command) {
    if (command.actorScope.length === 0 || command.actorScope.length > 256) {
        throw new TypeError("Actor scope must contain 1–256 characters");
    }
    if (command.operation.length === 0 || command.operation.length > 128) {
        throw new TypeError("Operation must contain 1–128 characters");
    }
    if (!/^[\x21-\x7e]{16,128}$/.test(command.idempotencyKey)) {
        throw new TypeError("Idempotency key must contain 16–128 visible ASCII characters");
    }
    if (!/^[a-f0-9]{64}$/.test(command.requestDigest)) {
        throw new TypeError("Request digest must be a lowercase SHA-256 hex value");
    }
    if (!Number.isFinite(command.expiresAt.getTime())) {
        throw new TypeError("Receipt expiration must be a valid timestamp");
    }
}
async function acquireReceiptLock(transaction, command) {
    const lockName = createHash("sha256")
        .update(JSON.stringify([
        command.actorScope,
        command.operation,
        command.idempotencyKey,
    ]), "utf8")
        .digest("hex");
    await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended(@resource, 0))", { resource: `mud:receipt:${lockName}` });
}
async function loadReceipt(transaction, command) {
    const rows = await transaction.query(`
SELECT "requestDigest" AS "requestDigest", "status" AS "status",
       "responseJson" AS "responseJson"
FROM "platform"."CommandReceipts"
WHERE "actorScope" = @actorScope
  AND "operation" = @operation
  AND "idempotencyKey" = @idempotencyKey
FOR UPDATE;
`, {
        actorScope: command.actorScope,
        operation: command.operation,
        idempotencyKey: command.idempotencyKey,
    });
    return rows[0];
}
async function persistReceipt(transaction, command, receipt, responseJson) {
    await transaction.query(`
INSERT INTO "platform"."CommandReceipts"
  ("actorScope", "operation", "idempotencyKey", "requestDigest", "status", "responseJson",
   "resourceId", "operationId", "expiresAt")
VALUES
  (@actorScope, @operation, @idempotencyKey, @requestDigest, 'completed', @responseJson,
   @resourceId, @operationId, @expiresAt);
`, {
        actorScope: command.actorScope,
        operation: command.operation,
        idempotencyKey: command.idempotencyKey,
        requestDigest: command.requestDigest,
        responseJson,
        resourceId: receipt.resourceId ?? null,
        operationId: receipt.operationId ?? null,
        expiresAt: command.expiresAt,
    });
}
