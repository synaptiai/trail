import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ClaimsTab } from '@/components/screens/ClaimsTab';
import type {
  PacketClaimShape,
  ApprovalTrailEntryShape,
} from '@/services/packet-loader';

/**
 * <ClaimsTab> — Sprint 4 + Cycle-2 C2 (PR #21).
 *
 * Cycle-2 C2: the perf-gate E2E test
 * apps/ui/tests/e2e/sprint6-perf-gates.spec.ts gates on two DOM signals:
 *
 *   data-decision="<kind>"            (optimistic — set BEFORE saga acks)
 *   data-decision-persisted="true"    (durable    — set AFTER saga acks)
 *
 * These tests pin the orchestrator's behaviour so the perf budget can
 * observe a real signal rather than a time-budget proxy. The signals
 * propagate from ClaimsTab (which holds the in-flight state) down to
 * each ClaimRow as data-attributes; tests query the article.claim-row
 * directly because that's the same selector the E2E uses.
 */

const CLAIM_A: PacketClaimShape = {
  id: 'CLAIM-001',
  stable_id: '15b335d83a23a339',
  text: 'Adds redirect_uri allowlist',
  evidence_refs: ['DIFF-045'],
  evidence_count: 1,
  confidence: 'supported',
  risk_level: 'high',
};
const CLAIM_B: PacketClaimShape = {
  id: 'CLAIM-002',
  stable_id: '2b2b2b2b2b2b2b2b',
  text: 'Updates retry policy',
  evidence_refs: ['DIFF-046'],
  evidence_count: 1,
  confidence: 'supported',
  risk_level: 'med',
};

function getRow(stableId: string): HTMLElement {
  // Wrapper carries data-claim-id; descend to .claim-row article.
  const wrapper = document.querySelector(`[data-claim-id="${stableId}"]`);
  if (!wrapper) throw new Error(`no row for ${stableId}`);
  const article = wrapper.querySelector('article.claim-row');
  if (!article) throw new Error(`no article in row ${stableId}`);
  return article as HTMLElement;
}

describe('<ClaimsTab> decision data-attributes (C2)', () => {
  it('omits data-decision + data-decision-persisted on idle rows', () => {
    render(
      <ClaimsTab
        claims={[CLAIM_A, CLAIM_B]}
        approvalTrail={[]}
        onDecide={vi.fn()}
      />,
    );
    const rowA = getRow('15b335d83a23a339');
    expect(rowA.hasAttribute('data-decision')).toBe(false);
    expect(rowA.hasAttribute('data-decision-persisted')).toBe(false);
  });

  it('flips data-decision optimistically before the onDecide promise resolves', async () => {
    let resolveOnDecide!: () => void;
    const onDecide = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOnDecide = resolve;
        }),
    );
    render(
      <ClaimsTab
        claims={[CLAIM_A, CLAIM_B]}
        approvalTrail={[]}
        onDecide={onDecide}
      />,
    );
    // Press `a` (accept) on the focused row (index 0 = CLAIM_A).
    fireEvent.keyDown(document, { key: 'a' });

    // Optimistic mark must be present even though the saga has NOT acked.
    await waitFor(() => {
      expect(getRow('15b335d83a23a339').getAttribute('data-decision')).toBe(
        'accept',
      );
    });
    // Durable mark must NOT yet be present.
    expect(
      getRow('15b335d83a23a339').hasAttribute('data-decision-persisted'),
    ).toBe(false);

    // Now resolve the saga.
    await act(async () => {
      resolveOnDecide();
    });

    // Durable mark flips after the awaited handler resolves.
    await waitFor(() => {
      expect(
        getRow('15b335d83a23a339').getAttribute('data-decision-persisted'),
      ).toBe('true');
    });
    expect(onDecide).toHaveBeenCalledWith('15b335d83a23a339', 'accept');
  });

  it('clears optimistic mark when onDecide rejects', async () => {
    const onDecide = vi.fn(() => Promise.reject(new Error('saga failed')));
    render(
      <ClaimsTab
        claims={[CLAIM_A]}
        approvalTrail={[]}
        onDecide={onDecide}
      />,
    );
    fireEvent.keyDown(document, { key: 'b' }); // block

    // Initially optimistic.
    await waitFor(() => {
      expect(getRow('15b335d83a23a339').getAttribute('data-decision')).toBe(
        'block',
      );
    });
    // After rejection, optimistic mark is cleared and persisted is never set.
    await waitFor(() => {
      expect(getRow('15b335d83a23a339').hasAttribute('data-decision')).toBe(
        false,
      );
    });
    expect(
      getRow('15b335d83a23a339').hasAttribute('data-decision-persisted'),
    ).toBe(false);
  });

  it('marks already-persisted rows from approvalTrail as durable on mount', () => {
    const trail: ApprovalTrailEntryShape[] = [
      {
        claim_id: '15b335d83a23a339',
        decision: 'accept',
        reason: null,
        by: 'reviewer',
        at: '2026-05-09T00:00:00+00:00',
      },
    ];
    render(
      <ClaimsTab
        claims={[CLAIM_A, CLAIM_B]}
        approvalTrail={trail}
        onDecide={vi.fn()}
      />,
    );
    const rowA = getRow('15b335d83a23a339');
    expect(rowA.getAttribute('data-decision')).toBe('accept');
    expect(rowA.getAttribute('data-decision-persisted')).toBe('true');

    // CLAIM_B unaffected.
    const rowB = getRow('2b2b2b2b2b2b2b2b');
    expect(rowB.hasAttribute('data-decision')).toBe(false);
    expect(rowB.hasAttribute('data-decision-persisted')).toBe(false);
  });
});
