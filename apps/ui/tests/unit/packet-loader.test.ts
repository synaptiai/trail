/**
 * packet-loader — exercises the real Ajv compilation + js-yaml parse + shape
 * extraction. Per gh#9 criterion 10 ("no mocks/stubs/placeholders"), the
 * tests load:
 *   1. A hand-built minimal valid v0.1.1 packet (rendered as YAML inline) so
 *      the assertion surface is independent of the canonical fixture's
 *      shifting content.
 *   2. The canonical fixture from py-reference (real 700KB YAML emitted by
 *      Phase 1 / py-reference parity) — an end-to-end smoke that the
 *      parser + validator survive a real packet without throwing.
 *
 * N15 lesson: tests verify the actual contract (effective risk priority,
 * histogram counts, parent_packet_id presence drives RecaptureBanner
 * visibility downstream), not just "the function returned an object".
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePacketYaml,
  effectiveRiskLevel,
  PacketLoadException,
} from '@/services/packet-loader';

// ---------------------------------------------------------------------------
// Hand-built minimal valid v0.1.1 packet — exercises every Sprint 3a code
// path: parent_packet_id present, risk_classification overrides cascade,
// approval_trail entries with reasons, multiple claims with mixed risk.
// ---------------------------------------------------------------------------
const MINIMAL_PACKET_YAML = `
packet_version: 0.1.1
_meta:
  packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
  generated_at: '2026-05-09T12:00:00.000+00:00'
  generator:
    name: trail
    version: 0.1.0-dev
  schema_url: schema/pr-change-packet.v0.1.1.yml
  capture_method: post_hoc
  parent_packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAW
pr:
  provider: github
  repository: synaptiai/trail
  branch: feature/test
  base_branch: origin/main
  pr_number: null
  author: test@example.com
task_intent:
  source_type: prompt
  source_ref: PROMPT-001
  summary: minimal packet for unit tests
  acceptance_criteria: []
agent_session:
  tool: claude-code
  model: claude-opus-4-7
  models:
  - claude-opus-4-7
  started_at: '2026-05-09T11:00:00.000+00:00'
  ended_at: '2026-05-09T11:30:00.000+00:00'
  session_id: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
  transcript_summary: []
  prompts:
    initial: 'test'
    followups: []
  redaction_metadata:
    pattern_set_version: 0.1.3
    redactions_applied: 0
    redactions_by_pattern: {}
    validation_errors: []
    skipped_files: []
diff_summary:
  base_sha: '0000000000000000000000000000000000000000'
  head_sha: '1111111111111111111111111111111111111111'
  files_changed: 1
  lines_added: 1
  lines_deleted: 0
  modules_touched: []
  semantic_changes:
  - id: DIFF-001
    description: Wrote /tmp/test.ts (10 chars)
    files: ['/tmp/test.ts']
    operation: write
    excerpts: []
commands_run: []
test_evidence:
  passed: []
  failed: []
  not_run: []
provenance:
  authorship:
    ai_generated_estimate: high
    human_modified_estimate: low
    method: post-hoc-transcript
  agent_touched_files:
  - /tmp/test.ts
  human_touched_files: []
summary:
  claims:
  - id: CLAIM-001
    stable_id: aaaaaaaaaaaaaaaa
    text: low-risk claim, agent classification only
    evidence_refs:
    - DIFF-001
    confidence: supported
    synthesis_mode: mechanical
    risk_classification:
      agent: { level: low, rationale: trivial }
      creator_override: { level: null, reason: null, at: null, by: null }
      reviewer_override: { level: null, reason: null, at: null, by: null }
  - id: CLAIM-002
    stable_id: bbbbbbbbbbbbbbbb
    text: med-risk claim, creator override active
    evidence_refs:
    - DIFF-001
    confidence: supported
    synthesis_mode: mechanical
    risk_classification:
      agent: { level: low, rationale: looked-low }
      creator_override:
        level: med
        reason: actually security-relevant
        at: '2026-05-09T11:35:00.000+00:00'
        by: daniel
      reviewer_override: { level: null, reason: null, at: null, by: null }
  - id: CLAIM-003
    stable_id: cccccccccccccccc
    text: crit-risk claim, reviewer override wins over creator
    evidence_refs:
    - DIFF-001
    confidence: supported
    synthesis_mode: mechanical
    risk_classification:
      agent: { level: low, rationale: looked-low }
      creator_override:
        level: high
        reason: looks like auth bypass
        at: '2026-05-09T11:36:00.000+00:00'
        by: daniel
      reviewer_override:
        level: crit
        reason: confirmed auth bypass
        at: '2026-05-09T11:40:00.000+00:00'
        by: reviewer-A
  - id: CLAIM-004
    stable_id: dddddddddddddddd
    text: unclassified claim — no risk_classification block
    evidence_refs:
    - DIFF-001
    confidence: supported
    synthesis_mode: mechanical
  ungrounded_claim_count: 0
approval_trail:
- claim_id: CLAIM-001
  decision: accept
  reason: looks fine
  by: daniel
  at: '2026-05-09T11:50:00.000+00:00'
- claim_id: cccccccccccccccc
  decision: reject
  reason: 'cannot ship with auth bypass'
  by: reviewer-A
  at: '2026-05-09T11:51:00.000+00:00'
`;

describe('parsePacketYaml — minimal hand-built v0.1.1 packet', () => {
  it('parses + validates without throwing', () => {
    const loaded = parsePacketYaml(MINIMAL_PACKET_YAML, '/test/minimal.yml');
    expect(loaded).toBeDefined();
    expect(loaded.source_path).toBe('/test/minimal.yml');
  });

  it('extracts the header with packet_id, session_id, generator, parent_packet_id, is_recapture', () => {
    const loaded = parsePacketYaml(MINIMAL_PACKET_YAML, '/test/minimal.yml');
    expect(loaded.header.packet_id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(loaded.header.session_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(loaded.header.generated_at).toBe('2026-05-09T12:00:00.000+00:00');
    expect(loaded.header.generator_name).toBe('trail');
    expect(loaded.header.generator_version).toBe('0.1.0-dev');
    expect(loaded.header.schema_version).toBe('0.1.1');
    expect(loaded.header.parent_packet_id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAW');
    // Cycle-1 P1: parent_packet_id present → is_recapture true,
    // packet_n null (chain depth unknown until Sprint 4 walks the chain;
    // fabricating packet_n=2 was a factual error since the actual position
    // could be packet-5 in a deeper chain).
    expect(loaded.header.is_recapture).toBe(true);
    expect(loaded.header.packet_n).toBeNull();
    expect(loaded.header.repository).toBe('synaptiai/trail');
    expect(loaded.header.branch).toBe('feature/test');
  });

  it('extracts claims with redacted text + evidence_count + effective risk', () => {
    const loaded = parsePacketYaml(MINIMAL_PACKET_YAML, '/test/minimal.yml');
    expect(loaded.claims).toHaveLength(4);
    expect(loaded.claims[0]?.id).toBe('CLAIM-001');
    expect(loaded.claims[0]?.stable_id).toBe('aaaaaaaaaaaaaaaa');
    expect(loaded.claims[0]?.text).toBe('low-risk claim, agent classification only');
    expect(loaded.claims[0]?.evidence_count).toBe(1);
    expect(loaded.claims[0]?.evidence_refs).toEqual(['DIFF-001']);
  });

  it('respects effective-risk priority: reviewer > creator > agent', () => {
    const loaded = parsePacketYaml(MINIMAL_PACKET_YAML, '/test/minimal.yml');
    expect(loaded.claims[0]?.risk_level).toBe('low'); // agent only
    expect(loaded.claims[1]?.risk_level).toBe('med'); // creator override
    expect(loaded.claims[2]?.risk_level).toBe('crit'); // reviewer override wins
    expect(loaded.claims[3]?.risk_level).toBeNull(); // unclassified
  });

  it('aggregates the histogram from effective risk levels', () => {
    const loaded = parsePacketYaml(MINIMAL_PACKET_YAML, '/test/minimal.yml');
    expect(loaded.histogram).toEqual({
      low: 1,
      med: 1,
      high: 0,
      crit: 1,
      classified_total: 3,
    });
  });

  it('extracts approval_trail entries with claim_id, decision, reason, by, at', () => {
    const loaded = parsePacketYaml(MINIMAL_PACKET_YAML, '/test/minimal.yml');
    expect(loaded.approval_trail).toHaveLength(2);
    expect(loaded.approval_trail[0]).toEqual({
      claim_id: 'CLAIM-001',
      decision: 'accept',
      reason: 'looks fine',
      by: 'daniel',
      at: '2026-05-09T11:50:00.000+00:00',
    });
    expect(loaded.approval_trail[1]?.decision).toBe('reject');
    // entry-2 references the claim by stable_id (16-hex), not CLAIM-NNN —
    // schema allows both forms (approval_trail_entry.claim_id oneOf).
    expect(loaded.approval_trail[1]?.claim_id).toBe('cccccccccccccccc');
  });
});

describe('parsePacketYaml — root capture has no parent_packet_id → packet_n = 1', () => {
  const ROOT_CAPTURE = MINIMAL_PACKET_YAML.replace(
    'parent_packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAW',
    'parent_packet_id: null',
  );

  it('drops parent_packet_id, is_recapture=false, packet_n=1', () => {
    const loaded = parsePacketYaml(ROOT_CAPTURE, '/test/root.yml');
    expect(loaded.header.parent_packet_id).toBeNull();
    expect(loaded.header.is_recapture).toBe(false);
    // Cycle-1 P1: root capture is the ONLY case where packet_n is honestly
    // 1 (no parent → chain depth = 1). Non-root packets get packet_n = null
    // because the chain depth is unknown without traversal.
    expect(loaded.header.packet_n).toBe(1);
  });
});

describe('parsePacketYaml — error paths', () => {
  it('throws PacketLoadException with kind=yaml-parse-failed on bad YAML', () => {
    expect(() => parsePacketYaml('this: is: invalid: yaml:::', '/test/bad.yml')).toThrow(
      PacketLoadException,
    );
    try {
      parsePacketYaml('this: is: invalid: yaml:::', '/test/bad.yml');
    } catch (e) {
      expect(e).toBeInstanceOf(PacketLoadException);
      expect((e as PacketLoadException).inner.kind).toBe('yaml-parse-failed');
    }
  });

  it('throws PacketLoadException with kind=schema-rejected when required fields missing', () => {
    // Truncate after `packet_version` so _meta etc. are absent — Ajv must reject.
    const truncated = `packet_version: 0.1.1\n_meta:\n  packet_id: NOT-A-VALID-ULID\n`;
    try {
      parsePacketYaml(truncated, '/test/short.yml');
      expect.fail('expected PacketLoadException');
    } catch (e) {
      expect(e).toBeInstanceOf(PacketLoadException);
      const inner = (e as PacketLoadException).inner;
      // ULID pattern + missing required fields must surface
      expect(inner.kind).toBe('schema-rejected');
      if (inner.kind === 'schema-rejected') {
        expect(inner.errors.length).toBeGreaterThan(0);
      }
    }
  });

  it('rejects an unknown decision enum (closed-enum guard)', () => {
    const bad = MINIMAL_PACKET_YAML.replace('decision: accept', 'decision: maybe');
    expect(() => parsePacketYaml(bad, '/test/bad-decision.yml')).toThrow(PacketLoadException);
  });
});

describe('effectiveRiskLevel — pure helper', () => {
  it('returns null for null/undefined input', () => {
    expect(effectiveRiskLevel(null)).toBeNull();
    expect(effectiveRiskLevel(undefined)).toBeNull();
    expect(effectiveRiskLevel({})).toBeNull();
  });

  it('agent only', () => {
    expect(effectiveRiskLevel({ agent: { level: 'low' } })).toBe('low');
  });

  it('creator overrides agent', () => {
    expect(
      effectiveRiskLevel({
        agent: { level: 'low' },
        creator_override: { level: 'high' },
      }),
    ).toBe('high');
  });

  it('reviewer overrides creator + agent', () => {
    expect(
      effectiveRiskLevel({
        agent: { level: 'low' },
        creator_override: { level: 'med' },
        reviewer_override: { level: 'crit' },
      }),
    ).toBe('crit');
  });

  it('null override level falls through', () => {
    expect(
      effectiveRiskLevel({
        agent: { level: 'med' },
        creator_override: { level: null },
        reviewer_override: { level: null },
      }),
    ).toBe('med');
  });
});

// ---------------------------------------------------------------------------
// Canonical fixture smoke — proves the loader survives the real Phase 1
// emission shape (700KB, 80+ claims, real stable_ids). Per criterion 10:
// no mocks; this exercises the byte-identical artefact py-reference produces.
// ---------------------------------------------------------------------------
describe('parsePacketYaml — canonical fixture (real Phase 1 emission)', () => {
  const FIXTURE_PATH = resolve(
    fileURLToPath(import.meta.url),
    '../../../../../py-reference/fixtures/sessions/18e374b5-4eb9-424d-a3ff-a639d1c6fada/packet-1.yml',
  );

  // py-reference/ is internal-only (excluded from the public mirror per
  // scripts/sync-to-public.sh). When running CI on synaptiai/trail (public),
  // the fixture is absent and this test should skip rather than fail.
  // Locally and in trail-internal CI, the fixture exists and the assertion
  // runs end-to-end. The `it` becomes `it.skipIf` based on filesystem state.
  const FIXTURE_EXISTS = existsSync(FIXTURE_PATH);

  it.skipIf(!FIXTURE_EXISTS)('loads + validates the canonical 700KB fixture', () => {
    const text = readFileSync(FIXTURE_PATH, 'utf8');
    const loaded = parsePacketYaml(text, FIXTURE_PATH);
    expect(loaded.header.packet_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(loaded.header.generator_name).toBe('trail');
    expect(loaded.claims.length).toBeGreaterThan(0);
    // Phase 1 emits an empty / missing approval_trail (parity-locked).
    expect(loaded.approval_trail).toEqual([]);
    // Phase 1 capture has no risk_classification populated → all claims
    // null-leveled, histogram zeroed.
    expect(loaded.histogram.classified_total).toBe(0);
  });
});
