import { describe, expect, test } from "vitest";
import { ULID_RE, generateUlid } from "../src/packet/ulid.js";

describe("generateUlid", () => {
  test("returns 26-char Crockford base32 ULID", () => {
    const u = generateUlid();
    expect(u).toMatch(ULID_RE);
    expect(u.length).toBe(26);
  });

  test("returns distinct ULIDs across calls", () => {
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) set.add(generateUlid());
    expect(set.size).toBe(100);
  });

  test("timestamp prefix monotonic given monotonic ms input", () => {
    const a = generateUlid(1_700_000_000_000);
    const b = generateUlid(1_700_000_000_001);
    // First 10 chars are timestamp; lex compare aligns with numeric ordering
    // because each char encodes 5 bits left-padded.
    expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true);
  });
});
