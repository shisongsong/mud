import { randomBytes, randomUUID } from "node:crypto";
import type { IdGenerator, RandomSource } from "./ports.ts";

export const cryptoIdGenerator: IdGenerator = {
  next: () => randomUUID(),
};

export const cryptoRandomSource: RandomSource = {
  bytes(length) {
    if (!Number.isSafeInteger(length) || length < 1 || length > 4096) {
      throw new RangeError(
        "Random byte length must be an integer from 1 to 4096",
      );
    }

    return randomBytes(length);
  },
};
