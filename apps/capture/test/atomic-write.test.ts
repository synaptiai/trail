import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { atomicWrite } from "../src/io/atomic.js";

describe("atomicWrite (criterion 27)", () => {
  // Track read-only directories so afterEach can restore permissions and
  // tmpdir cleanup doesn't leak undeletable trees on POSIX.
  const restoreOnAfter: string[] = [];
  afterEach(() => {
    for (const d of restoreOnAfter) {
      try {
        chmodSync(d, 0o755);
      } catch {
        // best-effort
      }
    }
    restoreOnAfter.length = 0;
  });

  test("writes file via tmp+rename", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-atomic-"));
    const target = join(dir, "out.yml");
    atomicWrite(target, "hello\n");
    expect(readFileSync(target, "utf-8")).toBe("hello\n");
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  test("on I/O failure between scan and rename: tmp unlinked, no torn state", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-atomic-"));
    // Make the target a directory so rename fails.
    const target = join(dir, "blocked");
    mkdirSync(target, { recursive: true });
    expect(() => atomicWrite(target, "hello\n")).toThrow();
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  test("overwrites existing file atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-atomic-"));
    const target = join(dir, "out.yml");
    writeFileSync(target, "old\n");
    atomicWrite(target, "new\n");
    expect(readFileSync(target, "utf-8")).toBe("new\n");
  });

  test("[F18 / 2026-05-09] read-only parent dir: failure portable across filesystems", () => {
    // Original test relied on EISDIR (target-is-directory). Some filesystems
    // (e.g., certain network mounts) shape the failure differently; this
    // additional case uses an explicit chmod-0500 parent so `openSync` of the
    // tmp file fails with EACCES — a more universally-portable failure mode.
    if (process.platform === "win32") {
      // Windows lacks POSIX permission semantics; chmod 0500 is a no-op.
      return;
    }
    if (process.getuid && process.getuid() === 0) {
      // Root bypasses 0500; this test is irrelevant.
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "trail-atomic-"));
    const readOnlyParent = join(dir, "ro-parent");
    mkdirSync(readOnlyParent, { recursive: true });
    chmodSync(readOnlyParent, 0o500);
    restoreOnAfter.push(readOnlyParent);

    const target = join(readOnlyParent, "out.yml");
    expect(() => atomicWrite(target, "hello\n")).toThrow();
    // The tmp file was not created (or was created and successfully unlinked).
    expect(existsSync(`${target}.tmp`)).toBe(false);
    // No partial target file either.
    expect(existsSync(target)).toBe(false);
  });
});
