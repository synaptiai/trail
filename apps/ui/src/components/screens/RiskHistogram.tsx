import './RiskHistogram.css';
import type { RiskHistogramShape, RiskLevel } from '@/services/packet-loader';

/**
 * <RiskHistogram> (B3 §4.3.1 / B4 §4.2 / gh#9 criterion 2).
 *
 * Aggregate-context risk encoding pattern. Renders four bars (LOW · MED ·
 * HIGH · CRIT) with WCAG 2.1 1.4.1 triple-redundancy:
 *
 *   1. **Color** — copper-accent height + per-level pigment (sage / mustard /
 *      terracotta / oxblood) tinted via `--risk-{low,med,high,crit}` tokens.
 *   2. **Glyph** — inline SVG (◯ ◐ ● ⨂) duplicated from the Risk primitive
 *      so the histogram is a defensible standalone consumer (B3 §15.1 finding 3).
 *   3. **Count label** — Commit Mono uppercase 4-char level + count, both
 *      independently legible. The label is the 'last leg of the tripod' —
 *      a dead font, lost glyph, or color-blind viewer all still read the
 *      level via the label alone.
 *
 * Empty bins (zero count) render as a 1px hairline placeholder so the
 * four-bin structure is consistent across every packet (B3 §4.3.1).
 *
 * ARIA: the row is `<div role="img" aria-label="Risk distribution: 7 low,
 * 3 medium, 1 high, 0 critical">`. The aria-label MUST stay verbose enough
 * that a screen-reader user gets the same five facts (counts × levels) a
 * sighted user gets at a glance — short labels like "Risks: 7/3/1/0" hide
 * which slot is which. N15 lesson: tests assert the label includes all
 * four counts AND all four level names independently.
 */
export interface RiskHistogramProps {
  histogram: RiskHistogramShape;
  /** When provided, hovering / focusing a bar invokes this with the level —
   *  the Sprint 3a use case is "highlight matching claim rows" (B4 §4.2 'cross-region link');
   *  Sprint 3b will wire that. The handler is optional so the component
   *  remains usable in static contexts (Storybook / audit-mode read-only). */
  onHoverLevel?: (level: RiskLevel | null) => void;
}

const LEVELS: ReadonlyArray<{ key: RiskLevel; label: string; verbal: string }> = [
  { key: 'low', label: 'LOW', verbal: 'low' },
  { key: 'med', label: 'MED', verbal: 'medium' },
  { key: 'high', label: 'HIGH', verbal: 'high' },
  { key: 'crit', label: 'CRIT', verbal: 'critical' },
];

const Glyph = ({ level }: { level: RiskLevel }) => {
  const sharedProps = {
    width: '100%',
    height: '100%',
    viewBox: '0 0 16 16',
    'aria-hidden': true,
    focusable: false as const,
    xmlns: 'http://www.w3.org/2000/svg',
  };
  switch (level) {
    case 'low':
      return (
        <svg {...sharedProps} fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case 'med':
      return (
        <svg {...sharedProps} fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 2a6 6 0 0 1 0 12 V 2 z" fill="currentColor" />
        </svg>
      );
    case 'high':
      return (
        <svg {...sharedProps} fill="currentColor">
          <circle cx="8" cy="8" r="6" />
        </svg>
      );
    case 'crit':
      return (
        <svg {...sharedProps} fill="none">
          <circle cx="8" cy="8" r="6" fill="currentColor" />
          <line
            x1="3.2"
            y1="3.2"
            x2="12.8"
            y2="12.8"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="12.8"
            y1="3.2"
            x2="3.2"
            y2="12.8"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
  }
};

export function RiskHistogram({ histogram, onHoverLevel }: RiskHistogramProps) {
  const max = Math.max(histogram.low, histogram.med, histogram.high, histogram.crit);
  // The verbal aria-label includes EVERY count + level pair — this is the
  // independent third leg of the redundancy contract for screen readers.
  const ariaLabel =
    `Risk distribution: ${histogram.low} low, ${histogram.med} medium, ` +
    `${histogram.high} high, ${histogram.crit} critical`;

  return (
    <div className="risk-histogram" role="img" aria-label={ariaLabel}>
      {LEVELS.map(({ key, label, verbal }) => {
        const count = histogram[key];
        // Bar fill width as a percentage of the max bar; 0 → 0%, max → 100%.
        // Empty bins still render the hairline track so the four-bin layout
        // is preserved per B3 §4.3.1.
        const fillPct = max === 0 ? 0 : (count / max) * 100;
        return (
          <div
            key={key}
            className={`risk-histogram__bin risk-histogram__bin--${key}`}
            data-count={count}
            data-level={key}
            // Hover-to-highlight cross-region link is wired in Sprint 3b
            // (B4 §4.2 — hover on bar highlights matching claim rows). The
            // bins are non-interactive divs in Sprint 3a so onFocus/onBlur
            // are intentionally NOT registered (cycle-1 P9: dead handlers
            // on non-tabIndex'd elements never fire). Keyboard cross-region
            // link will require either tabIndex on the bins or a separate
            // arrow-key handler at the histogram parent — Sprint 3b call.
            onMouseEnter={onHoverLevel ? () => onHoverLevel(key) : undefined}
            onMouseLeave={onHoverLevel ? () => onHoverLevel(null) : undefined}
            // Per-bin aria reinforces the count, but the parent role=img
            // carries the canonical announce; bins are decorative children
            // marked aria-hidden so the screen reader doesn't double-speak.
            aria-hidden="true"
          >
            <div className="risk-histogram__track">
              <div
                className="risk-histogram__fill"
                style={{ '--bar-fill-pct': `${fillPct}%` } as React.CSSProperties}
              />
            </div>
            <div className="risk-histogram__caption">
              <span className="risk-histogram__glyph" data-verbal={verbal}>
                <Glyph level={key} />
              </span>
              <span className="risk-histogram__label type-mono-sm">{label}</span>
              <span className="risk-histogram__count type-mono-sm tabular-nums">{count}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
