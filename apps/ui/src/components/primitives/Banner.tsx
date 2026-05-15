import type { ReactNode } from 'react';
import './Banner.css';

/**
 * <Banner> primitive (B3 §15.2 #8, B4 J12 / E2 / E5 surfaces).
 *
 * Tones:
 *   info     — neutral surface
 *   warning  — mustard (--risk-med); used for J12 tamper detection
 *              (B3 §13 OQ-B3-7 yellow-not-red rationale)
 *   alert    — terracotta (--risk-high); used for E5 heavy-redaction (≥15)
 *
 * ARIA:
 *   role="alert" (assertive)  — alert tone, J12, E5 tamper
 *   role="status" (polite)    — info / warning routine surfaces
 *
 * Reduced-motion semantic preservation (B3 §8.4):
 *   When `aria-live="assertive"` and the user has prefers-reduced-motion,
 *   the pulse animation is suppressed and a `⚠ NEW` chip auto-renders next
 *   to the title to preserve the salience signal. The chip auto-clears via a
 *   parent-controlled `dismissNewBadgeAfterMs` (default 5s).
 */

export type BannerTone = 'info' | 'warning' | 'alert';

export interface BannerProps {
  tone?: BannerTone;
  title: string;
  children?: ReactNode;
  /** When true, applies pulse-warning motion until first user dismiss. */
  pulseOnce?: boolean;
  /**
   * For reduced-motion fallback: when true, renders a "NEW" chip next to the
   * title (B3 §8.4 finding). Auto-cleared by parent after ~5s.
   */
  showNewBadge?: boolean;
  /** Action slot (button or link). */
  action?: ReactNode;
  /** Dismiss handler; renders close affordance when set. */
  onDismiss?: () => void;
}

export function Banner({
  tone = 'info',
  title,
  children,
  pulseOnce,
  showNewBadge,
  action,
  onDismiss,
}: BannerProps) {
  const role = tone === 'alert' ? 'alert' : 'status';
  const ariaLive = tone === 'alert' ? 'assertive' : 'polite';
  const classes = [
    'banner',
    `banner--${tone}`,
    pulseOnce ? 'motion-pulse-warning' : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} role={role} aria-live={ariaLive} data-tone={tone}>
      <div className="banner__content">
        <p className="banner__title type-ui">
          {title}
          {showNewBadge ? (
            <span className="banner__new-badge type-mono-sm" aria-hidden="true">
              {'⚠ NEW'}
            </span>
          ) : null}
        </p>
        {children ? <div className="banner__body type-body-sm">{children}</div> : null}
      </div>
      {action ? <div className="banner__action">{action}</div> : null}
      {onDismiss ? (
        <button
          type="button"
          className="banner__dismiss"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          {'✕'}
        </button>
      ) : null}
    </div>
  );
}
