// Schema conformance tests (criterion 5 / spec §7).
// Run validation against a synthesized minimal packet, plus structural failure
// cases.

import { describe, expect, test } from "vitest";
import { synthesizeMechanical } from "../src/claims/mechanical.js";
import type { ExtractData } from "../src/extract/extract.js";
import { buildPacket } from "../src/packet/build.js";
import { validateRefs } from "../src/packet/validate-refs.js";
import { resetSchemaCache, validateStructural } from "../src/packet/validate-schema.js";
import { Redactor } from "../src/redaction/layer1.js";
import { loadPatterns } from "../src/redaction/patterns.js";

function fixtureExtractData(): ExtractData {
  return {
    prompts: [{ id: "PROMPT-001", text: "do thing" }],
    commands: [
      {
        id: "CMD-001",
        command: "npm test",
        exit_code: 0,
        duration_ms: 0,
        stdout_summary: "ok",
        stderr_summary: "",
      },
    ],
    tests: [{ id: "TEST-001", ref: "npm test", cmd_ref: "CMD-001" }],
    diffs: [
      {
        id: "DIFF-001",
        description: "Edited /repo/file.ts",
        files: ["/repo/file.ts"],
        tool: "Edit",
        excerpts: [
          { kind: "before", text: "old", elided: false },
          { kind: "after", text: "new", elided: false },
        ],
      },
    ],
    files_changed: ["/repo/file.ts"],
    modules_touched: ["repo"],
    started_at: "2026-05-01T10:00:00.000Z",
    ended_at: "2026-05-01T10:01:00.000Z",
    model: "claude-opus-4-7",
    models: ["claude-opus-4-7"],
    multiedit_dropped_hunks: 0,
    skipped_changes: 0,
  };
}

