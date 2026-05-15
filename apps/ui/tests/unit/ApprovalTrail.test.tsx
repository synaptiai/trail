import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { ApprovalTrail } from '@/components/screens/ApprovalTrail';
import type { ApprovalTrailEntryShape } from '@/services/packet-loader';

const ENTRIES: ApprovalTrailEntryShape[] = [
  {
    claim_id: 'CLAIM-001',
    decision: 'accept',
    reason: 'looks fine',
    by: 'daniel',
    at: '2026-05-09T11:50:00.000+00:00',
  },
  {
    claim_id: 'cccccccccccccccc',
    decision: 'reject',
    reason: 'cannot ship with auth bypass',
    by: 'reviewer-A',
    at: '2026-05-09T11:51:00.000+00:00',
  },
  {
    claim_id: 'CLAIM-007',
    decision: 'changes',
    reason: null,
    by: 'reviewer-B',
    at: '2026-05-09T11:55:00.000+00:00',
  },
];

describe('<ApprovalTrail>', () => {
  it('renders one row per entry with decision + claim + by + at', () => {
    render(<ApprovalTrail entries={ENTRIES} persona="creator" />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(screen.getAllByText(/accept/)).not.toHaveLength(0);
    expect(screen.getAllByText(/reject/)).not.toHaveLength(0);
    expect(screen.getAllByText(/changes/)).not.toHaveLength(0);
  });

  it('renders reason text when entry.reason is non-empty', () => {
    render(<ApprovalTrail entries={ENTRIES} persona="creator" />);
    expect(screen.getByText(/looks fine/)).toBeInTheDocument();
    expect(screen.getByText(/cannot ship with auth bypass/)).toBeInTheDocument();
  });

  it('omits reason paragraph when reason is null (markdown.ts parity: "—" placeholder is markdown-only)', () => {
    render(<ApprovalTrail entries={ENTRIES} persona="creator" />);
    // The third entry has reason=null. There must be NO "—" reason placeholder
    // in the React render (the markdown render uses "—"; the React render
    // simply omits the row, which is more accessible).
    const reasonDashes = screen.queryAllByText('—');
    expect(reasonDashes).toHaveLength(0);
  });

  it('exposes a per-entry aria-label that is one full sentence (criterion 4 — verbal)', () => {
    render(<ApprovalTrail entries={ENTRIES} persona="creator" />);
    const items = screen.getAllByRole('listitem');
    const labels = items.map((i) => i.getAttribute('aria-label') ?? '');
    expect(labels[0]).toContain('Decision 1: accept on claim CLAIM-001 by daniel');
    expect(labels[0]).toContain('looks fine');
    expect(labels[2]).toContain('Decision 3: changes on claim CLAIM-007 by reviewer-B');
    // Reason-null entries have no trailing reason fragment
    expect(labels[2]).not.toMatch(/—\s*$/);
  });

  it('renders the audit-elevated empty state when persona=auditor + audit_high_risk_unrecorded', () => {
    render(
      <ApprovalTrail
        entries={[]}
        persona="auditor"
        audit_high_risk_unrecorded={true}
      />,
    );
    expect(screen.getByText(/No approval decisions recorded\./)).toBeInTheDocument();
    expect(
      screen.getByText(/Audit-relevant: HIGH-risk packet without recorded approval/),
    ).toBeInTheDocument();
  });

  it('renders the neutral empty state for non-auditor empty trails', () => {
    render(<ApprovalTrail entries={[]} persona="creator" />);
    expect(screen.getByText(/No approval decisions recorded for this packet/)).toBeInTheDocument();
    expect(screen.queryByText(/Audit-relevant/)).toBeNull();
  });

  it('renders a `section` landmark', () => {
    render(<ApprovalTrail entries={ENTRIES} persona="creator" />);
    expect(screen.getByLabelText('Approval trail')).toBeInTheDocument();
  });

  it('mirrors markdown.ts decision label set (parity contract — F25 lesson)', () => {
    // markdown.ts uses the same four decision strings (accept, changes, block,
    // reject); this test pins the React render to the same set so a future
    // schema enum extension surfaces in BOTH layers, not silently in one.
    const allDecisions: ApprovalTrailEntryShape[] = (
      ['accept', 'changes', 'block', 'reject'] as const
    ).map((d, i) => ({
      claim_id: `CLAIM-${String(i + 1).padStart(3, '0')}`,
      decision: d,
      reason: null,
      by: 'tester',
      at: `2026-05-09T11:${50 + i}:00.000+00:00`,
    }));
    render(<ApprovalTrail entries={allDecisions} persona="creator" />);
    for (const d of ['accept', 'changes', 'block', 'reject']) {
      expect(screen.getAllByText(new RegExp(`\\b${d}\\b`)).length).toBeGreaterThan(0);
    }
  });

  it('passes axe-core a11y scan (entries present)', async () => {
    const { container } = render(<ApprovalTrail entries={ENTRIES} persona="creator" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('passes axe-core a11y scan (empty + auditor)', async () => {
    const { container } = render(
      <ApprovalTrail
        entries={[]}
        persona="auditor"
        audit_high_risk_unrecorded={true}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
