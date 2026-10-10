import type { CreatePlayerRequest } from "../contracts/http.ts";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface RandomSource {
  bytes(length: number): Uint8Array;
}

export interface PlayerFactionReader {
  getFactionId(
    playerId: string,
  ): Promise<CreatePlayerRequest["factionId"] | null>;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
