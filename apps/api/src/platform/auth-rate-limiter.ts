import { createHash } from "node:crypto";

export interface RedisRateLimitExecutor {
  eval(
    script: string,
    options: { readonly keys: readonly string[]; readonly arguments: readonly string[] },
  ): Promise<unknown>;
}

export interface AuthRateLimiter {
  consume(
    scope: "login-ip" | "login-username" | "register-ip",
    subject: string,
    limit: number,
    windowMs: number,
  ): Promise<boolean>;
}

const incrementScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

export class RedisAuthRateLimiter implements AuthRateLimiter {
  constructor(
    private readonly redis: RedisRateLimitExecutor,
    private readonly now: () => number = Date.now,
  ) {}

  async consume(
    scope: "login-ip" | "login-username" | "register-ip",
    subject: string,
    limit: number,
    windowMs: number,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(windowMs) ||
      windowMs < 1
    ) {
      throw new RangeError("Invalid rate limit configuration");
    }
    const bucket = Math.floor(this.now() / windowMs);
    const digest = createHash("sha256").update(subject, "utf8").digest("hex");
    const key = `mud:auth-rate:${scope}:${digest}:${bucket}`;
    const count = Number(
      await this.redis.eval(incrementScript, {
        keys: [key],
        arguments: [String(windowMs * 2)],
      }),
    );
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error("Rate limiter returned an invalid count");
    }
    return count <= limit;
  }
}