import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { DiffHunk } from '@/components/primitives';
import type { DiffHunkLine } from '@/components/primitives';

/**
 * Sprint 6 (gh#13 AC-2): primitive axe-clean coverage.
 *
 * The deeper shiki + perf coverage lives in the E2E suite
 * (diff-hunk-perf.spec.ts) and the highlight unit tests; here we scope
 * to the React-shell ARIA wiring + axe-clean assertion.
 */
const FIXTURE_LINES: DiffHunkLine[] = [
  { kind: ' ', content: 'export function add(a: number, b: number) {', newLineNo: 1, oldLineNo: 1 },
  { kind: '-', content: '  return a + b;', newLineNo: null, oldLineNo: 2 },
  { kind: '+', content: '  return Math.trunc(a) + Math.trunc(b);', newLineNo: 2, oldLineNo: null },
  { kind: ' ', content: '}', newLineNo: 3, oldLineNo: 3 },
];

describe('<DiffHunk>', () => {
  it('renders with role=region and a path-derived ARIA label', async () => {
    render(<DiffHunk path="src/foo.ts" language="typescript" lines={FIXTURE_LINES} />);
    const region = screen.getByRole('region', { name: /Diff hunk: src\/foo\.ts/ });
    expect(region).toBeInTheDocument();
  });

  it('renders +/- gutter prefixes (defense vs color-alone signalling, B3 §12.2)', async () => {
    const { container } = render(
      <DiffHunk path="src/foo.ts" language="typescript" lines={FIXTURE_LINES} />,
    );
    // Wait for shiki to settle — once highlighted, lines render.
    await waitFor(() => {
      expect(container.querySelectorAll('.diff-hunk__line').length).toBeGreaterThan(0);
    }, { timeout: 5000 });
    expect(container.textContent).toContain('+');
    // The minus marker uses the typographic U+2212 (−), not the ASCII
    // hyphen-minus. Either is acceptable for WCAG 1.4.1 — what matters
    // is that an SR-readable non-color signal IS rendered.
    expect(container.textContent).toMatch(/[−-]/);
  });

  it('axe-clean once shiki has settled', async () => {
    const { container } = render(
      <DiffHunk path="src/foo.ts" language="typescript" lines={FIXTURE_LINES} />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll('.diff-hunk__line').length).toBeGreaterThan(0);
    }, { timeout: 5000 });
    expect(await axe(container)).toHaveNoViolations();
  });
});
