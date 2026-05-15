import { describe, expect, it } from 'vitest';
import { parsePacketYaml } from '@/services/packet-loader';

/**
 * Sprint 3b — packet-loader diff_summary + redaction_summary projections.
 *
 * Pinned contracts:
 *   1. diff_summary survives the parse + Ajv validate pipeline with all
 *      fields preserved (semantic_changes ids, file paths, operations,
 *      excerpt kinds + elided flag).
 *   2. redaction_summary.by_pattern is sorted alphabetically (UI-stable).
 *   3. redaction_metadata.validation_errors normalize to a flat string[]
 *      regardless of object-shape vs string-shape upstream.
 *   4. Empty diff_summary / empty by_pattern parse without throwing.
 */

const MINIMAL_YAML = (overrides?: { semantic_changes?: string; redactions_by_pattern?: string }) => `
packet_version: 0.1.1
_meta:
  packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
  generated_at: '2026-05-09T12:00:00.000+00:00'
  generator: { name: trail, version: 0.1.0-dev }
  schema_url: schema/pr-change-packet.v0.1.1.yml
  capture_method: post_hoc
  parent_packet_id: null
pr:
  provider: github
  repository: synaptiai/trail
  branch: main
  base_branch: origin/main
  pr_number: null
  author: t@e.com
task_intent: { source_type: prompt, source_ref: PROMPT-001, summary: x, acceptance_criteria: [] }
agent_session:
  tool: claude-code
  model: m
  models: [m]
  started_at: '2026-05-09T11:00:00.000+00:00'
  ended_at: '2026-05-09T11:30:00.000+00:00'
  session_id: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
  transcript_summary: []
  prompts: { initial: x, followups: [] }
  redaction_metadata:
    pattern_set_version: 0.1.3
    pattern_set_origin: bundled
    redactions_applied: 5
    redactions_by_pattern:${overrides?.redactions_by_pattern ?? `
      slack-token: 1
      generic-32hex: 2
      aws-access-key: 2`}
    validation_errors: []
    skipped_files: []
diff_summary:
  base_sha: '0000000000000000000000000000000000000000'
  head_sha: '1111111111111111111111111111111111111111'
  files_changed: 2
  lines_added: 10
  lines_deleted: 3
  modules_touched: [src, tests]
  semantic_changes:${overrides?.semantic_changes ?? `
    - id: DIFF-001
      description: Wrote src/foo.ts (200 chars)
      files: [src/foo.ts]
      operation: write
      excerpts:
        - kind: after
          text: "export const x = 1;"
          elided: false
    - id: DIFF-002
      description: Edited tests/foo.test.ts
      files: [tests/foo.test.ts]
      operation: edit
      excerpts:
        - kind: before
          text: "old line"
          elided: false
        - kind: after
          text: "new line"
          elided: false`}
commands_run: []
test_evidence: { passed: [], failed: [], not_run: [] }
provenance:
  authorship: { ai_generated_estimate: high, human_modified_estimate: low, method: post-hoc-transcript }
  agent_touched_files: []
  human_touched_files: []
summary:
  claims:
  - id: CLAIM-001
    text: x
    evidence_refs: [DIFF-001]
    confidence: supported
    synthesis_mode: mechanical
  ungrounded_claim_count: 0
`;

describe('parsePacketYaml — diff_summary projection (Sprint 3b)', () => {
  it('projects all semantic_changes fields verbatim', () => {
    const packet = parsePacketYaml(MINIMAL_YAML(), '/test/p.yml');
    expect(packet.diff_summary.files_changed).toBe(2);
    expect(packet.diff_summary.lines_added).toBe(10);
    expect(packet.diff_summary.lines_deleted).toBe(3);
    expect(packet.diff_summary.modules_touched).toEqual(['src', 'tests']);
    expect(packet.diff_summary.semantic_changes).toHaveLength(2);
    expect(packet.diff_summary.semantic_changes[0]).toEqual({
      id: 'DIFF-001',
      description: 'Wrote src/foo.ts (200 chars)',
      files: ['src/foo.ts'],
      operation: 'write',
      excerpts: [{ kind: 'after', text: 'export const x = 1;', elided: false }],
    });
    expect(packet.diff_summary.semantic_changes[1]!.excerpts).toHaveLength(2);
    expect(packet.diff_summary.semantic_changes[1]!.excerpts[0]!.kind).toBe('before');
    expect(packet.diff_summary.semantic_changes[1]!.excerpts[1]!.kind).toBe('after');
  });

  it('handles empty semantic_changes', () => {
    const packet = parsePacketYaml(MINIMAL_YAML({ semantic_changes: ' []' }), '/test/p.yml');
    expect(packet.diff_summary.semantic_changes).toHaveLength(0);
  });

  it('preserves elided flag for clipped excerpts', () => {
    const yaml = MINIMAL_YAML({
      semantic_changes: `
    - id: DIFF-001
      description: Wrote src/big.ts
      files: [src/big.ts]
      operation: write
      excerpts:
        - kind: after
          text: "head ...elided... tail"
          elided: true`,
    });
    const packet = parsePacketYaml(yaml, '/test/p.yml');
    expect(packet.diff_summary.semantic_changes[0]!.excerpts[0]!.elided).toBe(true);
  });
});

