// `trail packet decide` orchestrator tests. Use the GhRunner DI seam.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { packetDecide, renderDecisionComment } from "../src/decide/index.js";
import {
  EXIT_AUTH,
  EXIT_INVALID_ARGS,
  EXIT_OK,
  EXIT_TRANSCRIPT_NOT_FOUND,
} from "../src/exit-codes.js";
import { dumpYaml, loadYaml } from "../src/packet/yaml.js";
import type { GhRunResult, GhRunner } from "../src/post/gh-shell.js";

function syntheticPacket(): Record<string, unknown> {
  return {
    packet_version: "0.1.1",
    _meta: {
      packet_id: "01ABCDEFGHIJKLMNPQRSTVWXYZ",
      generated_at: "2026-05-09T00:00:00.000+00:00",
      generator: { name: "trail", version: "0.1.0-dev" },
      schema_url: "schema/pr-change-packet.v0.1.1.yml",
      capture_method: "post_hoc",
      parent_packet_id: null,
    },
    pr: {
      provider: "github",
      repository: "owner/repo",
      branch: "feat/x",
      base_branch: "main",
      pr_number: null,
      author: "alice@example.com",
    },
    task_intent: {
      source_type: "prompt",
      source_ref: "PROMPT-001",
      summary: "do thing",
      acceptance_criteria: [],
    },
    agent_session: {
      tool: "claude-code",
      model: "claude-opus-4-7",
      models: ["claude-opus-4-7"],
      started_at: "2026-05-09T00:00:00.000+00:00",
      ended_at: "2026-05-09T00:01:00.000+00:00",
      session_id: "test-session",
      transcript_summary: [],
      prompts: { initial: "test", followups: [] },
      redaction_metadata: {
        pattern_set_version: "0.1.0",
        pattern_set_origin: "bundled",
        redactions_applied: 0,
        redactions_by_pattern: {},
        validation_errors: [],
        skipped_files: [],
      },
    },
    diff_summary: {
      base_sha: "0".repeat(40),
      head_sha: "1".repeat(40),
      files_changed: 1,
      lines_added: 1,
      lines_deleted: 0,
      modules_touched: ["x"],
      semantic_changes: [
        {
          id: "DIFF-001",
          description: "Wrote x.ts",
          files: ["x.ts"],
          operation: "write",
          excerpts: [],
        },
      ],
    },
    commands_run: [],
    test_evidence: { passed: [], failed: [], not_run: [] },
    provenance: {
      authorship: {
        ai_generated_estimate: "high",
        human_modified_estimate: "unknown",
        method: "post-hoc-transcript",
      },
      agent_touched_files: ["x.ts"],
      human_touched_files: [],
    },
    summary: {
      claims: [
        {
          id: "CLAIM-001",
          stable_id: "0123456789abcdef",
          text: "wrote x",
          evidence_refs: ["DIFF-001"],
          confidence: "supported",
          synthesis_mode: "mechanical",
        },
      ],
      ungrounded_claim_count: 0,
    },
  };
}

function writePacketFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "trail-decide-"));
  const path = join(dir, "packet-1.yml");
  writeFileSync(path, dumpYaml(syntheticPacket()), "utf-8");
  return path;
}

function ok(stdout: string): GhRunResult {
  return { stdout, stderr: "", exitCode: 0 };
}
function fail(stderr: string, exitCode = 1): GhRunResult {
  return { stdout: "", stderr, exitCode };
}

class StringSink {
  buf = "";
  write(s: string): void {
    this.buf += s;
  }
}

function happyPathRunner(opts: { onCommentBody?: (s: string) => void } = {}): GhRunner {
  return {
    async run(args) {
      if (args[0] === "auth") return ok("");
      if (args[0] === "pr" && args[1] === "view") {
        return ok(
          JSON.stringify({
            number: 432,
            url: "https://github.com/owner/repo/pull/432",
            headRefName: "feat/x",
          })
        );
      }
      if (args[0] === "repo") return ok(JSON.stringify({ nameWithOwner: "owner/repo" }));
      if (args[0] === "api") return ok(JSON.stringify({ body: "## Description\n" }));
      if (args[0] === "pr" && args[1] === "comment") {
        const fileIdx = args.indexOf("--body-file");
        const file = args[fileIdx + 1];
        if (file && opts.onCommentBody) {
          opts.onCommentBody(readFileSync(file, "utf-8"));
        }
        return ok("");
      }
      if (args[0] === "pr" && args[1] === "edit") return ok("");
      throw new Error(`unexpected ${args.join(" ")}`);
    },
  };
}

