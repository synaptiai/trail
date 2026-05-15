// End-to-end integration test for generate() — real transcript, real disk write.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import jsYaml from "js-yaml";
import { describe, expect, test } from "vitest";
import { generate } from "../src/generate.js";
import { VERSION } from "../src/version.js";

const SESSION_ID = "18e374b5-4eb9-424d-a3ff-a639d1c6fada";
const TRANSCRIPT_PATH = join(
  homedir(),
  ".claude",
  "projects",
  "-Users-danielbentes-trail",
  `${SESSION_ID}.jsonl`
);

const transcriptAvailable = existsSync(TRANSCRIPT_PATH);

describe.runIf(transcriptAvailable)("generate() integration", () => {
  test("produces packet-1.yml + packet-1.md against fresh state", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "trail-int-"));
    // Initialize as a git repo so collectGitState succeeds.
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd });
    execSync("git config user.email test@example.com", { cwd });
    execSync("git config user.name test", { cwd });
    writeFileSync(join(cwd, ".gitignore"), ".trail/\n");

    const sessionDir = join(cwd, ".trail", "sessions", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });

    const result = await generate({
      sessionId: SESSION_ID,
      cwd,
      noLlm: true,
      llmModel: "haiku",
      llmBudgetUsd: 0.5,
      llmTimeoutSeconds: 120,
      perDiff: false,
      format: "both",
      strictRedaction: false,
      strictLlm: false,
      dryRun: false,
      noStorage: true,
      quiet: true,
      transcriptPath: TRANSCRIPT_PATH,
      packetId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      generatedAt: "2026-05-09T03:05:20.148537+00:00",
    });
    expect(result.exitCode).toBe(0);
    expect(result.yamlPath).toBe(join(sessionDir, "packet-1.yml"));
    expect(result.mdPath).toBe(join(sessionDir, "packet-1.md"));
    expect(existsSync(result.yamlPath!)).toBe(true);
    expect(existsSync(result.mdPath!)).toBe(true);

    const parsed = jsYaml.load(readFileSync(result.yamlPath!, "utf-8")) as Record<string, unknown>;
    expect(parsed.packet_version).toBe("0.1.1");
    // Pin runtime-emitted generator version to the source-of-truth constant
    // so a future revert of version.ts (cycle-1.5 review F2-25) reddens
    // immediately rather than silently shipping with the wrong tag string.
    const meta = parsed._meta as Record<string, unknown>;
    expect((meta.generator as Record<string, unknown>).version).toBe(VERSION);
    expect((parsed._meta as Record<string, unknown>).packet_id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect((parsed._meta as Record<string, unknown>).parent_packet_id).toBeNull();
  }, 60_000);

  test("re-capture writes packet-2.yml with parent_packet_id", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "trail-int-"));
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd });
    execSync("git config user.email test@example.com", { cwd });
    execSync("git config user.name test", { cwd });
    writeFileSync(join(cwd, ".gitignore"), ".trail/\n");

    const sessionDir = join(cwd, ".trail", "sessions", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
    // Plant a fake packet-1.yml so re-capture detects N=2.
    writeFileSync(
      join(sessionDir, "packet-1.yml"),
      "_meta:\n  packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n"
    );

    const result = await generate({
      sessionId: SESSION_ID,
      cwd,
      noLlm: true,
      llmModel: "haiku",
      llmBudgetUsd: 0.5,
      llmTimeoutSeconds: 120,
      perDiff: false,
      format: "yaml",
      strictRedaction: false,
      strictLlm: false,
      dryRun: false,
      noStorage: true,
      quiet: true,
      transcriptPath: TRANSCRIPT_PATH,
      packetId: "01BBBBBBBBBBBBBBBBBBBBBBBB",
      generatedAt: "2026-05-09T03:05:20.148537+00:00",
    });
    expect(result.exitCode).toBe(0);
    expect(result.yamlPath).toBe(join(sessionDir, "packet-2.yml"));
    const parsed = jsYaml.load(readFileSync(result.yamlPath!, "utf-8")) as Record<string, unknown>;
    expect((parsed._meta as Record<string, unknown>).parent_packet_id).toBe(
      "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    );
  }, 60_000);

  test("--dry-run emits stdout summary, no files on disk", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "trail-int-"));
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd });
    execSync("git config user.email test@example.com", { cwd });
    execSync("git config user.name test", { cwd });
    writeFileSync(join(cwd, ".gitignore"), ".trail/\n");

    const result = await generate({
      sessionId: SESSION_ID,
      cwd,
      noLlm: true,
      llmModel: "haiku",
      llmBudgetUsd: 0.5,
      llmTimeoutSeconds: 120,
      perDiff: false,
      format: "both",
      strictRedaction: false,
      strictLlm: false,
      dryRun: true,
      noStorage: true,
      quiet: true,
      transcriptPath: TRANSCRIPT_PATH,
    });
    expect(result.exitCode).toBe(0);
    const sessionDir = join(cwd, ".trail", "sessions", SESSION_ID);
    expect(existsSync(join(sessionDir, "packet-1.yml"))).toBe(false);
    expect(existsSync(join(sessionDir, "packet-1.md"))).toBe(false);
  }, 60_000);
});