describe('parsePacketYaml — redaction_summary projection (Sprint 3b)', () => {
  it('sorts by_pattern alphabetically by pattern_name', () => {
    const packet = parsePacketYaml(MINIMAL_YAML(), '/test/p.yml');
    expect(packet.redaction_summary.by_pattern.map((r) => r.pattern_name)).toEqual([
      'aws-access-key',
      'generic-32hex',
      'slack-token',
    ]);
    expect(packet.redaction_summary.by_pattern).toEqual([
      { pattern_name: 'aws-access-key', count: 2 },
      { pattern_name: 'generic-32hex', count: 2 },
      { pattern_name: 'slack-token', count: 1 },
    ]);
  });

  it('preserves redactions_applied + pattern_set_version + pattern_set_origin', () => {
    const packet = parsePacketYaml(MINIMAL_YAML(), '/test/p.yml');
    expect(packet.redaction_summary.redactions_applied).toBe(5);
    expect(packet.redaction_summary.pattern_set_version).toBe('0.1.3');
    expect(packet.redaction_summary.pattern_set_origin).toBe('bundled');
  });

  it('handles empty redactions_by_pattern', () => {
    const packet = parsePacketYaml(MINIMAL_YAML({ redactions_by_pattern: ' {}' }), '/test/p.yml');
    expect(packet.redaction_summary.by_pattern).toEqual([]);
  });

  it('projects validation_errors to "{pattern} matched (sha256:{snippet})" — never raw match', () => {
    // Cycle-1 self-review F1 — earlier loader code mis-typed
    // validation_errors as `{message, pattern_id}`, which would never
    // produce useful output from real data. The schema's actual shape
    // is `{ pattern, snippet }` where snippet is sha256(match)[:8].
    //
    // We feed a packet through parsePacketYaml with two synthesised
    // validation_errors and assert the projected strings.
    const yamlWithErrors = `
packet_version: 0.1.1
_meta:
  packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
  generated_at: '2026-05-09T12:00:00.000+00:00'
  generator: { name: trail, version: 0.1.0-dev }
  schema_url: schema/pr-change-packet.v0.1.1.yml
  capture_method: post_hoc
  parent_packet_id: null
pr:
  provider: github
  repository: synaptiai/trail
  branch: main
  base_branch: origin/main
  pr_number: null
  author: t@e.com
task_intent: { source_type: prompt, source_ref: PROMPT-001, summary: x, acceptance_criteria: [] }
agent_session:
  tool: claude-code
  model: m
  models: [m]
  started_at: '2026-05-09T11:00:00.000+00:00'
  ended_at: '2026-05-09T11:30:00.000+00:00'
  session_id: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
  transcript_summary: []
  prompts: { initial: x, followups: [] }
  redaction_metadata:
    pattern_set_version: 0.1.3
    redactions_applied: 2
    redactions_by_pattern: { slack-token: 1, generic-32hex: 1 }
    validation_errors:
      - pattern: slack-token
        snippet: deadbeef
      - pattern: generic-32hex
        snippet: cafebabe
    skipped_files: []
diff_summary:
  base_sha: '0000000000000000000000000000000000000000'
  head_sha: '1111111111111111111111111111111111111111'
  files_changed: 0
  lines_added: 0
  lines_deleted: 0
  modules_touched: []
  semantic_changes: []
commands_run: []
test_evidence: { passed: [], failed: [], not_run: [] }
provenance:
  authorship: { ai_generated_estimate: high, human_modified_estimate: low, method: post-hoc-transcript }
  agent_touched_files: []
  human_touched_files: []
summary:
  claims:
  - id: CLAIM-001
    text: x
    evidence_refs: [DIFF-001]
    confidence: supported
    synthesis_mode: mechanical
  ungrounded_claim_count: 0
`;
    const packet = parsePacketYaml(yamlWithErrors, '/test/p.yml');
    expect(packet.redaction_summary.validation_errors).toEqual([
      'slack-token matched (sha256:deadbeef)',
      'generic-32hex matched (sha256:cafebabe)',
    ]);
    // Strict privacy gate: the projected string MUST NOT contain the
    // word "match" followed by anything looking like a raw token. Our
    // format only ever surfaces `pattern` (the rule name) and `snippet`
    // (8 hex chars, a hash prefix). Any attempt to evolve the format
    // to surface `text` or `match` would be a privacy regression.
    for (const e of packet.redaction_summary.validation_errors) {
      // 8 hex chars (sha256 prefix) is the only "secret-shaped" token
      // permitted; longer hex strings would hint at raw secret leak.
      const hexMatches = e.match(/[a-f0-9]{16,}/gi);
      expect(
        hexMatches,
        `validation_errors entry "${e}" contains a long hex token (>=16 chars) — possible raw-match leak`,
      ).toBeNull();
    }
  });
});
