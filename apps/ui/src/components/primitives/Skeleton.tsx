import type { CSSProperties } from 'react';
import './Skeleton.css';

/**
 * <Skeleton> primitive (B3 §15.2 #12, B6 addition).
 *
 * Single shimmer tone (--surface-raised over --bg) — keeps loading states
 * consistent across screens. Variants:
 *   text  — single line of text (matches body line-height)
 *   block — rectangular block (e.g., card placeholder)
 *   row   — full-width row used inside the trail browser sidebar
 */

export type SkeletonVariant = 'text' | 'block' | 'row';

export interface SkeletonProps {
  variant?: SkeletonVariant;
  /** Width override (CSS length). Defaults: text=80%, block/row=100%. */
  width?: string;
  /** Height override (CSS length). Defaults: text=1em, block=120px, row=44px. */
  height?: string;
  className?: string;
  /** Optional aria-label so SR users hear "Loading <thing>". */
  label?: string;
}

/**
 * Heights map to layout-scale tokens where applicable:
 *   text  → 1em (text line)
 *   block → 6 × --space-5 ≈ 120px placeholder
 *   row   → --size-row-comfortable (44px claim row)
 */
const DEFAULT_HEIGHT: Record<SkeletonVariant, string> = {
  text: '1em',
  block: 'calc(var(--space-5) * 6)',
  row: 'var(--size-row-comfortable)',
};

const DEFAULT_WIDTH: Record<SkeletonVariant, string> = {
  text: '80%',
  block: '100%',
  row: '100%',
};

export function Skeleton({
  variant = 'text',
  width,
  height,
  className,
  label,
}: SkeletonProps) {
  const style: CSSProperties = {
    width: width ?? DEFAULT_WIDTH[variant],
    height: height ?? DEFAULT_HEIGHT[variant],
  };
  const classes = ['skeleton', `skeleton--${variant}`, 'motion-skeleton', className]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={classes}
      style={style}
      role="status"
      aria-live="polite"
      aria-label={label ?? 'Loading'}
    />
  );
}
