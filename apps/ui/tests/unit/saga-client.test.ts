/**
 * Unit tests for the saga client (TS thin wrapper). The IPC bridge is
 * unavailable in vitest's happy-dom env, so we mock @/ipc/client. The
 * tests pin: (1) the saga args build the expected wire shape, (2) the
 * timestamp formatting follows the schema's `+00:00` convention.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/ipc/client', () => ({
  invoke: vi.fn(async () => ({ ok: true })),
}));

import { invoke } from '@/ipc/client';
import { nowIso, submitDecision, submitRiskOverride } from '@/services/saga-client';

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedInvoke.mockClear();
});

describe('nowIso', () => {
  it('emits +00:00 suffix, not Z', () => {
    const ts = nowIso(new Date('2026-05-09T12:00:00.000Z'));
    expect(ts).toBe('2026-05-09T12:00:00.000+00:00');
  });

  it('handles fractional seconds', () => {
    const ts = nowIso(new Date('2026-05-09T12:00:00.123Z'));
    expect(ts.endsWith('+00:00')).toBe(true);
    expect(ts).not.toMatch(/Z$/);
  });
});

describe('submitDecision', () => {
  it('builds the save_decision args including by + at', async () => {
    await submitDecision({
      packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      claim_id: 'CLAIM-001',
      decision: 'accept',
      by: 'alice@example.com',
      persona: 'creator',
    });
    expect(mockedInvoke).toHaveBeenCalledWith(
      'save_decision',
      expect.objectContaining({
        packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        claim_id: 'CLAIM-001',
        decision: 'accept',
        by: 'alice@example.com',
        at: expect.stringMatching(/\+00:00$/),
      }),
    );
  });

  it('omits reason when undefined (vs sending undefined which would fail validation)', async () => {
    await submitDecision({
      packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      claim_id: 'CLAIM-001',
      decision: 'accept',
      persona: 'creator',
    });
    const args = mockedInvoke.mock.calls[0]![1] as Record<string, unknown>;
    expect(args).not.toHaveProperty('reason');
  });

  it('includes reason when provided', async () => {
    await submitDecision({
      packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      claim_id: 'CLAIM-001',
      decision: 'block',
      reason: 'oauth wiring incomplete',
      persona: 'reviewer',
    });
    const args = mockedInvoke.mock.calls[0]![1] as Record<string, unknown>;
    expect(args.reason).toBe('oauth wiring incomplete');
  });

  it('falls back to "you" when by is omitted', async () => {
    await submitDecision({
      packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      claim_id: 'CLAIM-001',
      decision: 'accept',
      persona: 'creator',
    });
    const args = mockedInvoke.mock.calls[0]![1] as Record<string, unknown>;
    expect(args.by).toBe('you');
  });

  // Cycle-3 C4 (PR #21): persona threading on save_decision.
  it('forwards persona on save_decision (C4)', async () => {
    await submitDecision({
      packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      claim_id: 'CLAIM-001',
      decision: 'accept',
      persona: 'creator',
    });
    const args = mockedInvoke.mock.calls[0]![1] as Record<string, unknown>;
    expect(args.persona).toBe('creator');
  });
});

describe('submitRiskOverride', () => {
  it('builds the override_risk args with layer + new_level', async () => {
    await submitRiskOverride({
      packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      claim_id: 'CLAIM-001',
      layer: 'reviewer',
      new_level: 'high',
      reason: 'audit-relevant scope change',
      by: 'bob@example.com',
      persona: 'reviewer',
    });
    expect(mockedInvoke).toHaveBeenCalledWith(
      'override_risk',
      expect.objectContaining({
        packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        claim_id: 'CLAIM-001',
        layer: 'reviewer',
        new_level: 'high',
        reason: 'audit-relevant scope change',
        by: 'bob@example.com',
        // Cycle-3 C4 (PR #21).
        persona: 'reviewer',
      }),
    );
  });
});
