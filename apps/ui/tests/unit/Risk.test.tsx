import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { Risk } from '@/components/primitives';
import type { RiskLevel } from '@/design';

/**
 * The risk encoding is the highest-leverage a11y surface in Trail.
 * These tests assert the WCAG 2.1 1.4.1 triple-redundancy contract:
 *   - color is set via the level-scoped CSS class
 *   - glyph is rendered via inline SVG (defense-in-depth against font tamper)
 *   - label string is present and uppercase
 *   - role="img" exposes a verbal label that reads "Risk level: <level>"
 */

describe('<Risk>', () => {
  const cases: ReadonlyArray<{ level: RiskLevel; label: string; verbal: string }> = [
    { level: 'low', label: 'LOW', verbal: 'Risk level: low' },
    { level: 'med', label: 'MED', verbal: 'Risk level: medium' },
    { level: 'high', label: 'HIGH', verbal: 'Risk level: high' },
    { level: 'crit', label: 'CRIT', verbal: 'Risk level: critical' },
  ];

  for (const { level, label, verbal } of cases) {
    it(`renders the ${level} chip with all three signals`, () => {
      render(<Risk level={level} variant="chip" />);
      const chip = screen.getByRole('img', { name: verbal });
      expect(chip).toBeInTheDocument();
      expect(chip).toHaveTextContent(label);
      // SVG glyph (defense-in-depth)
      const svg = chip.querySelector('svg');
      expect(svg).not.toBeNull();
      // Color signal: scoped class is present
      expect(chip.className).toContain(`risk--${level}`);
    });

    it(`renders the ${level} dot variant without padding`, () => {
      render(<Risk level={level} variant="dot" />);
      const dot = screen.getByRole('img', { name: verbal });
      expect(dot.className).toContain('risk--dot');
    });
  }

  it('respects custom labels', () => {
    render(<Risk level="high" label="ESC" />);
    expect(screen.getByText('ESC')).toBeInTheDocument();
  });

  // Per PR #6 cycle-1 review F16: invoke axe on the rendered container so
  // the a11y-audited claim in the PR body is exercised by an actual scan,
  // not just an ARIA-attribute-presence assertion.
  it('passes axe-core a11y scan on the chip variant', async () => {
    const { container } = render(<Risk level="high" variant="chip" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
