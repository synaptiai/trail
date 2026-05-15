// Audit orchestrator tests — gh#3 acceptance criteria 2 & 3.
//
// Validates the pure-ish entry point at src/audit.ts:
//   - Exit codes (0 clean, 2 git-state, 4 patterns, 8 violation)
//   - Default mode walks `<root>/.trail/` recursively for packet files
//   - --staged-only mode delegates to listStagedPackets()
//   - findings carry { file, line, pattern, snippetHash } shape
//
// Real git repos via mkdtempSync; no mocks.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { audit } from "../src/audit.js";
import { EXIT_GIT_STATE, EXIT_OK, EXIT_PATTERNS, EXIT_VIOLATION } from "../src/exit-codes.js";

const FIXTURES_PATH = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "fixtures",
  "synthetic-pattern-fixtures.json"
);

function loadFixturePart(name: string): string {
  const data = JSON.parse(readFileSync(FIXTURES_PATH, "utf-8")) as {
    fixtures: Record<string, string[]>;
  };
  return (data.fixtures[name] ?? []).join("");
}

function shInRepo(cwd: string, cmd: string): void {
  execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("audit() — Layer 3 orchestrator", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "trail-audit-orch-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("default (non-staged) mode — walk .trail/ recursively", () => {
    it("returns EXIT_OK when .trail/ is absent", async () => {
      const result = await audit({ root: tmp, stagedOnly: false, quiet: true });
      expect(result.exitCode).toBe(EXIT_OK);
      expect(result.findings).toEqual([]);
      expect(result.filesScanned).toBe(0);
    });

    it("returns EXIT_OK when .trail/ exists but contains no packets", async () => {
      mkdirSync(join(tmp, ".trail", "sessions", "abc"), { recursive: true });
      writeFileSync(join(tmp, ".trail", "index.db"), "binary");
      writeFileSync(join(tmp, ".trail", "sessions", "abc", "notes.txt"), "scratch");
      const result = await audit({ root: tmp, stagedOnly: false, quiet: true });
      expect(result.exitCode).toBe(EXIT_OK);
      expect(result.filesScanned).toBe(0);
    });

    it("returns EXIT_OK when packets contain only redacted markers", async () => {
      mkdirSync(join(tmp, ".trail", "sessions", "abc"), { recursive: true });
      writeFileSync(
        join(tmp, ".trail", "sessions", "abc", "packet-1.yml"),
        'token: "[REDACTED:github-token]"\n'
      );
      const result = await audit({ root: tmp, stagedOnly: false, quiet: true });
      expect(result.exitCode).toBe(EXIT_OK);
      expect(result.findings).toEqual([]);
      expect(result.filesScanned).toBe(1);
    });

    it("returns EXIT_VIOLATION when a planted secret is present in a packet", async () => {
      mkdirSync(join(tmp, ".trail", "sessions", "abc"), { recursive: true });
      const planted = loadFixturePart("github-token");
      writeFileSync(
        join(tmp, ".trail", "sessions", "abc", "packet-1.yml"),
        `token: "${planted}"\n`
      );
      const result = await audit({ root: tmp, stagedOnly: false, quiet: true });
      expect(result.exitCode).toBe(EXIT_VIOLATION);
      expect(result.findings.length).toBeGreaterThan(0);
      const githubFinding = result.findings.find((f) => f.pattern === "github-token");
      expect(githubFinding).toBeDefined();
      expect(githubFinding?.line).toBe(1);
      expect(githubFinding?.snippetHash).toMatch(/^[0-9a-f]{8}$/);
    });

    it("scans packet-N.md files (not just .yml)", async () => {
      mkdirSync(join(tmp, ".trail", "sessions", "abc"), { recursive: true });
      const planted = loadFixturePart("openai-api-key");
      writeFileSync(
        join(tmp, ".trail", "sessions", "abc", "packet-1.md"),
        `# Packet\n\nKey: ${planted}\n`
      );
      const result = await audit({ root: tmp, stagedOnly: false, quiet: true });
      expect(result.exitCode).toBe(EXIT_VIOLATION);
      expect(result.findings.some((f) => f.pattern === "openai-api-key")).toBe(true);
    });

    it("ignores non-packet files inside .trail/sessions/", async () => {
      mkdirSync(join(tmp, ".trail", "sessions", "abc"), { recursive: true });
      const planted = loadFixturePart("github-token");
      // Planted secret in a NON-packet file: should be ignored by the
      // boundary regex (criterion 2 narrows to packet-*.{yml,md}).
      writeFileSync(
        join(tmp, ".trail", "sessions", "abc", "notes.txt"),
        `random scratch with ${planted}\n`
      );
      const result = await audit({ root: tmp, stagedOnly: false, quiet: true });
      expect(result.exitCode).toBe(EXIT_OK);
      expect(result.filesScanned).toBe(0);
    });

    it("scans multiple sessions and surfaces all findings", async () => {
      const planted1 = loadFixturePart("github-token");
      const planted2 = loadFixturePart("openai-api-key");
      mkdirSync(join(tmp, ".trail", "sessions", "s1"), { recursive: true });
      mkdirSync(join(tmp, ".trail", "sessions", "s2"), { recursive: true });
      writeFileSync(join(tmp, ".trail", "sessions", "s1", "packet-1.yml"), `t: "${planted1}"\n`);
      writeFileSync(join(tmp, ".trail", "sessions", "s2", "packet-1.yml"), `t: "${planted2}"\n`);
      const result = await audit({ root: tmp, stagedOnly: false, quiet: true });
      expect(result.exitCode).toBe(EXIT_VIOLATION);
      expect(result.filesScanned).toBe(2);
      expect(result.findings.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("--staged-only mode", () => {
    function initRepo(dir: string) {
      shInRepo(dir, "git init -q");
      shInRepo(dir, 'git config user.email "test@example.test"');
      shInRepo(dir, 'git config user.name "Test"');
    }

    it("returns EXIT_GIT_STATE outside a git work tree", async () => {
      const result = await audit({ root: tmp, stagedOnly: true, quiet: true });
      expect(result.exitCode).toBe(EXIT_GIT_STATE);
      expect(result.gitError).toBeDefined();
      expect(result.gitError?.subShape).toBe("not-a-repo");
    });

    it("returns EXIT_OK when nothing is staged", async () => {
      initRepo(tmp);
      const result = await audit({ root: tmp, stagedOnly: true, quiet: true });
      expect(result.exitCode).toBe(EXIT_OK);
      expect(result.filesScanned).toBe(0);
    });

    it("returns EXIT_VIOLATION when a planted secret is in a staged packet", async () => {
      initRepo(tmp);
      mkdirSync(join(tmp, ".trail", "sessions", "abc"), { recursive: true });
      const planted = loadFixturePart("github-token");
      writeFileSync(join(tmp, ".trail", "sessions", "abc", "packet-1.yml"), `t: "${planted}"\n`);
      shInRepo(tmp, "git add .");
      const result = await audit({ root: tmp, stagedOnly: true, quiet: true });
      expect(result.exitCode).toBe(EXIT_VIOLATION);
      expect(result.findings.some((f) => f.pattern === "github-token")).toBe(true);
    });

    it("ignores on-disk packet files NOT in the staging area", async () => {
      initRepo(tmp);
      mkdirSync(join(tmp, ".trail", "sessions", "abc"), { recursive: true });
      const planted = loadFixturePart("github-token");
      // Write a planted-secret packet but DO NOT stage it.
      writeFileSync(join(tmp, ".trail", "sessions", "abc", "packet-1.yml"), `t: "${planted}"\n`);
      // Stage something else (a clean file outside .trail/).
      writeFileSync(join(tmp, "README.md"), "# Repo\n");
      shInRepo(tmp, "git add README.md");
      const result = await audit({ root: tmp, stagedOnly: true, quiet: true });
      expect(result.exitCode).toBe(EXIT_OK);
      expect(result.filesScanned).toBe(0);
    });
  });

  describe("patterns load failures (EXIT_PATTERNS=4)", () => {
    it("returns EXIT_PATTERNS when patternsPath does not exist", async () => {
      mkdirSync(join(tmp, ".trail", "sessions", "abc"), { recursive: true });
      writeFileSync(join(tmp, ".trail", "sessions", "abc", "packet-1.yml"), "ok\n");
      const result = await audit({
        root: tmp,
        stagedOnly: false,
        quiet: true,
        patternsPath: "/nonexistent/file.yml",
      });
      expect(result.exitCode).toBe(EXIT_PATTERNS);
      expect(result.patternsError).toBeDefined();
      // Cycle-3 C3-S-TR-005: weak `toBeDefined()` allowed any
      // truthy value to pass. Pin the subShape contract so a
      // refactor that returns a generic Error still fails this test.
      // subShape "a" = file-not-found (apps/capture/src/redaction/patterns.ts:75).
      expect(result.patternsError?.subShape).toBe("a");
      expect(result.patternsError?.message).toContain("file not found");
    });

    it("returns EXIT_PATTERNS when patternsPath is malformed YAML", async () => {
      const badPath = join(tmp, "bad-patterns.yml");
      writeFileSync(badPath, "version: '0.1'\npatterns: [\n  - name:\n");
      const result = await audit({
        root: tmp,
        stagedOnly: false,
        quiet: true,
        patternsPath: badPath,
      });
      expect(result.exitCode).toBe(EXIT_PATTERNS);
    });
  });
});
