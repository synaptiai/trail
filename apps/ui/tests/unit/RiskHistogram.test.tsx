import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { RiskHistogram } from '@/components/screens/RiskHistogram';

/**
 * Per N15 lesson: tests must verify the actual contract (WCAG 2.1 1.4.1
 * triple-redundancy: color + glyph + label all independently legible),
 * not just smoke. The histogram's role is to scale to any claim count
 * while preserving the encoding contract — these tests pin both.
 */
describe('<RiskHistogram>', () => {
  const HISTOGRAM_NORMAL = { low: 7, med: 3, high: 1, crit: 0, classified_total: 11 };

  it('exposes role="img" with a verbose aria-label including all four counts', () => {
    render(<RiskHistogram histogram={HISTOGRAM_NORMAL} />);
    const img = screen.getByRole('img');
    const ariaLabel = img.getAttribute('aria-label') ?? '';
    expect(ariaLabel).toBe('Risk distribution: 7 low, 3 medium, 1 high, 0 critical');
  });

  it('renders four bars regardless of which counts are zero (consistent four-bin structure)', () => {
    const { container } = render(<RiskHistogram histogram={HISTOGRAM_NORMAL} />);
    const bins = container.querySelectorAll('.risk-histogram__bin');
    expect(bins).toHaveLength(4);
    const levels = Array.from(bins).map((b) => b.getAttribute('data-level'));
    expect(levels).toEqual(['low', 'med', 'high', 'crit']);
  });

  it('triple-redundancy contract: every bin renders glyph (svg) AND label AND count', () => {
    const { container } = render(<RiskHistogram histogram={HISTOGRAM_NORMAL} />);
    const bins = container.querySelectorAll('.risk-histogram__bin');
    bins.forEach((bin) => {
      // Glyph leg — inline SVG (defense-in-depth against font tamper)
      const svg = bin.querySelector('svg');
      expect(svg).not.toBeNull();
      // Label leg — Commit Mono uppercase short label
      const label = bin.querySelector('.risk-histogram__label');
      expect(label).not.toBeNull();
      expect(label?.textContent).toMatch(/^(LOW|MED|HIGH|CRIT)$/);
      // Count leg — tabular numeric count
      const count = bin.querySelector('.risk-histogram__count');
      expect(count).not.toBeNull();
      expect(count?.textContent).toMatch(/^\d+$/);
    });
  });

  it('all-zero histogram still renders four bars (empty-bin hairline placeholder)', () => {
    const allZero = { low: 0, med: 0, high: 0, crit: 0, classified_total: 0 };
    const { container } = render(<RiskHistogram histogram={allZero} />);
    const bins = container.querySelectorAll('.risk-histogram__bin');
    expect(bins).toHaveLength(4);
    // Bar fills must be 0% so the hairline track shows through.
    const fills = container.querySelectorAll('.risk-histogram__fill');
    fills.forEach((f) => {
      const style = (f as HTMLElement).style.getPropertyValue('--bar-fill-pct');
      expect(style).toBe('0%');
    });
  });

  it('bar widths scale to the largest count (max=100%, others proportional)', () => {
    render(<RiskHistogram histogram={HISTOGRAM_NORMAL} />);
    // max is 7 (low). low → 100%, med (3) → ~42.86%, high (1) → ~14.29%, crit (0) → 0%
    const lowFill = document.querySelector(
      '.risk-histogram__bin--low .risk-histogram__fill',
    ) as HTMLElement;
    const medFill = document.querySelector(
      '.risk-histogram__bin--med .risk-histogram__fill',
    ) as HTMLElement;
    expect(lowFill.style.getPropertyValue('--bar-fill-pct')).toBe('100%');
    // floats — assert prefix to avoid locale rounding flake
    expect(medFill.style.getPropertyValue('--bar-fill-pct')).toMatch(/^42\.85/);
  });

  it('counts in the aria-label match the per-bin counts (dual-source consistency)', () => {
    const h = { low: 5, med: 10, high: 2, crit: 1, classified_total: 18 };
    render(<RiskHistogram histogram={h} />);
    const ariaLabel = screen.getByRole('img').getAttribute('aria-label') ?? '';
    expect(ariaLabel).toContain('5 low');
    expect(ariaLabel).toContain('10 medium');
    expect(ariaLabel).toContain('2 high');
    expect(ariaLabel).toContain('1 critical');
  });

  it('passes axe-core a11y scan', async () => {
    const { container } = render(<RiskHistogram histogram={HISTOGRAM_NORMAL} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
