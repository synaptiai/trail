// `trail packet post` orchestrator tests. Use the GhRunner DI seam to
// simulate gh CLI responses without a real PR. Real-PR end-to-end coverage
// lives in the integration test (gated behind GH_E2E env var).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  EXIT_AUTH,
  EXIT_GENERIC,
  EXIT_OK,
  EXIT_PR_NOT_FOUND,
  EXIT_RATE_LIMIT,
  EXIT_TRANSCRIPT_NOT_FOUND,
} from "../src/exit-codes.js";
import { dumpYaml, loadYaml } from "../src/packet/yaml.js";
import { FENCE_END, FENCE_START } from "../src/post/fence.js";
import type { GhRunResult, GhRunner } from "../src/post/gh-shell.js";
import { packetPost } from "../src/post/index.js";

// Minimal valid Phase 1 packet shape for the renderer to consume.
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
  const dir = mkdtempSync(join(tmpdir(), "trail-post-orch-"));
  const path = join(dir, "packet-1.yml");
  writeFileSync(path, dumpYaml(syntheticPacket()), "utf-8");
  return path;
}

interface ScriptedCall {
  match: (args: string[]) => boolean;
  result: GhRunResult;
}

function scriptRunner(calls: ScriptedCall[]): {
  runner: GhRunner;
  callIndex: () => number;
  capturedArgs: string[][];
} {
  let i = 0;
  const captured: string[][] = [];
  const runner: GhRunner = {
    async run(args: string[]): Promise<GhRunResult> {
      captured.push([...args]);
      const next = calls[i++];
      if (!next) throw new Error(`unexpected gh call: ${args.join(" ")}`);
      if (!next.match(args)) {
        throw new Error(
          `gh call mismatch at index ${i - 1}: got ${args.join(" ")}; expected match`
        );
      }
      return next.result;
    },
  };
  return { runner, callIndex: () => i, capturedArgs: captured };
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

describe("packetPost — happy path (AC-1, AC-3, AC-4, AC-5, AC-7, AC-9)", () => {
  test("first post: fence inserted; PR body update issued; posted_to_pr appended", async () => {
    const packetPath = writePacketFile();
    const { runner, capturedArgs } = scriptRunner([
      // 1. gh auth status
      { match: (a) => a[0] === "auth" && a[1] === "status", result: ok("") },
      // 2. gh pr view --json number,url,headRefName
      {
        match: (a) => a[0] === "pr" && a[1] === "view",
        result: ok(
          JSON.stringify({
            number: 432,
            url: "https://github.com/owner/repo/pull/432",
            headRefName: "feat/x",
          })
        ),
      },
      // 3. gh repo view --json nameWithOwner
      {
        match: (a) => a[0] === "repo" && a[1] === "view",
        result: ok(JSON.stringify({ nameWithOwner: "owner/repo" })),
      },
      // 4. gh api repos/owner/repo/pulls/432
      {
        match: (a) => a[0] === "api" && a[1] === "repos/owner/repo/pulls/432",
        result: ok(JSON.stringify({ body: "## Existing\n\nUser content here.\n" })),
      },
      // 5. gh pr edit 432 --body-file <path>
      {
        match: (a) => a[0] === "pr" && a[1] === "edit" && a[2] === "432",
        result: ok(""),
      },
    ]);
    const stderr = new StringSink();
    const result = await packetPost({
      packetPath,
      yes: true,
      postedBy: "alice@example.com",
      ghRunner: runner,
      now: new Date("2026-05-09T03:05:20.148Z"),
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.prNumber).toBe(432);
    expect(result.prUrl).toBe("https://github.com/owner/repo/pull/432");
    expect(result.bodyHash).toMatch(/^[a-f0-9]{64}$/);

    // Verify the gh pr edit invocation used --body-file (AC-5: not inline body).
    const editCall = capturedArgs.find((a) => a[0] === "pr" && a[1] === "edit");
    expect(editCall).toBeDefined();
    expect(editCall).toContain("--body-file");

    // Verify destination header was emitted to stderr.
    expect(stderr.buf).toContain("Posting to owner/repo#432");

    // Verify packet's posted_to_pr[] was appended (AC-4, AC-9).
    const updated = loadYaml(readFileSync(packetPath, "utf-8")) as {
      posted_to_pr: Array<Record<string, unknown>>;
    };
    expect(updated.posted_to_pr.length).toBe(1);
    const entry = updated.posted_to_pr[0];
    expect(entry.pr_url).toBe("https://github.com/owner/repo/pull/432");
    expect(entry.pr_number).toBe(432);
    expect(entry.body_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.posted_by).toBe("alice@example.com");
    expect(entry.posted_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*\+00:00$/);
  });

  test("re-post: fenced section UPDATED in place (no duplicate); posted_to_pr accumulates (AC-4)", async () => {
    const packetPath = writePacketFile();

    // Pre-existing PR body already has a Trail fence + user content outside.
    const preExistingBody = `## Description\n\nOriginal text.\n\n${FENCE_START}\nstale packet content\n${FENCE_END}\n\n## Closes\n\n#100\n`;

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
        if (args[0] === "api") return ok(JSON.stringify({ body: preExistingBody }));
        if (args[0] === "pr" && args[1] === "edit") {
          // Capture the body file content so we can assert AC-1 + AC-4.
          const bodyFileIdx = args.indexOf("--body-file");
          const bodyFile = args[bodyFileIdx + 1];
          editBodyContent = readFileSync(bodyFile!, "utf-8");
          return ok("");
        }
        throw new Error(`unexpected: ${args.join(" ")}`);
      },
    };
    const stderr = new StringSink();
    const result = await packetPost({
      packetPath,
      yes: true,
      postedBy: "alice@example.com",
      ghRunner: runner,
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_OK);

    // AC-1: fence start/end appear exactly once each.
    expect((editBodyContent.match(new RegExp(FENCE_START, "g")) ?? []).length).toBe(1);
    expect((editBodyContent.match(new RegExp(FENCE_END, "g")) ?? []).length).toBe(1);
    // AC-1: outside-fence content preserved.
    expect(editBodyContent).toContain("Original text.");
    expect(editBodyContent).toContain("## Closes");
    expect(editBodyContent).toContain("#100");
    // Stale fence content was replaced.
    expect(editBodyContent).not.toContain("stale packet content");
  });

  // TR-3 (P2): explicit end-to-end double-post on the SAME packet through
  // packetPost(). Cycle-1 reviewer note: AC-4's "subsequent post APPENDS to
  // posted_to_pr[]" property was only verified piecewise (re-post fence
  // count via post.test.ts:225-275 + accumulate via posted-to-pr.test.ts:89-105)
  // — not end-to-end through two real packetPost() invocations on the same
  // packet (only the gated GH_E2E test did that). This test closes the gap.
  test("double-post on same packet: posted_to_pr[] accumulates AND fence stays singleton (AC-4 e2e)", async () => {
    const packetPath = writePacketFile();

    // Body state mutates between calls — first call writes fence + content,
    // second call sees that fence and updates it in place.
    let prBodyState = "## Description\n\nOriginal user content.\n";
    let editBodyContent = "";
    const runner: GhRunner = {
      async run(args) {
        if (args[0] === "auth") return ok("");
        if (args[0] === "pr" && args[1] === "view") {
          return ok(
            JSON.stringify({
              number: 7,
              url: "https://github.com/owner/repo/pull/7",
              headRefName: "feat/x",
            })
          );
        }
        if (args[0] === "repo") return ok(JSON.stringify({ nameWithOwner: "owner/repo" }));
        if (args[0] === "api") return ok(JSON.stringify({ body: prBodyState }));
        if (args[0] === "pr" && args[1] === "edit") {
          const bodyFileIdx = args.indexOf("--body-file");
          const bodyFile = args[bodyFileIdx + 1];
          editBodyContent = readFileSync(bodyFile!, "utf-8");
          // Update the simulated PR body so the next gh api call returns
          // the now-fenced body — that's what GitHub would do.
          prBodyState = editBodyContent;
          return ok("");
        }
        throw new Error(`unexpected: ${args.join(" ")}`);
      },
    };

    const stderr1 = new StringSink();
    const r1 = await packetPost({
      packetPath,
      yes: true,
      postedBy: "alice@example.com",
      ghRunner: runner,
      now: new Date("2026-05-09T03:05:20.148Z"),
      stderr: stderr1,
    });
    expect(r1.exitCode).toBe(EXIT_OK);

    // First post must have appended a single posted_to_pr entry.
    const afterFirst = loadYaml(readFileSync(packetPath, "utf-8")) as {
      posted_to_pr: Array<Record<string, unknown>>;
    };
    expect(afterFirst.posted_to_pr.length).toBe(1);

    // Second post on the SAME packet path.
    const stderr2 = new StringSink();
    const r2 = await packetPost({
      packetPath,
      yes: true,
      postedBy: "alice@example.com",
      ghRunner: runner,
      now: new Date("2026-05-09T03:10:00.000Z"),
      stderr: stderr2,
    });
    expect(r2.exitCode).toBe(EXIT_OK);

    // AC-4 part 1: posted_to_pr[] accumulates (does NOT replace).
    const afterSecond = loadYaml(readFileSync(packetPath, "utf-8")) as {
      posted_to_pr: Array<Record<string, unknown>>;
    };
    expect(afterSecond.posted_to_pr.length).toBe(2);
    expect(afterSecond.posted_to_pr[0]?.posted_at).toBeDefined();
    expect(afterSecond.posted_to_pr[1]?.posted_at).toBeDefined();

    // AC-4 part 2: the fence in the FINAL body is still a singleton (re-post
    // updated in place). The body the test captured is the one written by
    // the second `gh pr edit` call.
    expect((editBodyContent.match(new RegExp(FENCE_START, "g")) ?? []).length).toBe(1);
    expect((editBodyContent.match(new RegExp(FENCE_END, "g")) ?? []).length).toBe(1);
    // Outside-fence content preserved end-to-end.
    expect(editBodyContent).toContain("Original user content.");
  });
});

describe("packetPost — error paths (AC-3, AC-8)", () => {
  test("missing packet path → exit EXIT_TRANSCRIPT_NOT_FOUND", async () => {
    const runner: GhRunner = {
      async run() {
        return ok("");
      },
    };
    const stderr = new StringSink();
    const result = await packetPost({
      packetPath: "/nonexistent/packet.yml",
      yes: true,
      postedBy: "x",
      ghRunner: runner,
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_TRANSCRIPT_NOT_FOUND);
    expect(stderr.buf).toContain("packet not found");
  });

  test("auth fail → EXIT_AUTH (3); no further gh calls", async () => {
    const packetPath = writePacketFile();
    const calls: string[][] = [];
    const runner: GhRunner = {
      async run(args) {
        calls.push(args);
        if (args[0] === "auth") return fail("error: you are not logged into any GitHub hosts");
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    };
    const stderr = new StringSink();
    const result = await packetPost({
      packetPath,
      yes: true,
      postedBy: "x",
      ghRunner: runner,
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_AUTH);
    expect(calls.length).toBe(1); // auth was the only call
    expect(stderr.buf).toContain("authentication");
  });

  test("PR not found → EXIT_PR_NOT_FOUND (9)", async () => {
    const packetPath = writePacketFile();
    const runner: GhRunner = {
      async run(args) {
        if (args[0] === "auth") return ok("");
        if (args[0] === "pr" && args[1] === "view") {
          return fail("could not resolve to a Pull Request with the number 9999");
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    };
    const stderr = new StringSink();
    const result = await packetPost({
      packetPath,
      prNumber: 9999,
      yes: true,
      postedBy: "x",
      ghRunner: runner,
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_PR_NOT_FOUND);
    expect(stderr.buf).toContain("9999");
  });

  test("interactive confirm rejection (--yes not set) → user aborts cleanly", async () => {
    const packetPath = writePacketFile();
    const runner: GhRunner = {
      async run(args) {
        if (args[0] === "auth") return ok("");
        if (args[0] === "pr" && args[1] === "view") {
          return ok(
            JSON.stringify({
              number: 1,
              url: "https://github.com/o/r/pull/1",
              headRefName: "x",
            })
          );
        }
        if (args[0] === "repo") return ok(JSON.stringify({ nameWithOwner: "o/r" }));
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    };
    const stderr = new StringSink();
    const result = await packetPost({
      packetPath,
      yes: false,
      postedBy: "x",
      ghRunner: runner,
      confirm: async () => false,
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_GENERIC);
    expect(stderr.buf).toContain("aborted");
  });

  test("rate-limit on body fetch → exit 7", async () => {
    const packetPath = writePacketFile();
    const runner: GhRunner = {
      async run(args) {
        if (args[0] === "auth") return ok("");
        if (args[0] === "pr" && args[1] === "view") {
          return ok(JSON.stringify({ number: 1, url: "https://x/pull/1", headRefName: "x" }));
        }
        if (args[0] === "repo") return ok(JSON.stringify({ nameWithOwner: "o/r" }));
        if (args[0] === "api") return fail("HTTP 429: rate limit exceeded");
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    };
    const stderr = new StringSink();
    const result = await packetPost({
      packetPath,
      yes: true,
      postedBy: "x",
      ghRunner: runner,
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_RATE_LIMIT);
    expect(stderr.buf).toContain("rate-limited");
  });

  test("PR body fetch returns null body → still posts (treated as empty)", async () => {
    const packetPath = writePacketFile();
    let editIssued = false;
    const runner: GhRunner = {
      async run(args) {
        if (args[0] === "auth") return ok("");
        if (args[0] === "pr" && args[1] === "view") {
          return ok(JSON.stringify({ number: 1, url: "https://x/pull/1", headRefName: "x" }));
        }
        if (args[0] === "repo") return ok(JSON.stringify({ nameWithOwner: "o/r" }));
        if (args[0] === "api") return ok(JSON.stringify({ body: null }));
        if (args[0] === "pr" && args[1] === "edit") {
          editIssued = true;
          return ok("");
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    };
    const stderr = new StringSink();
    const result = await packetPost({
      packetPath,
      yes: true,
      postedBy: "x",
      ghRunner: runner,
      stderr,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(editIssued).toBe(true);
  });
});
