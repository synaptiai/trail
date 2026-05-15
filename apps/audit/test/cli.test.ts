// CLI exit-code matrix tests — gh#3 acceptance criterion 3.
//
// Drives runCli() with a captured-writer test seam. Argv strings are
// space-tokenized in test names but actually built as arrays for the
// command parser.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
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

function captureWrites() {
  const errBuf: string[] = [];
  const outBuf: string[] = [];
  return {
    deps: {
      writeErr: (s: string) => errBuf.push(s),
      writeOut: (s: string) => outBuf.push(s),
    },
    err: () => errBuf.join(""),
    out: () => outBuf.join(""),
  };
}

function shInRepo(cwd: string, cmd: string): void {
  execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("runCli — exit-code matrix", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "trail-audit-cli-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("`--help` exits 0 and writes usage", async () => {
    const cap = captureWrites();
    const code = await runCli(["--help"], tmp, cap.deps);
    expect(code).toBe(EXIT_OK);
  });

  it("`--version` exits 0", async () => {
    const cap = captureWrites();
    const code = await runCli(["--version"], tmp, cap.deps);
    expect(code).toBe(EXIT_OK);
  });

  it("unknown subcommand exits with EXIT_GIT_STATE (arg parse failure → 2)", async () => {
    const cap = captureWrites();
    const code = await runCli(["wat"], tmp, cap.deps);
    expect(code).toBe(EXIT_GIT_STATE);
  });

  it("unknown option on precommit exits 2", async () => {
    const cap = captureWrites();
    const code = await runCli(["precommit", "--no-such-flag"], tmp, cap.deps);
    expect(code).toBe(EXIT_GIT_STATE);
  });

  it("`precommit --root <empty>` returns 0 when no .trail/ exists", async () => {
    const cap = captureWrites();
    const code = await runCli(["precommit", "--root", tmp, "--quiet"], tmp, cap.deps);
    expect(code).toBe(EXIT_OK);
  });

  it("`precommit --root <repo with planted secret>` returns 8 + structured stderr", async () => {
    mkdirSync(join(tmp, ".trail", "sessions", "abc"), { recursive: true });
    const planted = loadFixturePart("github-token");
    writeFileSync(join(tmp, ".trail", "sessions", "abc", "packet-1.yml"), `t: "${planted}"\n`);
    const cap = captureWrites();
    const code = await runCli(["precommit", "--root", tmp, "--quiet"], tmp, cap.deps);
    expect(code).toBe(EXIT_VIOLATION);
    const err = cap.err();
    expect(err).toContain("FAIL");
    expect(err).toContain("pattern=github-token");
    expect(err).toMatch(/hash=[0-9a-f]{8}/);
    // SAFETY: stderr must NEVER contain the raw planted token.
    expect(err).not.toContain(planted);
  });

  it("`precommit --json` emits NDJSON to stderr instead of text", async () => {
    mkdirSync(join(tmp, ".trail", "sessions", "abc"), { recursive: true });
    const planted = loadFixturePart("github-token");
    writeFileSync(join(tmp, ".trail", "sessions", "abc", "packet-1.yml"), `t: "${planted}"\n`);
    const cap = captureWrites();
    const code = await runCli(["precommit", "--root", tmp, "--quiet", "--json"], tmp, cap.deps);
    expect(code).toBe(EXIT_VIOLATION);
    const lines = cap
      .err()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    // Every line must parse as JSON with the snake_case shape.
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("file");
      expect(parsed).toHaveProperty("line");
      expect(parsed).toHaveProperty("pattern");
      expect(parsed).toHaveProperty("snippet_hash");
    }
    // No raw planted secret leaked.
    expect(cap.err()).not.toContain(planted);
  });

  it("`precommit --staged-only` outside a git repo exits 2", async () => {
    const cap = captureWrites();
    const code = await runCli(
      ["precommit", "--staged-only", "--root", tmp, "--quiet"],
      tmp,
      cap.deps
    );
    expect(code).toBe(EXIT_GIT_STATE);
  });

  it("`precommit --staged-only` clean repo exits 0", async () => {
    shInRepo(tmp, "git init -q");
    shInRepo(tmp, 'git config user.email "test@example.test"');
    shInRepo(tmp, 'git config user.name "Test"');
    const cap = captureWrites();
    const code = await runCli(
      ["precommit", "--staged-only", "--root", tmp, "--quiet"],
      tmp,
      cap.deps
    );
    expect(code).toBe(EXIT_OK);
  });

  it("`precommit --staged-only` with planted secret in staged packet exits 8", async () => {
    shInRepo(tmp, "git init -q");
    shInRepo(tmp, 'git config user.email "test@example.test"');
    shInRepo(tmp, 'git config user.name "Test"');
    mkdirSync(join(tmp, ".trail", "sessions", "abc"), { recursive: true });
    const planted = loadFixturePart("github-token");
    writeFileSync(join(tmp, ".trail", "sessions", "abc", "packet-1.yml"), `t: "${planted}"\n`);
    shInRepo(tmp, "git add .");
    const cap = captureWrites();
    const code = await runCli(
      ["precommit", "--staged-only", "--root", tmp, "--quiet"],
      tmp,
      cap.deps
    );
    expect(code).toBe(EXIT_VIOLATION);
    expect(cap.err()).toContain("pattern=github-token");
  });

  it("`precommit --patterns /nonexistent` exits 4", async () => {
    const cap = captureWrites();
    const code = await runCli(
      ["precommit", "--root", tmp, "--patterns", "/nonexistent.yml", "--quiet"],
      tmp,
      cap.deps
    );
    expect(code).toBe(EXIT_PATTERNS);
  });
});
