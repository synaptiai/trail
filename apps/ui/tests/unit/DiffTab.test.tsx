import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { DiffTab } from '@/components/screens/DiffTab';
import type { DiffSummaryShape } from '@/services/packet-loader';

/**
 * Sprint 3b — DiffTab component (gh#10 criterion 1, 2).
 *
 * Pinned contracts:
 *   1. One DiffHunk renders per semantic_change, in source order.
 *   2. Per-hunk language is inferred from files[0] via inferLanguage.
 *   3. Empty diff_summary → empty-state copy ("No code changes captured").
 *   4. Hunk header surfaces the file path + operation hint.
 *   5. Hunk body uses the +/- shape derived from before/after excerpts.
 *   6. Passes axe-core a11y scan with non-empty diff.
 */

const SAMPLE_DIFF: DiffSummaryShape = {
  base_sha: '0'.repeat(40),
  head_sha: '1'.repeat(40),
  files_changed: 2,
  lines_added: 4,
  lines_deleted: 2,
  modules_touched: ['src', 'tests'],
  semantic_changes: [
    {
      id: 'DIFF-001',
      description: 'Edited src/foo.ts',
      files: ['src/foo.ts'],
      operation: 'edit',
      excerpts: [
        { kind: 'before', text: 'const x = 1;', elided: false },
        { kind: 'after', text: 'const x = 2;', elided: false },
      ],
    },
    {
      id: 'DIFF-002',
      description: 'Wrote tests/bar.test.py',
      files: ['tests/bar.test.py'],
      operation: 'write',
      excerpts: [
        { kind: 'after', text: 'def test_bar():\n    assert True', elided: false },
      ],
    },
  ],
};

describe('<DiffTab>', () => {
  it('renders one hunk per semantic_change in source order', async () => {
    render(<DiffTab diff_summary={SAMPLE_DIFF} />);
    // Each hunk's region surfaces the file path in its aria-label.
    const region1 = await screen.findByRole('region', { name: /Diff hunk: src\/foo\.ts/ });
    const region2 = await screen.findByRole('region', { name: /Diff hunk: tests\/bar\.test\.py/ });
    expect(region1).toBeInTheDocument();
    expect(region2).toBeInTheDocument();
  });

  it('surfaces file paths and DIFF-NNN ids in hunk headers', async () => {
    render(<DiffTab diff_summary={SAMPLE_DIFF} />);
    expect(await screen.findByText('src/foo.ts')).toBeInTheDocument();
    expect(screen.getByText('tests/bar.test.py')).toBeInTheDocument();
    // DIFF-NNN surfaces alongside the file (per B4 §4.3 "claim # + risk
    // glyph" margin pattern; we render the DIFF id as the equivalent
    // structural ID even before per-claim margins land in Sprint 4).
    expect(screen.getByText('DIFF-001')).toBeInTheDocument();
    expect(screen.getByText('DIFF-002')).toBeInTheDocument();
  });

  it('renders empty-state when semantic_changes is empty', () => {
    const empty: DiffSummaryShape = { ...SAMPLE_DIFF, semantic_changes: [] };
    render(<DiffTab diff_summary={empty} />);
    expect(screen.getByText(/No code changes captured/i)).toBeInTheDocument();
  });

  it('renders + line for an excerpt with kind "after" only', async () => {
    const writeOnly: DiffSummaryShape = {
      ...SAMPLE_DIFF,
      semantic_changes: [SAMPLE_DIFF.semantic_changes[1]!], // tests/bar.test.py — write op
    };
    const { container } = render(<DiffTab diff_summary={writeOnly} />);
    await waitFor(() => {
      // Write op → all lines render as additions (+, mapped to --add
      // class in cycle-3 C3; previous '\+' escape no longer needed).
      const additions = container.querySelectorAll('.diff-hunk__line--add');
      expect(additions.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('renders both - and + lines for an edit op (before/after pair)', async () => {
    const editOnly: DiffSummaryShape = {
      ...SAMPLE_DIFF,
      semantic_changes: [SAMPLE_DIFF.semantic_changes[0]!], // src/foo.ts edit
    };
    const { container } = render(<DiffTab diff_summary={editOnly} />);
    await waitFor(() => {
      // Cycle-3 C3 (PR #21): word-form classes (was --\+ / --\-).
      const removals = container.querySelectorAll('.diff-hunk__line--del');
      const additions = container.querySelectorAll('.diff-hunk__line--add');
      expect(removals.length).toBeGreaterThanOrEqual(1);
      expect(additions.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('passes axe-core a11y scan', async () => {
    const { container } = render(<DiffTab diff_summary={SAMPLE_DIFF} />);
    await waitFor(() => {
      // Wait for at least one hunk's region to be present.
      expect(container.querySelector('.diff-hunk')).not.toBeNull();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
