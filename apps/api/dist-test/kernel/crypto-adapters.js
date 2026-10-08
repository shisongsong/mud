import { randomBytes, randomUUID } from "node:crypto";
export const cryptoIdGenerator = {
    next: () => randomUUID(),
};
export const cryptoRandomSource = {
    bytes(length) {
        if (!Number.isSafeInteger(length) || length < 1 || length > 4096) {
            throw new RangeError("Random byte length must be an integer from 1 to 4096");
        }
        return randomBytes(length);
    },
};
