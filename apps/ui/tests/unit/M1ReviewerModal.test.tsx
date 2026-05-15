/**
 * M1 reviewer-mode risk override tests (gh#11 criterion 5).
 *
 * Pins the three-row stack contract from B4 §7.1:
 *   - Agent row always renders (read-only).
 *   - Creator row collapses out when no creator override.
 *   - Reviewer row interactive; reason ≥3 chars gates Save.
 *   - axe a11y violations: zero.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/services/saga-client', () => ({
  submitRiskOverride: vi.fn(async () => undefined),
}));

import { submitRiskOverride } from '@/services/saga-client';
import { M1ReviewerModal } from '@/components/screens/M1ReviewerModal';

const mockedSubmit = submitRiskOverride as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedSubmit.mockClear();
});

describe('<M1ReviewerModal>', () => {
  it('renders Agent + Reviewer rows when no creator override', () => {
    render(
      <M1ReviewerModal
        open
        onClose={() => {}}
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        claimId="CLAIM-001"
        claimText="updates redirect_uri allowlist"
        agentLevel="med"
        agentRationale="scope unchanged; lint ok"
        creatorOverride={null}
      />,
    );
    expect(screen.getByText("Agent's classification")).toBeInTheDocument();
    expect(screen.queryByText('Creator override')).not.toBeInTheDocument();
    expect(screen.getByText('Your override')).toBeInTheDocument();
  });

  it('renders all three rows when creator override is supplied', () => {
    render(
      <M1ReviewerModal
        open
        onClose={() => {}}
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        claimId="CLAIM-001"
        claimText="updates redirect_uri allowlist"
        agentLevel="med"
        agentRationale="scope unchanged"
        creatorOverride={{
          level: 'high',
          reason: 'audit-relevant scope change',
          by: 'daniel@example.com',
          at: '2026-05-09T14:33:00+00:00',
        }}
      />,
    );
    expect(screen.getByText("Agent's classification")).toBeInTheDocument();
    expect(screen.getByText('Creator override')).toBeInTheDocument();
    expect(screen.getByText('Your override')).toBeInTheDocument();
    expect(screen.getByText('audit-relevant scope change')).toBeInTheDocument();
  });

  it('disables Save until reason is ≥3 characters', () => {
    render(
      <M1ReviewerModal
        open
        onClose={() => {}}
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        claimId="CLAIM-001"
        claimText="..."
        agentLevel="med"
        creatorOverride={null}
      />,
    );
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    const reason = screen.getByTestId('m1-reason') as HTMLTextAreaElement;
    fireEvent.change(reason, { target: { value: 'ab' } });
    expect(save).toBeDisabled();
    fireEvent.change(reason, { target: { value: 'abc' } });
    expect(save).not.toBeDisabled();
  });

  it('Save calls submitRiskOverride with reviewer layer + chosen level', async () => {
    const onClose = vi.fn();
    render(
      <M1ReviewerModal
        open
        onClose={onClose}
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        claimId="CLAIM-001"
        claimText="..."
        agentLevel="med"
        creatorOverride={null}
      />,
    );
    // Click the HIGH radio (third one in our list)
    const highInput = screen
      .getAllByRole('radio')
      .find((r) => (r as HTMLInputElement).value === 'high');
    expect(highInput).toBeDefined();
    fireEvent.click(highInput!);

    const reason = screen.getByTestId('m1-reason') as HTMLTextAreaElement;
    fireEvent.change(reason, { target: { value: 'raised based on new evidence' } });
    // Save invokes an async handler that updates state after submitRiskOverride
    // resolves; wrap in act() so React flushes the microtask queue and the
    // post-resolution state transition without surfacing the "not wrapped"
    // warning. Replaces the prior bare `await Promise.resolve()` shim which
    // was insufficient on @testing-library/react ≥14.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(mockedSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        claim_id: 'CLAIM-001',
        layer: 'reviewer',
        new_level: 'high',
        reason: 'raised based on new evidence',
      }),
    );
  });

  it('passes axe a11y scan', async () => {
    const { container } = render(
      <M1ReviewerModal
        open
        onClose={() => {}}
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        claimId="CLAIM-001"
        claimText="updates redirect_uri allowlist"
        agentLevel="med"
        creatorOverride={null}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
