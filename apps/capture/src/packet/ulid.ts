// Crockford base32 ULID — 26 chars, 48-bit ms timestamp || 80-bit randomness.
// Inline implementation per spec: no new runtime dep.

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeCrockford(value: bigint, length: number): string {
  let out = "";
  let v = value;
  for (let i = 0; i < length; i++) {
    const idx = Number(v & 0x1fn);
    out = ALPHABET[idx] + out;
    v >>= 5n;
  }
  return out;
}

export function generateUlid(now: number = Date.now()): string {
  const ts = BigInt(now) & ((1n << 48n) - 1n);
  const rand = randomBytes(10);
  let randInt = 0n;
  for (const byte of rand) {
    randInt = (randInt << 8n) | BigInt(byte);
  }
  return encodeCrockford(ts, 10) + encodeCrockford(randInt, 16);
}
