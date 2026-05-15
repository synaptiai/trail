// Assemble the final Packet from extract data + claims + git state.
// Mirrors py-reference build_packet for byte-parity.

import type { ExtractData } from "../extract/extract.js";
import type { GitState } from "../git/state.js";
import type { Redactor } from "../redaction/layer1.js";
import { SCHEMA_URL, VERSION } from "../version.js";
import type { Claim, Packet, RedactionMetadata } from "./types.js";
import { generateUlid } from "./ulid.js";

const WS_RE = /\s+/g;

function sliceCp(s: string, n: number): string {
  if (s.length <= n) return s;
  let isAscii = true;
  for (let i = 0; i < s.length && i < n + 4; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      isAscii = false;
      break;
    }
  }
  if (isAscii) return s.slice(0, n);
  return [...s].slice(0, n).join("");
}

export interface BuildPacketInput {
  sessionId: string;
  data: ExtractData;
  redactor: Redactor;
  patternSetVersion: string;
  patternSetOrigin: "bundled" | "user-supplied";
  claims: Claim[];
  gitState?: GitState | undefined;
  parentPacketId: string | null;
  generatedAt?: string | undefined;
  packetId?: string | undefined;
}

export function buildPacket(input: BuildPacketInput): Packet {
  const {
    sessionId,
    data,
    redactor,
    patternSetVersion,
    patternSetOrigin,
    claims,
    gitState,
    parentPacketId,
    generatedAt,
    packetId,
  } = input;

  const initialPromptText = data.prompts[0]?.text ?? "";
  const summarySeed = sliceCp(initialPromptText.replace(WS_RE, " "), 200);
  const git = gitState;

  const sortedCounts: Record<string, number> = {};
  for (const k of Object.keys(redactor.counts).sort()) {
    sortedCounts[k] = redactor.counts[k]!;
  }

  const redactionMetadata: RedactionMetadata = {
    pattern_set_version: patternSetVersion,
    pattern_set_origin: patternSetOrigin,
    redactions_applied: redactor.total,
    redactions_by_pattern: sortedCounts,
    validation_errors: [],
    skipped_files: [],
  };

  // [F6 / 2026-05-09] Nullish coalescing instead of falsy. When git is
  // present and reports 0 files changed (e.g., fresh branch with no diff
  // against base_sha), `??` preserves the 0; the previous `?` form fell
  // through to the in-session count, breaking parity for zero-diff
  // sessions. py-reference uses git numstat verbatim including 0.
  const filesChangedCount = git?.files_changed_count ?? data.files_changed.length;

  return {
    packet_version: "0.1.1",
    _meta: {
      packet_id: packetId ?? generateUlid(),
      generated_at: generatedAt ?? new Date().toISOString(),
      generator: { name: "trail", version: VERSION },
      schema_url: SCHEMA_URL,
      capture_method: "post_hoc",
      parent_packet_id: parentPacketId,
    },
    pr: {
      provider: "github",
      repository: git?.repository ?? "",
      branch: git?.branch ?? "",
      base_branch: git?.base_branch ?? "",
      pr_number: null,
      author: git?.author ?? "",
    },
    task_intent: {
      source_type: "prompt",
      source_ref: data.prompts[0]?.id ?? "",
      summary: summarySeed,
      acceptance_criteria: [],
    },
    agent_session: {
      tool: "claude-code",
      model: data.model,
      models: data.models,
      started_at: data.started_at,
      ended_at: data.ended_at,
      session_id: sessionId,
      transcript_summary: [],
      prompts: {
        initial: initialPromptText,
        followups: data.prompts.slice(1).map((p) => p.text),
      },
      redaction_metadata: redactionMetadata,
    },
    diff_summary: {
      base_sha: git?.base_sha ?? "",
      head_sha: git?.head_sha ?? "",
      files_changed: filesChangedCount,
      lines_added: git?.lines_added ?? 0,
      lines_deleted: git?.lines_deleted ?? 0,
      modules_touched: data.modules_touched,
      semantic_changes: data.diffs.map((d) => ({
        id: d.id,
        description: d.description,
        files: d.files,
        operation: d.tool.toLowerCase() as "write" | "edit" | "multiedit",
        excerpts: d.excerpts,
      })),
    },
    commands_run: data.commands,
    test_evidence: {
      passed: data.tests.map((t) => ({ id: t.id, ref: t.ref, cmd_ref: t.cmd_ref })),
      failed: [],
      not_run: [],
    },
    provenance: {
      authorship: {
        ai_generated_estimate: "high",
        human_modified_estimate: "unknown",
        method: "post-hoc-transcript",
      },
      agent_touched_files: data.files_changed,
      human_touched_files: [],
    },
    summary: {
      claims,
      ungrounded_claim_count: claims.filter((c) => c.evidence_refs.length === 0).length,
    },
  };
}
