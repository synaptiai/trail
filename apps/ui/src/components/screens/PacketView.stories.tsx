import type { Meta, StoryObj } from '@storybook/react';
import { PacketView } from './PacketView';
import type { LoadedPacket } from '@/services/packet-loader';

const FIXTURE: LoadedPacket = {
  source_path: '/fixtures/packet-1.yml',
  header: {
    packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    session_id: '18e374b5-4eb9-424d-a3ff-a639d1c6fada',
    generated_at: '2026-05-09T12:00:00.000+00:00',
    generator_name: 'trail',
    generator_version: '0.1.0-dev',
    schema_version: '0.1.1',
    parent_packet_id: null,
    packet_n: 1,
    is_recapture: false,
    repository: 'synaptiai/trail',
    branch: 'main',
  },
  claims: [
    {
      id: 'CLAIM-001',
      stable_id: '15b335d83a23a339',
      text: 'updates redirect_uri allowlist to require https',
      evidence_refs: ['DIFF-045', 'TEST-012'],
      evidence_count: 2,
      confidence: 'supported',
      risk_level: 'high',
    },
    {
      id: 'CLAIM-002',
      stable_id: 'aaaaaaaaaaaaaaaa',
      text: 'expands cookie scope to subdomains',
      evidence_refs: ['DIFF-046'],
      evidence_count: 1,
      confidence: 'supported',
      risk_level: 'med',
    },
    {
      id: 'CLAIM-003',
      stable_id: 'bbbbbbbbbbbbbbbb',
      text: 'renames internal helper from foo to bar',
      evidence_refs: ['DIFF-047'],
      evidence_count: 1,
      confidence: 'supported',
      risk_level: 'low',
    },
  ],
  histogram: { low: 1, med: 1, high: 1, crit: 0, classified_total: 3 },
  approval_trail: [],
  diff_summary: {
    base_sha: 'a0368cd46d7a2f5d004a71aab08f2b30dcb0efe0',
    head_sha: 'b1479de57e8b3f7e115c82bbc19f3c41dec0fe1c',
    files_changed: 3,
    lines_added: 18,
    lines_deleted: 6,
    modules_touched: ['src', 'tests'],
    semantic_changes: [
      {
        id: 'DIFF-045',
        description: 'Edited src/auth/redirect.ts',
        files: ['src/auth/redirect.ts'],
        operation: 'edit',
        excerpts: [
          { kind: 'before', text: 'const PATTERN = /.+/;', elided: false },
          { kind: 'after', text: 'const PATTERN = /^https:\\/\\/.+/;', elided: false },
        ],
      },
      {
        id: 'DIFF-046',
        description: 'Edited src/auth/cookies.ts',
        files: ['src/auth/cookies.ts'],
        operation: 'edit',
        excerpts: [
          { kind: 'before', text: 'domain: "example.com",', elided: false },
          { kind: 'after', text: 'domain: ".example.com",', elided: false },
        ],
      },
      {
        id: 'DIFF-047',
        description: 'Wrote tests/auth/redirect.test.ts',
        files: ['tests/auth/redirect.test.ts'],
        operation: 'write',
        excerpts: [
          {
            kind: 'after',
            text: 'import { describe, it } from "vitest";\n\ndescribe("redirect", () => {\n  it("requires https", () => {\n    // ...\n  });\n});',
            elided: false,
          },
        ],
      },
    ],
  },
  redaction_summary: {
    pattern_set_version: '0.1.3',
    pattern_set_origin: 'bundled',
    redactions_applied: 3,
    by_pattern: [
      { pattern_name: 'generic-32hex', count: 2 },
      { pattern_name: 'slack-token', count: 1 },
    ],
    validation_errors: [],
  },
  posted_to_pr: [],
};

const RECAPTURED: LoadedPacket = {
  ...FIXTURE,
  header: {
    ...FIXTURE.header,
    parent_packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    packet_n: null, // Sprint 3a: chain depth unknown
    is_recapture: true,
  },
};

const WITH_TRAIL: LoadedPacket = {
  ...FIXTURE,
  approval_trail: [
    {
      claim_id: 'CLAIM-001',
      decision: 'accept',
      reason: 'reviewed and approved',
      by: 'daniel',
      at: '2026-05-09T12:30:00.000+00:00',
    },
    {
      claim_id: 'CLAIM-002',
      decision: 'changes',
      reason: 'tighten scope before merging',
      by: 'reviewer-A',
      at: '2026-05-09T12:35:00.000+00:00',
    },
  ],
};

const meta: Meta<typeof PacketView> = {
  title: 'Screens/PacketView',
  component: PacketView,
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Story = StoryObj<typeof PacketView>;

export const CreatorMode: Story = {
  args: {
    packetId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    persona: 'creator',
    loadedPacket: FIXTURE,
  },
};

export const ReviewerMode: Story = {
  args: {
    packetId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    persona: 'reviewer',
    loadedPacket: WITH_TRAIL,
  },
};

export const AuditorMode: Story = {
  args: {
    packetId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    persona: 'auditor',
    loadedPacket: WITH_TRAIL,
  },
};

export const RecaptureCreator: Story = {
  args: {
    packetId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    persona: 'creator',
    loadedPacket: RECAPTURED,
  },
};

export const AuditorEmptyHighRisk: Story = {
  args: {
    packetId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    persona: 'auditor',
    loadedPacket: FIXTURE, // empty trail + high=1 → audit-elevated empty
  },
};