describe("Schema validation (Ajv structural pass)", () => {
  resetSchemaCache();
  const { version, patterns, origin } = loadPatterns(undefined, { useCache: false });
  const redactor = new Redactor(patterns);
  const data = fixtureExtractData();
  const claims = synthesizeMechanical(data, { perDiff: false, sessionId: "sess-001" });
  const packet = buildPacket({
    sessionId: "sess-001",
    data,
    redactor,
    patternSetVersion: version,
    patternSetOrigin: origin,
    claims,
    parentPacketId: null,
    packetId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    generatedAt: "2026-05-01T10:01:00.000+00:00",
  });

  test("clean packet passes structural validation", () => {
    const issues = validateStructural(packet);
    expect(issues).toEqual([]);
  });

  test("clean packet passes ref validation", () => {
    expect(validateRefs(packet)).toEqual([]);
  });

  test("missing required field fails structural pass", () => {
    const broken = JSON.parse(JSON.stringify(packet));
    broken._meta.packet_id = undefined;
    const issues = validateStructural(broken);
    expect(issues.length).toBeGreaterThan(0);
  });

  test("invalid ULID pattern fails", () => {
    const broken = JSON.parse(JSON.stringify(packet));
    broken._meta.packet_id = "not-a-ulid";
    const issues = validateStructural(broken);
    expect(issues.length).toBeGreaterThan(0);
  });

  test("started_at after ended_at flagged by ref pass", () => {
    const broken = JSON.parse(JSON.stringify(packet));
    broken.agent_session.started_at = "2026-05-02T10:00:00.000Z";
    broken.agent_session.ended_at = "2026-05-01T10:00:00.000Z";
    const issues = validateRefs(broken);
    expect(issues.find((i) => i.message.includes("started_at"))).toBeDefined();
  });

  test("unresolved evidence_ref flagged by ref pass", () => {
    const broken = JSON.parse(JSON.stringify(packet));
    broken.summary.claims[0].evidence_refs = ["DIFF-999"];
    const issues = validateRefs(broken);
    expect(issues.find((i) => i.message.includes("DIFF-999"))).toBeDefined();
  });

  test("duplicate DIFF IDs flagged", () => {
    const broken = JSON.parse(JSON.stringify(packet));
    broken.diff_summary.semantic_changes.push({ ...broken.diff_summary.semantic_changes[0] });
    const issues = validateRefs(broken);
    expect(issues.find((i) => i.message.includes("duplicate"))).toBeDefined();
  });

  test("[F6 / 2026-05-09] git.files_changed_count === 0 is preserved (not falsy-fallback)", () => {
    // Zero-diff sessions (fresh branch with no commits) MUST emit
    // files_changed: 0 from git numstat verbatim, not fall through to the
    // in-session count from `data.files_changed.length`.
    const localData = fixtureExtractData();
    // Force in-session files_changed to a non-zero value so the falsy form
    // would surface a divergence.
    localData.files_changed = ["/repo/file.ts", "/repo/other.ts"];
    const localPacket = buildPacket({
      sessionId: "sess-001",
      data: localData,
      redactor,
      patternSetVersion: version,
      patternSetOrigin: origin,
      claims,
      parentPacketId: null,
      packetId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      generatedAt: "2026-05-01T10:01:00.000+00:00",
      gitState: {
        repository: "owner/repo",
        branch: "feature/x",
        base_branch: "main",
        author: "alice",
        base_sha: "a".repeat(40),
        head_sha: "b".repeat(40),
        files_changed_count: 0, // <-- the load-bearing value
        lines_added: 0,
        lines_deleted: 0,
      },
    });
    expect(localPacket.diff_summary.files_changed).toBe(0);
  });

  test("[F6 / 2026-05-09] git.files_changed_count > 0 wins over in-session count", () => {
    const localData = fixtureExtractData();
    localData.files_changed = ["/repo/a.ts"];
    const localPacket = buildPacket({
      sessionId: "sess-001",
      data: localData,
      redactor,
      patternSetVersion: version,
      patternSetOrigin: origin,
      claims,
      parentPacketId: null,
      packetId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      generatedAt: "2026-05-01T10:01:00.000+00:00",
      gitState: {
        repository: "owner/repo",
        branch: "feature/x",
        base_branch: "main",
        author: "alice",
        base_sha: "a".repeat(40),
        head_sha: "b".repeat(40),
        files_changed_count: 7,
        lines_added: 42,
        lines_deleted: 3,
      },
    });
    expect(localPacket.diff_summary.files_changed).toBe(7);
  });

  test("[F6 / 2026-05-09] absent gitState falls back to in-session count", () => {
    const localData = fixtureExtractData();
    localData.files_changed = ["/repo/a.ts", "/repo/b.ts"];
    const localPacket = buildPacket({
      sessionId: "sess-001",
      data: localData,
      redactor,
      patternSetVersion: version,
      patternSetOrigin: origin,
      claims,
      parentPacketId: null,
      packetId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      generatedAt: "2026-05-01T10:01:00.000+00:00",
      // gitState undefined
    });
    expect(localPacket.diff_summary.files_changed).toBe(2);
  });

  // gh#4 AC-9: posted_to_pr[] entries match v0.1.1 schema.
  test("packet with posted_to_pr[] entries passes structural validation (AC-9)", () => {
    const withPosted = JSON.parse(JSON.stringify(packet)) as Record<string, unknown>;
    withPosted.posted_to_pr = [
      {
        pr_url: "https://github.com/owner/repo/pull/42",
        pr_number: 42,
        body_hash: "a".repeat(64),
        posted_at: "2026-05-09T03:05:20.148+00:00",
        posted_by: "alice@example.com",
      },
    ];
    const issues = validateStructural(withPosted as never);
    expect(issues).toEqual([]);
  });

  test("posted_to_pr entry with malformed body_hash fails structural validation", () => {
    const withPosted = JSON.parse(JSON.stringify(packet)) as Record<string, unknown>;
    withPosted.posted_to_pr = [
      {
        pr_url: "https://github.com/owner/repo/pull/42",
        pr_number: 42,
        body_hash: "not-hex",
        posted_at: "2026-05-09T03:05:20.148+00:00",
        posted_by: "alice@example.com",
      },
    ];
    const issues = validateStructural(withPosted as never);
    expect(issues.length).toBeGreaterThan(0);
  });

  // gh#4 AC-6: approval_trail[] entries pass schema validation.
  test("packet with approval_trail[] entries passes structural validation", () => {
    const withTrail = JSON.parse(JSON.stringify(packet)) as Record<string, unknown>;
    withTrail.approval_trail = [
      {
        claim_id: "CLAIM-001",
        decision: "block",
        reason: "needs review",
        by: "alice@example.com",
        at: "2026-05-09T03:05:20.148+00:00",
      },
    ];
    const issues = validateStructural(withTrail as never);
    expect(issues).toEqual([]);
  });

  test("approval_trail entry with invalid decision enum fails", () => {
    const withTrail = JSON.parse(JSON.stringify(packet)) as Record<string, unknown>;
    withTrail.approval_trail = [
      {
        claim_id: "CLAIM-001",
        decision: "approve", // not in enum
        reason: null,
        by: "alice",
        at: "2026-05-09T03:05:20.148+00:00",
      },
    ];
    const issues = validateStructural(withTrail as never);
    expect(issues.length).toBeGreaterThan(0);
  });
});
