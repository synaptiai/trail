import type { ReactNode } from 'react';
import './Toast.css';

/**
 * <Toast> primitive (B3 §15.2 #6).
 *
 * Used for J1 step 3 ("New packet captured"), J5 confirmations
 * ("Posted to PR"), error surfaces (T5 "Decision could not be saved"), and
 * font-integrity startup warnings (B3 §15.1).
 *
 * Tones map onto risk pigments: success → low (sage), warning → med (mustard),
 * error → high (terracotta), info → neutral (default text).
 *
 * Live-region pairing is the responsibility of the toast host (a single
 * `<div role="status" aria-live="polite">` mounted near the app shell).
 * Toasts that REPLACE a polite announcement (e.g., decision-saved) update
 * the host's child node so AT only announces the latest. Tamper / saga-error
 * toasts upgrade to assertive via the `tone="error"` host channel.
 */

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface ToastProps {
  tone?: ToastTone;
  title: string;
  description?: ReactNode;
  /** Optional dismiss handler; renders a close button when provided. */
  onDismiss?: () => void;
}

export function Toast({ tone = 'info', title, description, onDismiss }: ToastProps) {
  const classes = ['toast', `toast--${tone}`].join(' ');
  return (
    <div className={classes} data-tone={tone}>
      <div className="toast__content">
        <p className="toast__title type-ui">{title}</p>
        {description ? <div className="toast__description type-body-sm">{description}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          className="toast__dismiss"
          aria-label="Dismiss notification"
          onClick={onDismiss}
        >
          {'✕'}
        </button>
      ) : null}
    </div>
  );
}