describe("renderDecisionComment", () => {
  test("includes claim id, decision label, by, at, reason", () => {
    const md = renderDecisionComment({
      claim_id: "CLAIM-001",
      decision: "block",
      reason: "needs review by security team",
      by: "alice@example.com",
      at: "2026-05-09T00:00:00.000+00:00",
    });
    expect(md).toContain("CLAIM-001");
    expect(md).toContain("Blocked");
    expect(md).toContain("alice@example.com");
    expect(md).toContain("2026-05-09T00:00:00.000+00:00");
    expect(md).toContain("needs review by security team");
    expect(md).toContain("trail packet decide");
  });

  test("omits reason block when reason is empty", () => {
    const md = renderDecisionComment({
      claim_id: "CLAIM-001",
      decision: "accept",
      reason: null,
      by: "x",
      at: "2026-05-09T00:00:00.000+00:00",
    });
    expect(md).toContain("Accepted");
    // No "> " quote prefix when reason is null/empty.
    expect(md.split("\n").filter((l) => l.startsWith("> ")).length).toBe(0);
  });
});

describe("packetDecide — happy path (AC-6)", () => {
  test("appends approval_trail entry, posts comment, refreshes body", async () => {
    const packetPath = writePacketFile();
    let commentBody = "";
    const runner = happyPathRunner({
      onCommentBody: (s) => {
        commentBody = s;
      },
    });
    const stderr = new StringSink();
    const result = await packetDecide({
      packetPath,
      claim: "CLAIM-001",
      decision: "block",
      reason: "security concern",
      by: "alice@example.com",
      ghRunner: runner,
      now: new Date("2026-05-09T03:05:20.148Z"),
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_OK);

    // approval_trail[] entry written.
    const updated = loadYaml(readFileSync(packetPath, "utf-8")) as {
      approval_trail: Array<Record<string, unknown>>;
      posted_to_pr?: Array<Record<string, unknown>>;
    };
    expect(updated.approval_trail.length).toBe(1);
    expect(updated.approval_trail[0].claim_id).toBe("CLAIM-001");
    expect(updated.approval_trail[0].decision).toBe("block");
    expect(updated.approval_trail[0].reason).toBe("security concern");
    expect(updated.approval_trail[0].by).toBe("alice@example.com");
    expect(updated.approval_trail[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T.*\+00:00$/);

    // Comment markdown contains the rendered decision.
    expect(commentBody).toContain("CLAIM-001");
    expect(commentBody).toContain("Blocked");
    expect(commentBody).toContain("security concern");

    // posted_to_pr also gets a fresh entry from the body refresh (AC-6 ledger).
    expect(updated.posted_to_pr?.length).toBe(1);
  });

  test("accepts stable_id form (16-hex) for --claim", async () => {
    const packetPath = writePacketFile();
    const stderr = new StringSink();
    const result = await packetDecide({
      packetPath,
      claim: "0123456789abcdef",
      decision: "accept",
      reason: null,
      by: "alice",
      ghRunner: happyPathRunner(),
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_OK);
  });

  // CR-1 / AC-6 (gh#4): the PR-body fence content MUST change after a decide
  // call (because the renderer surfaces approval_trail[]). Without renderer
  // extension, the re-pushed body would be byte-identical and the public
  // surface would not reflect the new decision state.
  test("body refresh contains the new approval_trail entry (visible state changes)", async () => {
    const packetPath = writePacketFile();
    let editBodyContent = "";
    const runner: GhRunner = {
      async run(args) {
        if (args[0] === "auth") return ok("");
        if (args[0] === "pr" && args[1] === "view") {
          return ok(
            JSON.stringify({
              number: 432,
              url: "https://github.com/owner/repo/pull/432",
              headRefName: "feat/x",
            })
          );
        }
        if (args[0] === "repo") return ok(JSON.stringify({ nameWithOwner: "owner/repo" }));
        if (args[0] === "api") return ok(JSON.stringify({ body: "## Description\n" }));
        if (args[0] === "pr" && args[1] === "comment") return ok("");
        if (args[0] === "pr" && args[1] === "edit") {
          const fileIdx = args.indexOf("--body-file");
          const file = args[fileIdx + 1];
          if (file) editBodyContent = readFileSync(file, "utf-8");
          return ok("");
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    };
    const stderr = new StringSink();
    const result = await packetDecide({
      packetPath,
      claim: "CLAIM-001",
      decision: "block",
      reason: "security concern xyz",
      by: "alice@example.com",
      ghRunner: runner,
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_OK);

    // The pushed body must contain the rendered Approval Trail section
    // populated with the just-recorded decision.
    expect(editBodyContent).toContain("## Approval Trail");
    expect(editBodyContent).toContain("`CLAIM-001`");
    expect(editBodyContent).toContain("🛑 block");
    expect(editBodyContent).toContain("alice@example.com");
    expect(editBodyContent).toContain("security concern xyz");
  });
});

describe("packetDecide — validation (AC-6 input gates)", () => {
  test("invalid --decision rejected", async () => {
    const packetPath = writePacketFile();
    const stderr = new StringSink();
    const result = await packetDecide({
      packetPath,
      claim: "CLAIM-001",
      decision: "approve" as never,
      reason: null,
      by: "x",
      ghRunner: happyPathRunner(),
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_INVALID_ARGS);
    expect(stderr.buf).toContain("--decision");
  });

  test("invalid claim format rejected", async () => {
    const packetPath = writePacketFile();
    const stderr = new StringSink();
    const result = await packetDecide({
      packetPath,
      claim: "not-a-claim",
      decision: "accept",
      reason: null,
      by: "x",
      ghRunner: happyPathRunner(),
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_INVALID_ARGS);
    expect(stderr.buf).toContain("CLAIM-NNN");
  });

  test("reason >500 chars rejected", async () => {
    const packetPath = writePacketFile();
    const stderr = new StringSink();
    const result = await packetDecide({
      packetPath,
      claim: "CLAIM-001",
      decision: "changes",
      reason: "x".repeat(501),
      by: "y",
      ghRunner: happyPathRunner(),
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_INVALID_ARGS);
    expect(stderr.buf).toContain("500");
  });

  test("changes/block/reject with no reason rejected (J9 step 2)", async () => {
    const packetPath = writePacketFile();
    for (const decision of ["changes", "block", "reject"] as const) {
      const stderr = new StringSink();
      const result = await packetDecide({
        packetPath,
        claim: "CLAIM-001",
        decision,
        reason: null,
        by: "y",
        ghRunner: happyPathRunner(),
        stderr,
      });
      expect(result.exitCode).toBe(EXIT_INVALID_ARGS);
      expect(stderr.buf).toContain("--reason is required");
    }
  });

  test("missing --by rejected", async () => {
    const packetPath = writePacketFile();
    const stderr = new StringSink();
    const result = await packetDecide({
      packetPath,
      claim: "CLAIM-001",
      decision: "accept",
      reason: null,
      by: "",
      ghRunner: happyPathRunner(),
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_INVALID_ARGS);
    expect(stderr.buf).toContain("--by is required");
  });

  test("claim id that doesn't resolve in packet rejected", async () => {
    const packetPath = writePacketFile();
    const stderr = new StringSink();
    const result = await packetDecide({
      packetPath,
      claim: "CLAIM-999",
      decision: "accept",
      reason: null,
      by: "y",
      ghRunner: happyPathRunner(),
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_INVALID_ARGS);
    expect(stderr.buf).toContain("does not resolve");
  });

  test("missing packet path → EXIT_TRANSCRIPT_NOT_FOUND", async () => {
    const stderr = new StringSink();
    const result = await packetDecide({
      packetPath: "/no/such/packet.yml",
      claim: "CLAIM-001",
      decision: "accept",
      reason: null,
      by: "y",
      ghRunner: happyPathRunner(),
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_TRANSCRIPT_NOT_FOUND);
  });

  test("auth fail → EXIT_AUTH; approval_trail NOT touched", async () => {
    const packetPath = writePacketFile();
    const runner: GhRunner = {
      async run(args) {
        if (args[0] === "auth") return fail("not logged in");
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    };
    const stderr = new StringSink();
    const result = await packetDecide({
      packetPath,
      claim: "CLAIM-001",
      decision: "accept",
      reason: null,
      by: "y",
      ghRunner: runner,
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_AUTH);
    const updated = loadYaml(readFileSync(packetPath, "utf-8")) as {
      approval_trail?: unknown[];
    };
    // approval_trail should NOT be present (we failed before write).
    expect(updated.approval_trail).toBeUndefined();
  });
});
