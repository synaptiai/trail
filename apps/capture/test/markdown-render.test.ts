// Markdown render unit tests (Appendix C).

import { describe, expect, test } from "vitest";
import type { Claim, Packet } from "../src/packet/types.js";
import { renderMarkdown, renderMarkdownSummary } from "../src/render/markdown.js";

function basePacket(): Packet {
  return {
    packet_version: "0.1.1",
    _meta: {
      packet_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      generated_at: "2026-05-09T10:00:00.000+00:00",
      generator: { name: "trail", version: "0.1.0-dev" },
      schema_url: "schema/pr-change-packet.v0.1.1.yml",
      capture_method: "post_hoc",
      parent_packet_id: null,
    },
    pr: {
      provider: "github",
      repository: "owner/repo",
      branch: "main",
      base_branch: "origin/main",
      pr_number: null,
      author: "x@y.com",
    },
    task_intent: {
      source_type: "prompt",
      source_ref: "PROMPT-001",
      summary: "do thing",
      acceptance_criteria: [],
    },
    agent_session: {
      tool: "claude-code",
      model: "haiku",
      models: ["haiku"],
      started_at: "2026-05-09T09:00:00.000+00:00",
      ended_at: "2026-05-09T10:00:00.000+00:00",
      session_id: "abcd1234efgh",
      transcript_summary: [],
      prompts: { initial: "do thing", followups: [] },
      redaction_metadata: {
        pattern_set_version: "0.1.2",
        pattern_set_origin: "bundled",
        redactions_applied: 0,
        redactions_by_pattern: {},
        validation_errors: [],
        skipped_files: [],
      },
    },
    diff_summary: {
      base_sha: "",
      head_sha: "",
      files_changed: 1,
      lines_added: 0,
      lines_deleted: 0,
      modules_touched: ["repo"],
      semantic_changes: [
        {
          id: "DIFF-001",
          description: "Edited /repo/x.ts",
          files: ["/repo/x.ts"],
          operation: "edit",
          excerpts: [
            { kind: "before", text: "old", elided: false },
            { kind: "after", text: "new", elided: false },
          ],
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
      agent_touched_files: ["/repo/x.ts"],
      human_touched_files: [],
    },
    summary: {
      claims: [
        {
          id: "CLAIM-001",
          stable_id: "0123456789abcdef",
          text: "edit on /repo/x.ts (1 change(s))",
          evidence_refs: ["DIFF-001"],
          confidence: "supported",
          synthesis_mode: "mechanical",
        },
      ],
      ungrounded_claim_count: 0,
    },
  };
}

describe("renderMarkdown", () => {
  test("renders title with first 8 chars of session_id", () => {
    const md = renderMarkdown(basePacket(), { packetPath: "/tmp/p.yml" });
    expect(md.split("\n")[0]).toBe("# Trail Packet — `abcd1234`");
  });

  test("renders excerpt fences with - marker for before, + marker for after", () => {
    const md = renderMarkdown(basePacket(), { packetPath: "/tmp/p.yml" });
    expect(md).toContain("− before");
    expect(md).toContain("+ after");
  });

  test("renders prompt anchor", () => {
    const md = renderMarkdown(basePacket(), { packetPath: "/tmp/p.yml" });
    expect(md).toContain("<a id='prompt-001'></a>");
  });

  test("renders Layer 2 warning when validation_errors non-empty", () => {
    const p = basePacket();
    p.agent_session.redaction_metadata.validation_errors = [
      { pattern: "github-token", snippet: "deadbeef" },
    ];
    const md = renderMarkdown(p, { packetPath: "/tmp/p.yml" });
    expect(md).toContain("⚠ Redaction Layer 2 reported issues");
    expect(md).toContain("github-token");
    expect(md).toContain("deadbeef");
  });

  test("renders unresolved evidence_ref placeholder", () => {
    const p = basePacket();
    p.summary.claims[0]!.evidence_refs = ["DIFF-999"];
    const md = renderMarkdown(p, { packetPath: "/tmp/p.yml" });
    expect(md).toContain("**DIFF-999** _(unresolved)_");
  });

  // CR-1 / AC-6 (gh#4): approval_trail must surface in the rendered markdown
  // so the PR-body fence reflects decision state after `trail packet decide`.
  test("does NOT render Approval Trail section when approval_trail is missing", () => {
    const md = renderMarkdown(basePacket(), { packetPath: "/tmp/p.yml" });
    expect(md).not.toContain("## Approval Trail");
  });

  test("does NOT render Approval Trail section when approval_trail is empty", () => {
    const p = basePacket();
    p.approval_trail = [];
    const md = renderMarkdown(p, { packetPath: "/tmp/p.yml" });
    expect(md).not.toContain("## Approval Trail");
  });

  test("renders Approval Trail table when approval_trail has entries", () => {
    const p = basePacket();
    p.approval_trail = [
      {
        claim_id: "CLAIM-001",
        decision: "block",
        reason: "needs security review",
        by: "alice@example.com",
        at: "2026-05-09T03:05:20.148+00:00",
      },
      {
        claim_id: "CLAIM-002",
        decision: "accept",
        reason: null,
        by: "bob@example.com",
        at: "2026-05-09T03:10:00.000+00:00",
      },
    ];
    const md = renderMarkdown(p, { packetPath: "/tmp/p.yml" });
    expect(md).toContain("## Approval Trail");
    expect(md).toContain("`CLAIM-001`");
    expect(md).toContain("`CLAIM-002`");
    expect(md).toContain("🛑 block");
    expect(md).toContain("✅ accept");
    expect(md).toContain("alice@example.com");
    expect(md).toContain("bob@example.com");
    expect(md).toContain("needs security review");
    expect(md).toContain("2 decisions recorded");
    // Null reason renders as em-dash placeholder
    const lines = md.split("\n");
    const bobRow = lines.find((l) => l.includes("CLAIM-002"));
    expect(bobRow).toBeDefined();
    expect(bobRow).toContain("| — |");
  });

  test("renders Approval Trail singular wording for one entry", () => {
    const p = basePacket();
    p.approval_trail = [
      {
        claim_id: "CLAIM-001",
        decision: "accept",
        reason: null,
        by: "x@y.com",
        at: "2026-05-09T03:05:20.148+00:00",
      },
    ];
    const md = renderMarkdown(p, { packetPath: "/tmp/p.yml" });
    expect(md).toContain("1 decision recorded");
  });

  test("Approval Trail row escapes pipes in reason text", () => {
    const p = basePacket();
    p.approval_trail = [
      {
        claim_id: "CLAIM-001",
        decision: "changes",
        reason: "fix a|b parsing",
        by: "x@y.com",
        at: "2026-05-09T03:05:20.148+00:00",
      },
    ];
    const md = renderMarkdown(p, { packetPath: "/tmp/p.yml" });
    expect(md).toContain("fix a\\|b parsing");
  });

  test("Approval Trail row escapes pipes in by + at fields (NEW-1 cycle-2)", () => {
    const p = basePacket();
    p.approval_trail = [
      {
        claim_id: "CLAIM-001",
        decision: "accept",
        reason: null,
        by: "ops|reviewer@y.com",
        at: "2026-05-09T03:05:20.148+00:00|alt-format",
      },
    ];
    const md = renderMarkdown(p, { packetPath: "/tmp/p.yml" });
    expect(md).toContain("ops\\|reviewer@y.com");
    expect(md).toContain("2026-05-09T03:05:20.148+00:00\\|alt-format");
    expect(md).not.toMatch(/\| ops\|reviewer/);
  });
});

// rc.6 / DOGFOOD-2 regression suite. The summary render replaces the full
// inline-diff render in the PR-body path (`packet post`, `packet decide`
// body-refresh). It must:
//   1. Produce a body well under GitHub's ~65 KB PR-body limit even for
//      thousand-claim packets.
//   2. NOT inline diff excerpts (the bloat source — ~5 KB/claim in the full
//      render).
//   3. Surface essentials: packet ID, claim count, redaction summary,
//      task intent, approval trail.
//   4. Prioritize claims with recorded decisions in the capped table.
describe("renderMarkdownSummary (rc.6 PR-body render)", () => {
  function manyClaims(n: number): Claim[] {
    const claims: Claim[] = [];
    for (let i = 1; i <= n; i++) {
      claims.push({
        id: `CLAIM-${i.toString().padStart(3, "0")}`,
        stable_id: i.toString(16).padStart(16, "0"),
        text: `synthetic claim ${i} — exercising the summary render bloat profile`,
        evidence_refs: [`DIFF-${i.toString().padStart(3, "0")}`],
        confidence: "supported",
        synthesis_mode: "mechanical",
      });
    }
    return claims;
  }

  test("excludes inline diff excerpts (bloat source — was the rc.4/5 bug)", () => {
    const md = renderMarkdownSummary(basePacket(), { packetPath: "/tmp/p.yml" });
    // The full render emits "+ after" / "− before" markers for each diff
    // excerpt; the summary must not.
    expect(md).not.toContain("+ after");
    expect(md).not.toContain("− before");
    // Likewise no fenced code blocks holding diff content.
    expect(md).not.toMatch(/```typescript/);
  });

  test("surfaces packet ID, claim count, and link to full packet", () => {
    const md = renderMarkdownSummary(basePacket(), {
      packetPath: "/repo/.trail/sessions/abcd/packet-1.yml",
    });
    expect(md).toContain("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(md).toContain("1 total");
    expect(md).toContain("0 ungrounded");
    // Footer links to both yaml + md form of the local packet.
    expect(md).toContain("/repo/.trail/sessions/abcd/packet-1.yml");
    expect(md).toContain("/repo/.trail/sessions/abcd/packet-1.md");
  });

  test("fits under 50 KB even for 1000-claim packets", () => {
    const p = basePacket();
    p.summary.claims = manyClaims(1000);
    p.summary.ungrounded_claim_count = 0;
    const md = renderMarkdownSummary(p, { packetPath: "/tmp/p.yml" });
    expect(md.length).toBeLessThan(50_000);
    // The truncation footer documents that more claims exist.
    expect(md).toMatch(/…and \d+ more claim\(s\)/);
  });

  test("prioritizes claims with approval_trail decisions in the capped table", () => {
    const p = basePacket();
    p.summary.claims = manyClaims(100);
    p.summary.ungrounded_claim_count = 0;
    // Record a decision on the LAST claim (CLAIM-100) — which would
    // otherwise be cut by the cap.
    p.approval_trail = [
      {
        claim_id: "CLAIM-100",
        decision: "accept",
        reason: null,
        by: "x@y.com",
        at: "2026-05-09T03:05:20.148+00:00",
      },
    ];
    const md = renderMarkdownSummary(p, { packetPath: "/tmp/p.yml" });
    // CLAIM-100 must appear in the table despite being claim #100 in
    // appearance order (cap is 50).
    expect(md).toContain("`CLAIM-100`");
  });

  test("renders status column with decision label when claim has approval entry", () => {
    const p = basePacket();
    p.approval_trail = [
      {
        claim_id: "CLAIM-001",
        decision: "reject",
        reason: "out of scope",
        by: "x@y.com",
        at: "2026-05-09T03:05:20.148+00:00",
      },
    ];
    const md = renderMarkdownSummary(p, { packetPath: "/tmp/p.yml" });
    // Table row for CLAIM-001 should contain the decision label.
    const lines = md.split("\n");
    const claimRow = lines.find((l) => l.includes("`CLAIM-001`") && l.includes("|"));
    expect(claimRow).toBeDefined();
    expect(claimRow).toContain("❌ reject");
  });

  test("falls back to em-dash status for undecided claims", () => {
    const md = renderMarkdownSummary(basePacket(), { packetPath: "/tmp/p.yml" });
    const lines = md.split("\n");
    const claimRow = lines.find((l) => l.includes("`CLAIM-001`") && l.includes("|"));
    expect(claimRow).toBeDefined();
    expect(claimRow).toContain("| — |");
  });

  test("truncates long claim text but preserves CLAIM id and evidence count", () => {
    const p = basePacket();
    p.summary.claims[0]!.text = "x".repeat(500);
    const md = renderMarkdownSummary(p, { packetPath: "/tmp/p.yml" });
    expect(md).toContain("`CLAIM-001`");
    expect(md).toContain("1 ref(s)");
    // Truncated to ~120 chars, then ellipsis. The full 500-x string must
    // NOT appear.
    expect(md).not.toContain("x".repeat(500));
    expect(md).toContain("…");
  });

  test("surfaces empty-claims-list case cleanly without a table", () => {
    const p = basePacket();
    p.summary.claims = [];
    const md = renderMarkdownSummary(p, { packetPath: "/tmp/p.yml" });
    expect(md).toContain("0 total");
    expect(md).toContain("No claims recorded");
    expect(md).not.toContain("| Claim | Text |");
  });

  test("emits approval trail table even when claims table is capped", () => {
    const p = basePacket();
    p.summary.claims = manyClaims(500);
    p.approval_trail = [
      {
        claim_id: "CLAIM-499",
        decision: "block",
        reason: "needs design review",
        by: "alice@example.com",
        at: "2026-05-09T03:05:20.148+00:00",
      },
    ];
    const md = renderMarkdownSummary(p, { packetPath: "/tmp/p.yml" });
    expect(md).toContain("## Approval Trail");
    expect(md).toContain("alice@example.com");
    expect(md).toContain("needs design review");
  });
});
