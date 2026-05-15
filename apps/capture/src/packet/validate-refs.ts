// Cross-reference validation pass — pure TS. Spec §7 pass 2.
// Verifies every claim's evidence_ref resolves to an existing ID in the packet.

import type { Packet } from "./types.js";
import type { ValidationIssue } from "./validate-schema.js";

export function validateRefs(packet: Packet): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const diffIds = new Set(packet.diff_summary.semantic_changes.map((d) => d.id));
  const cmdIds = new Set(packet.commands_run.map((c) => c.id));
  const testIds = new Set(packet.test_evidence.passed.map((t) => t.id));
  const promptIds = new Set<string>();
  if (packet.task_intent.source_ref?.startsWith("PROMPT-")) {
    promptIds.add(packet.task_intent.source_ref);
  }

  for (let i = 0; i < packet.summary.claims.length; i++) {
    const claim = packet.summary.claims[i]!;
    if (claim.evidence_refs.length === 0) {
      issues.push({
        kind: "refs",
        path: `/summary/claims/${i}`,
        message: `claim ${claim.id} has empty evidence_refs`,
      });
    }
    for (const ref of claim.evidence_refs) {
      let ok = false;
      let section: string;
      if (ref.startsWith("DIFF-")) {
        ok = diffIds.has(ref);
        section = "diff_summary.semantic_changes";
      } else if (ref.startsWith("CMD-")) {
        ok = cmdIds.has(ref);
        section = "commands_run";
      } else if (ref.startsWith("TEST-")) {
        ok = testIds.has(ref);
        section = "test_evidence.passed";
      } else if (ref.startsWith("PROMPT-")) {
        ok = promptIds.has(ref);
        section = "task_intent.source_ref";
      } else {
        section = "unknown";
      }
      if (!ok) {
        issues.push({
          kind: "refs",
          path: `/summary/claims/${i}/evidence_refs`,
          message: `${ref} not found in ${section}`,
        });
      }
    }
  }

  // ID uniqueness checks.
  checkUnique(
    diffIds.size,
    packet.diff_summary.semantic_changes.length,
    "diff_summary.semantic_changes",
    issues
  );
  checkUnique(cmdIds.size, packet.commands_run.length, "commands_run", issues);
  checkUnique(testIds.size, packet.test_evidence.passed.length, "test_evidence.passed", issues);

  // started_at <= ended_at (Date parse, not lex).
  if (packet.agent_session.started_at && packet.agent_session.ended_at) {
    const s = Date.parse(packet.agent_session.started_at);
    const e = Date.parse(packet.agent_session.ended_at);
    if (Number.isFinite(s) && Number.isFinite(e) && s > e) {
      issues.push({
        kind: "refs",
        path: "/agent_session",
        message: `started_at (${packet.agent_session.started_at}) is after ended_at (${packet.agent_session.ended_at})`,
      });
    }
  }

  // At least one of (semantic_changes, commands_run, test_evidence) non-empty.
  const anyWork =
    packet.diff_summary.semantic_changes.length > 0 ||
    packet.commands_run.length > 0 ||
    packet.test_evidence.passed.length > 0 ||
    packet.test_evidence.failed.length > 0 ||
    packet.test_evidence.not_run.length > 0;
  if (!anyWork) {
    issues.push({
      kind: "refs",
      path: "/",
      message:
        "packet records no observed work (all of semantic_changes, commands_run, test_evidence are empty)",
    });
  }

  // pattern_set_version non-empty.
  if (!packet.agent_session.redaction_metadata.pattern_set_version) {
    issues.push({
      kind: "refs",
      path: "/agent_session/redaction_metadata/pattern_set_version",
      message: "pattern_set_version must be non-empty",
    });
  }

  return issues;
}

function checkUnique(
  unique: number,
  total: number,
  section: string,
  issues: ValidationIssue[]
): void {
  if (unique !== total) {
    issues.push({
      kind: "refs",
      path: `/${section.replace(/\./g, "/")}`,
      message: `${section} contains duplicate IDs (${total} entries, ${unique} unique)`,
    });
  }
}
