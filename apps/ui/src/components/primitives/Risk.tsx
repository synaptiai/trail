import type { CSSProperties, ReactNode } from 'react';
import type { RiskLevel } from '@/design';
import './Risk.css';

/**
 * <Risk> primitive.
 *
 * Triple-redundant encoding per WCAG 2.1 1.4.1 (B3 §4):
 *   color  — risk pigment (sage / mustard / terracotta / oxblood)
 *   glyph  — inline SVG (◯ / ◐ / ● / ⨂) — defense-in-depth against font tamper
 *   label  — Commit Mono uppercase 4-char string (LOW / MED / HIGH / CRIT)
 *
 * Variants:
 *   chip — bordered, padded chip with bg tint (B3 §4.2)
 *   dot  — compact glyph + label only (B3 §4.3)
 *
 * Accessibility:
 *   role="img" with aria-label="Risk level: <level>" so screen readers say
 *   "Risk level: high" not "filled circle high" (B3 §12.5).
 */

export type RiskVariant = 'chip' | 'dot';

export interface RiskProps {
  level: RiskLevel;
  variant?: RiskVariant;
  /** Optional label override; defaults to upper-case level. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

const LEVEL_LABEL: Record<RiskLevel, string> = {
  low: 'LOW',
  med: 'MED',
  high: 'HIGH',
  crit: 'CRIT',
};

const LEVEL_NAME: Record<RiskLevel, string> = {
  low: 'low',
  med: 'medium',
  high: 'high',
  crit: 'critical',
};

/**
 * Inline SVG glyphs — defense-in-depth against font tamper (B3 §15.1 finding 3).
 * The SVG bodies are duplicated here from `apps/ui/src/design/glyphs/*.svg` so
 * the component renders correctly whether or not a vite SVG-as-React plugin is
 * configured. The .svg files in /glyphs/ remain the design source-of-truth for
 * any consumer that needs a standalone asset.
 */
const Glyph = ({ level }: { level: RiskLevel }): ReactNode => {
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
          {/* Strokes use --bg via CSS so the X reads as a punched-out cross
              against the filled circle, regardless of theme. The Risk.css
              `.risk--crit .risk__glyph svg line` selector wires this. */}
          <line x1="3.2" y1="3.2" x2="12.8" y2="12.8" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="12.8" y1="3.2" x2="3.2" y2="12.8" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
  }
};

export function Risk({ level, variant = 'chip', label, className, style }: RiskProps) {
  const display = label ?? LEVEL_LABEL[level];
  const ariaLabel = `Risk level: ${LEVEL_NAME[level]}`;
  const classes = ['risk', `risk--${variant}`, `risk--${level}`, className].filter(Boolean).join(' ');
  return (
    <span role="img" aria-label={ariaLabel} className={classes} style={style}>
      <span className="risk__glyph" aria-hidden="true">
        <Glyph level={level} />
      </span>
      <span className="risk__label type-mono-sm">{display}</span>
    </span>
  );
}
