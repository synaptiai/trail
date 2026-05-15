import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { detectRecapture } from "../src/packet/recapture.js";

describe("detectRecapture (AB-9)", () => {
  test("first capture: nextN=1, parentPacketId=null", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-recapture-"));
    const sessionDir = join(dir, "sessions", "abc");
    const { nextN, parentPacketId } = detectRecapture(sessionDir);
    expect(nextN).toBe(1);
    expect(parentPacketId).toBeNull();
  });

  test("subsequent capture: nextN=N+1, parentPacketId=prior _meta.packet_id", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-recapture-"));
    const sessionDir = join(dir, "sessions", "abc");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "packet-1.yml"),
      "_meta:\n  packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n"
    );
    const { nextN, parentPacketId } = detectRecapture(sessionDir);
    expect(nextN).toBe(2);
    expect(parentPacketId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  test("multiple priors: pick highest N", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-recapture-"));
    const sessionDir = join(dir, "sessions", "abc");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "packet-1.yml"), "_meta:\n  packet_id: ULID1\n");
    writeFileSync(join(sessionDir, "packet-2.yml"), "_meta:\n  packet_id: ULID2\n");
    writeFileSync(join(sessionDir, "packet-5.yml"), "_meta:\n  packet_id: ULID5\n");
    const { nextN, parentPacketId } = detectRecapture(sessionDir);
    expect(nextN).toBe(6);
    expect(parentPacketId).toBe("ULID5");
  });

  test("unreadable parent: parentReadFailed=true, parentPacketId=null", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-recapture-"));
    const sessionDir = join(dir, "sessions", "abc");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "packet-1.yml"), "this is not yaml: : :\n  - - -");
    const { nextN, parentPacketId, parentReadFailed } = detectRecapture(sessionDir);
    expect(nextN).toBe(2);
    expect(parentPacketId).toBeNull();
    expect(parentReadFailed).toBe(true);
  });
});
