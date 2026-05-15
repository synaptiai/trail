// Packet shape for Trail v0.1.1.
// Mirrors `schema/pr-change-packet.v0.1.1.schema.json`. Manually authored to match
// the canonical fixture's emitted shape (which is the v0.1 base + v0.1.1 additive
// fields actually populated by py-reference). Optional v0.1.1 top-level fields
// (`approval_trail`, `posted_to_pr`, `redaction_audit`) are omitted from the emitted
// packet for byte parity — py-reference does not emit them in Phase 1, the schema
// does not require them, and emitting empty arrays would break byte-identity.

export interface RedactionValidationError {
  pattern: string;
  snippet: string;
}

export interface RedactionMetadata {
  pattern_set_version: string;
  pattern_set_origin?: "bundled" | "user-supplied";
  redactions_applied: number;
  redactions_by_pattern: Record<string, number>;
  validation_errors: RedactionValidationError[];
  skipped_files: string[];
}

export interface Excerpt {
  kind: string;
  text: string;
  elided: boolean;
}

export interface SemanticChange {
  id: string;
  description: string;
  files: [string];
  operation: "write" | "edit" | "multiedit";
  excerpts: Excerpt[];
}

export interface Command {
  id: string;
  command: string;
  exit_code: number;
  duration_ms: number;
  stdout_summary: string;
  stderr_summary: "";
}

export interface TestEntry {
  id: string;
  ref: string;
  cmd_ref?: string;
}

export interface RiskOverride {
  level: null;
  reason: null;
  at: null;
  by: null;
}

export interface ClaimRiskClassification {
  agent: { level: null; rationale: null };
  creator_override: RiskOverride;
  reviewer_override: RiskOverride;
}

export interface Claim {
  id: string;
  stable_id?: string;
  text: string;
  evidence_refs: string[];
  confidence: "supported" | "partial" | "ungrounded";
  synthesis_mode: "mechanical" | "llm";
  risk_classification?: ClaimRiskClassification;
}

// AB-2 (NEW v0.1.1). One row per successful post to a PR.
// body_hash is sha256 (full hex, deterministic) of the markdown that was posted.
// Phase 1 capture does NOT emit this field (parity-locked); Phase 3b appends.
export interface PostedToPrEntry {
  pr_url: string;
  pr_number: number;
  body_hash: string; // 64-char lowercase hex
  posted_at: string; // ISO 8601 with +00:00 suffix
  posted_by: string;
}

// AB-4 (NEW v0.1.1). One row per (claim_id, decision event).
// Phase 1 capture does NOT emit this field (parity-locked); Phase 3b appends
// (reviewer-side `trail packet decide`).
export interface ApprovalTrailEntry {
  claim_id: string; // CLAIM-NNN human form OR 16-hex stable_id
  decision: "accept" | "changes" | "block" | "reject";
  reason: string | null;
  by: string;
  at: string; // ISO 8601 with +00:00 suffix
}

export interface Packet {
  packet_version: "0.1.1";
  _meta: {
    packet_id: string;
    generated_at: string;
    generator: { name: "trail"; version: string };
    schema_url: string;
    capture_method: "post_hoc";
    parent_packet_id: string | null;
  };
  pr: {
    provider: "github";
    repository: string;
    branch: string;
    base_branch: string;
    pr_number: number | null;
    author: string;
  };
  task_intent: {
    source_type: "issue" | "prompt" | "manual" | "ticket" | "spec" | "";
    source_ref: string;
    summary: string;
    acceptance_criteria: string[];
  };
  agent_session: {
    tool: "claude-code";
    model: string;
    models: string[];
    started_at: string;
    ended_at: string;
    session_id: string;
    transcript_summary: string[];
    prompts: { initial: string; followups: string[] };
    redaction_metadata: RedactionMetadata;
  };
  diff_summary: {
    base_sha: string;
    head_sha: string;
    files_changed: number;
    lines_added: number;
    lines_deleted: number;
    modules_touched: string[];
    semantic_changes: SemanticChange[];
  };
  commands_run: Command[];
  test_evidence: {
    passed: TestEntry[];
    failed: TestEntry[];
    not_run: TestEntry[];
  };
  provenance: {
    authorship: {
      ai_generated_estimate: "high" | "medium" | "low" | "unknown";
      human_modified_estimate: "high" | "medium" | "low" | "unknown";
      method: "hook-tracked" | "heuristic" | "post-hoc-transcript" | "self-reported";
    };
    agent_touched_files: string[];
    human_touched_files: string[];
  };
  summary: {
    claims: Claim[];
    ungrounded_claim_count: number;
  };
  // Optional v0.1.1 top-level fields populated by Phase 3b (`trail packet
  // post` / `trail packet decide`). Phase 1 capture intentionally does NOT
  // emit these (parity-locked); Phase 3b appends to them.
  approval_trail?: ApprovalTrailEntry[];
  posted_to_pr?: PostedToPrEntry[];
}
