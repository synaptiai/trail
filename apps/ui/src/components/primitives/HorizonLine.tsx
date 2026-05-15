import type { CSSProperties } from 'react';
import './HorizonLine.css';

/**
 * <HorizonLine> — Trail's signature 1px copper motif.
 *
 * Six variants per B3 §10.7:
 *   app-chrome              — full-width, top of app window
 *   packet-header           — under packet title; pairs with <RiskHistogram>
 *   sidebar-divider         — between brand and timeline in trail browser
 *   override-stack-vertical — left rule connecting M1 three-row override stack
 *   first-run-hero          — animated inscribe-in once on first render
 *   timeline-rail-vertical  — trail browser timeline rail
 *
 * Animation policy (B3 §10.6): static by default; `animateOnce` triggers the
 * inscribe-in motion. Reduced-motion forces final state regardless.
 */

export type HorizonVariant =
  | 'app-chrome'
  | 'packet-header'
  | 'sidebar-divider'
  | 'override-stack-vertical'
  | 'first-run-hero'
  | 'timeline-rail-vertical';

export interface HorizonLineProps {
  variant: HorizonVariant;
  /** Trigger a one-time inscribe-in animation (first-run-hero by default). */
  animateOnce?: boolean;
  className?: string;
  style?: CSSProperties;
  /** ARIA: horizon is decorative by default; supply `aria-label` to opt in. */
  'aria-label'?: string;
}

export function HorizonLine({
  variant,
  animateOnce,
  className,
  style,
  'aria-label': ariaLabel,
}: HorizonLineProps) {
  const shouldAnimate = animateOnce ?? variant === 'first-run-hero';
  const classes = [
    'horizon',
    `horizon--${variant}`,
    shouldAnimate ? 'motion-horizon-inscribe' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const role = ariaLabel ? 'img' : 'presentation';
  const props: Record<string, unknown> = { className, role };
  return (
    <span
      className={classes}
      style={style}
      role={role}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : { 'aria-hidden': true })}
    />
  );
}
