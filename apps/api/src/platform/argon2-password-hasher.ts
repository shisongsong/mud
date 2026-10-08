import { Algorithm, hash, verify } from "@node-rs/argon2";

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

export interface Argon2Operations {
  hash(password: string, options: Parameters<typeof hash>[1]): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

export class PasswordWorkCapacityError extends Error {
  readonly code = "AUTH_HASH_BUSY";

  constructor() {
    super("Password hashing capacity is temporarily exhausted");
    this.name = "PasswordWorkCapacityError";
  }
}

interface PendingWork<T> {
  readonly work: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

export class Argon2idPasswordHasher implements PasswordHasher {
  private active = 0;
  private readonly pending: PendingWork<unknown>[] = [];

  constructor(
    private readonly operations: Argon2Operations = { hash, verify },
    private readonly maximumConcurrent = 2,
    private readonly maximumQueued = 16,
  ) {
    if (
      !Number.isSafeInteger(maximumConcurrent) ||
      maximumConcurrent < 1 ||
      !Number.isSafeInteger(maximumQueued) ||
      maximumQueued < 0
    ) {
      throw new RangeError("Invalid password hashing capacity");
    }
  }

  hash(password: string): Promise<string> {
    return this.run(() =>
      this.operations.hash(password, {
        algorithm: Algorithm.Argon2id,
        memoryCost: 64 * 1024,
        timeCost: 3,
        parallelism: 1,
        outputLen: 32,
      }),
    );
  }

  verify(passwordHash: string, password: string): Promise<boolean> {
    return this.run(() => this.operations.verify(passwordHash, password));
  }

  private run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < this.maximumConcurrent) {
      this.active += 1;
      return this.execute(work);
    }
    if (this.pending.length >= this.maximumQueued) {
      return Promise.reject(new PasswordWorkCapacityError());
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ work, resolve, reject } as PendingWork<unknown>);
    });
  }

  private async execute<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } finally {
      const next = this.pending.shift();
      if (next) {
        void this.execute(next.work).then(next.resolve, next.reject);
      } else {
        this.active -= 1;
      }
    }
  }
}
