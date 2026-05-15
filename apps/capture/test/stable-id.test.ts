import { describe, expect, test } from "vitest";
import { deriveStableId } from "../src/packet/stable-id.js";

describe("deriveStableId", () => {
  test("returns 16-char lowercase hex", () => {
    const id = deriveStableId("session", "claim text", 0);
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  test("matches py-reference algorithm: sha256(session_id|claim_text|position)[:16]", () => {
    // py-reference: sha256("session|hello|0").hexdigest()[:16]
    const expected = "6cd5ec9561d606d1";
    expect(deriveStableId("session", "hello", 0)).toBe(expected);
  });

  test("position increment yields different id", () => {
    const a = deriveStableId("s", "t", 0);
    const b = deriveStableId("s", "t", 1);
    expect(a).not.toBe(b);
  });

  test("deterministic across calls", () => {
    const a = deriveStableId("session-x", "claim text with spaces", 5);
    const b = deriveStableId("session-x", "claim text with spaces", 5);
    expect(a).toBe(b);
  });
});
