// [F10 / 2026-05-09] CLI helper tests.
//
// findLatestSessionId scans `~/.claude/projects/<sanitized-cwd>/` for the
// newest `.jsonl` file. The cycle-1 review flagged that the original
// implementation used `require("node:fs")` (CommonJS bridge inside an ESM
// file) and silently returned null for relative cwds without an explicit
// guard. This test pins the contract:
//   - relative cwd → null (no crash)
//   - non-existent project dir → null
//   - present .jsonl files → newest by mtime is returned (no extension).

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findLatestSessionId } from "../src/cli.js";

describe("findLatestSessionId — F10", () => {
  let originalHome: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "trail-fakehome-"));
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      process.env.HOME = undefined;
    } else {
      process.env.HOME = originalHome;
    }
  });

  test("returns null for a relative cwd (no platform-specific surprises)", () => {
    expect(findLatestSessionId("./relative/path")).toBeNull();
    expect(findLatestSessionId("relative")).toBeNull();
  });

  test("returns null when project dir does not exist", () => {
    expect(findLatestSessionId("/no/such/path")).toBeNull();
  });

  test("returns the newest .jsonl session id when multiple exist", () => {
    const cwd = "/Users/alice/example";
    const sanitized = cwd.replace(/\//g, "-");
    const projectDir = join(fakeHome, ".claude", "projects", sanitized);
    mkdirSync(projectDir, { recursive: true });

    const oldFile = join(projectDir, "11111111-1111-1111-1111-111111111111.jsonl");
    const newFile = join(projectDir, "22222222-2222-2222-2222-222222222222.jsonl");
    writeFileSync(oldFile, "{}\n");
    writeFileSync(newFile, "{}\n");

    // Force a controlled mtime difference (older first, newer second).
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    utimesSync(oldFile, past, past);
    utimesSync(newFile, now, now);

    const result = findLatestSessionId(cwd);
    expect(result).toBe("22222222-2222-2222-2222-222222222222");
  });

  test("ignores non-jsonl files in the project dir", () => {
    const cwd = "/Users/alice/example";
    const sanitized = cwd.replace(/\//g, "-");
    const projectDir = join(fakeHome, ".claude", "projects", sanitized);
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(projectDir, "README.md"), "x\n");
    writeFileSync(join(projectDir, "notes.txt"), "x\n");
    writeFileSync(join(projectDir, "abcdef.jsonl"), "{}\n");

    expect(findLatestSessionId(cwd)).toBe("abcdef");
  });

  test("returns null when project dir exists but has no .jsonl files", () => {
    const cwd = "/Users/alice/example";
    const sanitized = cwd.replace(/\//g, "-");
    const projectDir = join(fakeHome, ".claude", "projects", sanitized);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "stray.txt"), "x\n");

    expect(findLatestSessionId(cwd)).toBeNull();
  });
});
