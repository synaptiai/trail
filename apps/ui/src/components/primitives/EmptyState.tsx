import type { ReactNode } from 'react';
import './EmptyState.css';

/**
 * <EmptyState> primitive (B3 §15.2 #13, B6 addition).
 *
 * Standardizes copy hierarchy across screens (sidebar empty, packet view empty,
 * audit-mode empty trail tab). Variants:
 *   compact — small inline card (sidebar pin)
 *   full    — page-level hero (first-run, audit-no-trails)
 */

export type EmptyStateVariant = 'compact' | 'full';

export interface EmptyStateProps {
  variant?: EmptyStateVariant;
  /** Icon slot — typically a Lucide line glyph or custom Trail glyph. */
  icon?: ReactNode;
  headline: string;
  body?: ReactNode;
  /** Action slot (button or link). */
  action?: ReactNode;
}

export function EmptyState({
  variant = 'compact',
  icon,
  headline,
  body,
  action,
}: EmptyStateProps) {
  return (
    <div className={`empty-state empty-state--${variant}`} role="status">
      {icon ? <div className="empty-state__icon" aria-hidden="true">{icon}</div> : null}
      <h3 className="empty-state__headline type-h2">{headline}</h3>
      {body ? <div className="empty-state__body type-body-sm">{body}</div> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
