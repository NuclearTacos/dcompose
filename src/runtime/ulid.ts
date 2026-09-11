import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** 26-char ULID: 10 chars of ms timestamp + 16 chars of randomness. Lexically sortable by time. */
export function ulid(now = Date.now()): string {
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ALPHABET[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let r = "";
  for (let i = 0; i < 16; i++) r += ALPHABET[rnd[i]! % 32];
  return ts + r;
}

/** `20260911T140211Z-01J7QZ3M8KX4V9R2T6B1N5W0YD` — human-readable UTC prefix, unique suffix. */
export function runId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${ulid(now.getTime())}`;
}
