export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface RandomSource {
  bytes(length: number): Uint8Array;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
