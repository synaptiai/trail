import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { ClaimRow } from '@/components/screens/ClaimRow';
import type { PacketClaimShape } from '@/services/packet-loader';

const CLAIM_BASE: PacketClaimShape = {
  id: 'CLAIM-001',
  stable_id: '15b335d83a23a339',
  text: 'updates redirect_uri allowlist to require https + subdomain match',
  evidence_refs: ['DIFF-045', 'TEST-012'],
  evidence_count: 2,
  confidence: 'supported',
  risk_level: 'high',
};

describe('<ClaimRow>', () => {
  it('renders the risk dot variant with correct level + label', () => {
    render(<ClaimRow claim={CLAIM_BASE} />);
    const risk = screen.getByRole('img', { name: 'Risk level: high' });
    expect(risk).toBeInTheDocument();
    expect(risk.textContent).toContain('HIGH');
  });

  it('shows truncated stable_id with full ID in title', () => {
    render(<ClaimRow claim={CLAIM_BASE} />);
    const idEl = screen.getByText('15b335d8…');
    expect(idEl.getAttribute('title')).toBe('15b335d83a23a339');
  });

  it('falls back to CLAIM-NNN id when stable_id missing (legacy v0.1 packet)', () => {
    const noStable: PacketClaimShape = {
      id: 'CLAIM-007',
      text: 'legacy claim — no stable_id',
      evidence_refs: ['DIFF-001'],
      evidence_count: 1,
      confidence: 'supported',
      risk_level: 'med',
    };
    render(<ClaimRow claim={noStable} />);
    expect(screen.getByText('CLAIM-007')).toBeInTheDocument();
  });

  it('renders evidence count pill (criterion 3: ev × N)', () => {
    render(<ClaimRow claim={CLAIM_BASE} />);
    const ev = screen.getByText(/ev × 2/);
    expect(ev).toBeInTheDocument();
    expect(ev.getAttribute('aria-label')).toBe('2 evidence references');
  });

  it('renders an unclassified marker when risk_level is null', () => {
    const unclass: PacketClaimShape = { ...CLAIM_BASE, risk_level: null };
    render(<ClaimRow claim={unclass} />);
    const marker = screen.getByLabelText('Risk level: unclassified');
    expect(marker).toBeInTheDocument();
  });

  it('starts collapsed and toggles to expanded on click', async () => {
    const user = userEvent.setup();
    render(<ClaimRow claim={CLAIM_BASE} />);
    const toggle = screen.getByRole('button', { expanded: false });
    expect(toggle).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    // Expanded panel surfaces the evidence references
    expect(screen.getByText(/DIFF-045 · TEST-012/)).toBeInTheDocument();
  });

  it('truncates long claim text in collapsed view', () => {
    const long: PacketClaimShape = {
      ...CLAIM_BASE,
      text: 'x'.repeat(250),
    };
    render(<ClaimRow claim={long} />);
    // Truncation char (…) should appear in the visible label.
    const labelled = screen.getByLabelText(
      `Risk level: high`,
    ).parentElement?.textContent;
    expect(labelled).toContain('…');
  });

  it('exposes claim as <article> landmark', () => {
    const { container } = render(<ClaimRow claim={CLAIM_BASE} />);
    const article = container.querySelector('article');
    expect(article).not.toBeNull();
  });

  it('passes axe-core a11y scan', async () => {
    const { container } = render(<ClaimRow claim={CLAIM_BASE} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Cycle-2 C2 (PR #21): perf-gate E2E observes data-decision +
  // data-decision-persisted on .claim-row to time optimistic-vs-durable
  // budgets. ClaimRow surfaces them as data-attributes when the
  // ClaimsTab orchestrator passes the props in.
  describe('decision data-attributes (C2)', () => {
    it('omits data-decision + data-decision-persisted when neither prop is set', () => {
      const { container } = render(<ClaimRow claim={CLAIM_BASE} />);
      const article = container.querySelector('article.claim-row');
      expect(article).not.toBeNull();
      expect(article!.hasAttribute('data-decision')).toBe(false);
      expect(article!.hasAttribute('data-decision-persisted')).toBe(false);
    });

    it('emits data-decision="<kind>" when optimisticDecision is set', () => {
      const { container } = render(
        <ClaimRow claim={CLAIM_BASE} optimisticDecision="accept" />,
      );
      const article = container.querySelector('article.claim-row');
      expect(article!.getAttribute('data-decision')).toBe('accept');
      // persisted prop not passed → durable mark stays absent.
      expect(article!.hasAttribute('data-decision-persisted')).toBe(false);
    });

    it('emits data-decision-persisted="true" when persisted is true', () => {
      const { container } = render(
        <ClaimRow
          claim={CLAIM_BASE}
          optimisticDecision="block"
          persisted={true}
        />,
      );
      const article = container.querySelector('article.claim-row');
      expect(article!.getAttribute('data-decision')).toBe('block');
      expect(article!.getAttribute('data-decision-persisted')).toBe('true');
    });

    it('flips between optimistic and durable independently', () => {
      // Optimistic without persisted: in-flight state.
      const { container, rerender } = render(
        <ClaimRow claim={CLAIM_BASE} optimisticDecision="changes" />,
      );
      const article = container.querySelector('article.claim-row')!;
      expect(article.getAttribute('data-decision')).toBe('changes');
      expect(article.hasAttribute('data-decision-persisted')).toBe(false);

      // Then the saga IPC resolves: persisted flips to true.
      rerender(
        <ClaimRow
          claim={CLAIM_BASE}
          optimisticDecision="changes"
          persisted={true}
        />,
      );
      expect(article.getAttribute('data-decision-persisted')).toBe('true');
    });
  });
});
