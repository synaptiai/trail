import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { RedactionTab } from '@/components/screens/RedactionTab';
import type { RedactionSummaryShape } from '@/services/packet-loader';

/**
 * Sprint 3b — RedactionTab component (gh#10 criterion 1; B4 §4.5).
 *
 * Pinned contracts:
 *   1. Renders pattern-set version + total redactions count.
 *   2. Surfaces by_pattern as a sortable table (pattern_name | count).
 *   3. Empty-state when redactions_applied = 0 reads "No redactions
 *      applied" — distinct from "redaction not run" (which would be
 *      a schema-validation error).
 *   4. Surfaces validation_errors prominently when non-empty.
 *   5. Notes the M3 modal preview is opt-in (per Settings) per B4 §4.5.
 *   6. Passes axe-core a11y scan.
 */

const SUMMARY_3_REDACTIONS: RedactionSummaryShape = {
  pattern_set_version: '0.1.3',
  pattern_set_origin: 'bundled',
  redactions_applied: 3,
  by_pattern: [
    { pattern_name: 'aws-access-key', count: 1 },
    { pattern_name: 'generic-32hex', count: 2 },
  ],
  validation_errors: [],
};

const SUMMARY_EMPTY: RedactionSummaryShape = {
  pattern_set_version: '0.1.3',
  pattern_set_origin: 'bundled',
  redactions_applied: 0,
  by_pattern: [],
  validation_errors: [],
};

const SUMMARY_WITH_ERRORS: RedactionSummaryShape = {
  pattern_set_version: '0.1.3',
  pattern_set_origin: 'user-supplied',
  redactions_applied: 1,
  by_pattern: [{ pattern_name: 'custom-token', count: 1 }],
  validation_errors: ['regex-too-broad: matches more than 50% of input'],
};

describe('<RedactionTab>', () => {
  it('surfaces the pattern set version', () => {
    render(<RedactionTab redaction_summary={SUMMARY_3_REDACTIONS} />);
    expect(screen.getByText(/0\.1\.3/)).toBeInTheDocument();
  });

  it('surfaces the total redactions applied count', () => {
    render(<RedactionTab redaction_summary={SUMMARY_3_REDACTIONS} />);
    expect(screen.getByText(/3 redactions/i)).toBeInTheDocument();
  });

  it('renders by_pattern as a table with pattern_name + count columns', () => {
    render(<RedactionTab redaction_summary={SUMMARY_3_REDACTIONS} />);
    const table = screen.getByRole('table', { name: /Redactions by pattern/i });
    expect(table).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Pattern/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Count/i })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'aws-access-key' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'generic-32hex' })).toBeInTheDocument();
  });

  it('empty state — redactions_applied=0 reads "No redactions applied"', () => {
    render(<RedactionTab redaction_summary={SUMMARY_EMPTY} />);
    expect(screen.getByText(/No redactions applied/i)).toBeInTheDocument();
  });

  it('flags user-supplied pattern set as integrity-affecting', () => {
    render(<RedactionTab redaction_summary={SUMMARY_WITH_ERRORS} />);
    // pattern_set_origin = "user-supplied" must be visible as an
    // integrity warning per schema description: pattern_set_version is
    // forgeable when origin != "bundled". Both the meta strip and the
    // banner mention it; we expect ≥ 1 occurrence and a banner present
    // to make the warning prominent (not just a quiet meta-strip flag).
    const matches = screen.getAllByText(/user-supplied/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText(/Pattern set version is forgeable when origin/),
    ).toBeInTheDocument();
  });

  it('surfaces validation_errors when present', () => {
    render(<RedactionTab redaction_summary={SUMMARY_WITH_ERRORS} />);
    expect(
      screen.getByText(/regex-too-broad: matches more than 50% of input/),
    ).toBeInTheDocument();
  });

  it('mentions opt-in preview note (B4 §4.5)', () => {
    render(<RedactionTab redaction_summary={SUMMARY_3_REDACTIONS} />);
    // Per B4 §4.5: "Preview-original is opt-in. Enable in Settings →
    // Redaction → Allow in-memory preview."
    expect(
      screen.getByText(/Preview-original is opt-in\. Enable in Settings → Redaction/),
    ).toBeInTheDocument();
  });

  it('passes axe-core a11y scan with populated table', async () => {
    const { container } = render(<RedactionTab redaction_summary={SUMMARY_3_REDACTIONS} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('passes axe-core a11y scan with validation errors visible', async () => {
    const { container } = render(<RedactionTab redaction_summary={SUMMARY_WITH_ERRORS} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
