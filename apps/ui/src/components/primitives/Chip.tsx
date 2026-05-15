import type { CSSProperties, ReactNode } from 'react';
import './Chip.css';

/**
 * <Chip> — generic chip parent (B3 §15.2 #3).
 *
 * Status-tinted compact label. `<Risk>` extends this conceptually but renders
 * directly to keep the SVG glyph layout tight.
 */

export type ChipTone = 'neutral' | 'accent' | 'low' | 'med' | 'high' | 'crit';

export interface ChipProps {
  tone?: ChipTone;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /**
   * F-A11Y-1: when the Chip is the visible label inside an interactive
   * parent (e.g. a button with its own aria-label), pass `aria-hidden`
   * to suppress the duplicate SR announcement.
   */
  'aria-hidden'?: boolean | 'true' | 'false';
}

export function Chip({
  tone = 'neutral',
  children,
  className,
  style,
  'aria-hidden': ariaHidden,
}: ChipProps) {
  const classes = ['chip', `chip--${tone}`, 'type-mono-sm', className].filter(Boolean).join(' ');
  return (
    <span className={classes} style={style} aria-hidden={ariaHidden}>
      {children}
    </span>
  );
}
