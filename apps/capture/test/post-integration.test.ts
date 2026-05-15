// End-to-end integration test for `trail packet post` + `trail packet decide`
// against a real PR via real `gh` CLI. Runs ONLY when GH_E2E=1 in env;
// otherwise skipped (so unit-test runs in CI stay fast and don't depend on
// network or PR sandbox state).
//
// Usage: set GH_E2E_PR=<pr-number> GH_E2E_REPO=<owner/repo> GH_E2E=1 and
// have a working `gh auth status` against that repo.
//
// This test is the AC-10 + cross-platform-real-gh enforcement. It exercises:
//   - real gh subprocess spawn
//   - real network (gh auth, gh repo view, gh pr view, gh api, gh pr edit, gh pr comment)
//   - real PR body update + idempotent re-post
//   - real packet YAML round-trip via posted_to_pr[] + approval_trail[]

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { packetDecide } from "../src/decide/index.js";
import { dumpYaml, loadYaml } from "../src/packet/yaml.js";
import { FENCE_END, FENCE_START } from "../src/post/fence.js";
import { packetPost } from "../src/post/index.js";

const e2eEnabled = process.env.GH_E2E === "1";
const prNumber = Number.parseInt(process.env.GH_E2E_PR ?? "", 10);
const repo = process.env.GH_E2E_REPO ?? "";

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
      repository: repo,
      branch: "feat/x",
      base_branch: "main",
      pr_number: null,
      author: "trail-test@example.com",
    },
    task_intent: {
      source_type: "prompt",
      source_ref: "PROMPT-001",
      summary: "trail E2E test packet",
      acceptance_criteria: [],
    },
    agent_session: {
      tool: "claude-code",
      model: "claude-opus-4-7",
      models: ["claude-opus-4-7"],
      started_at: "2026-05-09T00:00:00.000+00:00",
      ended_at: "2026-05-09T00:01:00.000+00:00",
      session_id: "e2e-test-session",
      transcript_summary: [],
      prompts: { initial: "trail e2e test", followups: [] },
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
          description: "Wrote x.ts (e2e test)",
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
          text: "wrote x (e2e)",
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
  const dir = mkdtempSync(join(tmpdir(), "trail-e2e-"));
  const path = join(dir, "packet-1.yml");
  writeFileSync(path, dumpYaml(syntheticPacket()), "utf-8");
  return path;
}

describe.runIf(e2eEnabled && Number.isFinite(prNumber) && repo !== "")(
  "Phase 3b end-to-end against live PR",
  () => {
    test(`packetPost lands real PR-body update on ${repo}#${prNumber}`, async () => {
      const packetPath = writePacketFile();
      const result = await packetPost({
        packetPath,
        prNumber,
        yes: true,
        postedBy: "trail-e2e@test",
      });
      expect(result.exitCode).toBe(0);
      expect(result.bodyHash).toMatch(/^[a-f0-9]{64}$/);

      // Read the PR body via gh and verify the fence is present and
      // contains the rendered packet markdown.
      const apiOut = execSync(`gh api "repos/${repo}/pulls/${prNumber}" --jq .body`, {
        encoding: "utf-8",
      });
      expect(apiOut).toContain(FENCE_START);
      expect(apiOut).toContain(FENCE_END);
      expect(apiOut).toContain("Trail Packet");

      // Re-post: idempotent — fence count stays at 1.
      const result2 = await packetPost({
        packetPath,
        prNumber,
        yes: true,
        postedBy: "trail-e2e@test",
      });
      expect(result2.exitCode).toBe(0);
      const apiOut2 = execSync(`gh api "repos/${repo}/pulls/${prNumber}" --jq .body`, {
        encoding: "utf-8",
      });
      const startCount = (apiOut2.match(new RegExp(FENCE_START, "g")) ?? []).length;
      const endCount = (apiOut2.match(new RegExp(FENCE_END, "g")) ?? []).length;
      expect(startCount).toBe(1);
      expect(endCount).toBe(1);

      // Packet's posted_to_pr[] must have 2 entries now.
      const updated = loadYaml(readFileSync(packetPath, "utf-8")) as {
        posted_to_pr: unknown[];
      };
      expect(updated.posted_to_pr.length).toBe(2);
    }, 120_000);

    test(`packetDecide lands a comment + body refresh on ${repo}#${prNumber}`, async () => {
      const packetPath = writePacketFile();
      // First post once so the body has a fence.
      await packetPost({ packetPath, prNumber, yes: true, postedBy: "trail-e2e@test" });

      const result = await packetDecide({
        packetPath,
        prNumber,
        claim: "CLAIM-001",
        decision: "block",
        reason: "E2E test: this would be a security concern in production",
        by: "trail-e2e@test",
      });
      expect(result.exitCode).toBe(0);

      // approval_trail entry written
      const updated = loadYaml(readFileSync(packetPath, "utf-8")) as {
        approval_trail: Array<{ claim_id: string; decision: string }>;
      };
      expect(updated.approval_trail.length).toBeGreaterThanOrEqual(1);
      const last = updated.approval_trail[updated.approval_trail.length - 1];
      expect(last.claim_id).toBe("CLAIM-001");
      expect(last.decision).toBe("block");
    }, 180_000);
  }
);

// Note: when GH_E2E is unset, the describe.runIf block above does not run.
// vitest reports the cases as "skipped" in unit-test mode, which is the
// intended gating. (TR-1 cycle-1 review: the previous placeholder block
// here was dead weight — vitest's natural runIf(false) skip is sufficient.)
