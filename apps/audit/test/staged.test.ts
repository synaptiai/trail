// Staged-files detection tests (gh#3 acceptance criterion 3).
//
// Strategy: spin up a temp git repo via `git init`, stage some files (some
// inside `.trail/sessions/<sid>/`, some outside), invoke listStagedPackets,
// and assert only the in-boundary AM-staged paths come back.
//
// Real subprocesses + real filesystem (per orchestrator hard-rule "no
// mocks/stubs/placeholders. Real fixtures, real subprocesses."). simple-git
// shells out to the real `git` binary; the test verifies the integration.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitStateError, isPacketPath, listStagedPackets } from "../src/staged.js";

function shInRepo(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("isPacketPath — scan boundary regex", () => {
  it("matches packet-N.yml under .trail/sessions/<sid>/", () => {
    expect(isPacketPath(".trail/sessions/abc123/packet-1.yml")).toBe(true);
    expect(isPacketPath(".trail/sessions/abc123/packet-42.yml")).toBe(true);
    expect(isPacketPath(".trail/sessions/uuid-shape-id/packet-1.md")).toBe(true);
  });

  it("rejects paths outside the .trail/sessions/<sid>/ envelope", () => {
    expect(isPacketPath("apps/audit/src/scanner.ts")).toBe(false);
    expect(isPacketPath(".trail/index.db")).toBe(false);
    expect(isPacketPath(".trail/sessions/abc/index.json")).toBe(false);
    expect(isPacketPath(".trail/sessions/abc/notes.txt")).toBe(false);
    // packet-shape file in wrong directory: rejected.
    expect(isPacketPath("scratch/packet-1.yml")).toBe(false);
    // nested packet path beyond <sid>/: rejected.
    expect(isPacketPath(".trail/sessions/abc/sub/packet-1.yml")).toBe(false);
  });

  it("normalizes Windows-style backslashes", () => {
    expect(isPacketPath(".trail\\sessions\\abc\\packet-1.yml")).toBe(true);
  });
});

describe("listStagedPackets — git diff --cached integration", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "trail-audit-staged-"));
    shInRepo(tmp, "git init -q");
    // Required for `git commit` if we ever do one (we don't here, but
    // some git versions warn loudly without these set).
    shInRepo(tmp, 'git config user.email "test@example.test"');
    shInRepo(tmp, 'git config user.name "Test"');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty list on a fresh repo with nothing staged", async () => {
    const result = await listStagedPackets({ cwd: tmp });
    expect(result).toEqual([]);
  });

  it("returns staged packet files inside .trail/sessions/<sid>/", async () => {
    mkdirSync(join(tmp, ".trail", "sessions", "sid-1"), { recursive: true });
    writeFileSync(join(tmp, ".trail", "sessions", "sid-1", "packet-1.yml"), "claims: []\n");
    writeFileSync(join(tmp, ".trail", "sessions", "sid-1", "packet-1.md"), "# Packet\n");
    shInRepo(tmp, "git add .");
    const result = await listStagedPackets({ cwd: tmp });
    expect(result.length).toBe(2);
    // simple-git emits forward slashes; our function returns absolute
    // paths anchored at cwd via posix.join.
    const tmpPosix = tmp.replace(/\\/g, "/");
    expect(result.some((p) => p === `${tmpPosix}/.trail/sessions/sid-1/packet-1.yml`)).toBe(true);
    expect(result.some((p) => p === `${tmpPosix}/.trail/sessions/sid-1/packet-1.md`)).toBe(true);
  });

  it("filters out non-packet files (e.g., apps/foo, .trail/index.db)", async () => {
    mkdirSync(join(tmp, ".trail", "sessions", "sid-1"), { recursive: true });
    mkdirSync(join(tmp, "apps", "foo"), { recursive: true });
    writeFileSync(join(tmp, ".trail", "sessions", "sid-1", "packet-1.yml"), "claims: []\n");
    writeFileSync(join(tmp, ".trail", "sessions", "sid-1", "notes.txt"), "scratch\n");
    writeFileSync(join(tmp, ".trail", "index.db"), "binary-stub");
    writeFileSync(join(tmp, "apps", "foo", "main.ts"), "// code\n");
    writeFileSync(join(tmp, "README.md"), "# Repo\n");
    shInRepo(tmp, "git add .");
    const result = await listStagedPackets({ cwd: tmp });
    expect(result.length).toBe(1);
    expect(result[0]?.endsWith(".trail/sessions/sid-1/packet-1.yml")).toBe(true);
  });

  it("respects --diff-filter=AM (deleted files are ignored)", async () => {
    mkdirSync(join(tmp, ".trail", "sessions", "sid-1"), { recursive: true });
    writeFileSync(join(tmp, ".trail", "sessions", "sid-1", "packet-1.yml"), "claims: []\n");
    shInRepo(tmp, "git add .");
    shInRepo(tmp, 'git commit -q -m "initial"');
    // Now delete + stage the deletion.
    rmSync(join(tmp, ".trail", "sessions", "sid-1", "packet-1.yml"));
    shInRepo(tmp, "git add -A");
    // Status: D (deleted) is excluded by --diff-filter=AM. Result: empty.
    const result = await listStagedPackets({ cwd: tmp });
    expect(result).toEqual([]);
  });

  it("throws GitStateError(not-a-repo) outside a git work tree", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "trail-audit-nonrepo-"));
    try {
      await expect(listStagedPackets({ cwd: nonRepo })).rejects.toBeInstanceOf(GitStateError);
      await expect(listStagedPackets({ cwd: nonRepo })).rejects.toMatchObject({
        subShape: "not-a-repo",
      });
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
