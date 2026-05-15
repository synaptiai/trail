import { useCallback, useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import './Modal.css';

/**
 * <Modal> primitive (B3 §15.2 #7, B4 modals M1-M6).
 *
 * Implements:
 *   - WAI-ARIA dialog pattern: role="dialog", aria-modal="true",
 *     aria-labelledby points at the header.
 *   - Focus-trap: Tab/Shift+Tab cycles within the modal's focusable elements.
 *   - Initial focus: first focusable child, falling back to the dialog itself.
 *   - Restore focus on close to the element that was focused when opened.
 *   - Escape closes (unless dismissible={false}).
 *   - Backdrop click closes when dismissible.
 *
 * Sizes map to the layout scale:
 *   sm — --size-modal-sm (480px)  — M1, M2, M4, M5
 *   md — --size-modal-md (640px)  — M3 stage 2
 *   lg — --size-modal-lg (720px)  — M6 settings
 */

export type ModalSize = 'sm' | 'md' | 'lg';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Optional subtitle below the title. */
  subtitle?: ReactNode;
  size?: ModalSize;
  /** When false, escape and backdrop click do not close. Default true. */
  dismissible?: boolean;
  /** Footer slot for action buttons. */
  footer?: ReactNode;
  children?: ReactNode;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = 'sm',
  dismissible = true,
  footer,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  /**
   * Cached focusables list (per PR #6 cycle-1 review F18 — P3 performance).
   * Refreshed on open AND whenever the dialog subtree mutates (children
   * appear/disappear/disable). Avoids re-walking the DOM on every Tab keydown
   * — relevant for M6 (settings) where the modal content is dense.
   */
  const focusablesRef = useRef<HTMLElement[]>([]);

  const refreshFocusables = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      focusablesRef.current = [];
      return;
    }
    focusablesRef.current = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
  }, []);

  // Restore focus on close + initial focus on open + body scroll lock.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog) {
      refreshFocusables();
      const first = focusablesRef.current[0];
      if (first) first.focus();
      else dialog.focus();
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Refresh focusables when the modal content tree mutates so disabled
    // toggles, conditionally-rendered fields, etc. update the trap range.
    let observer: MutationObserver | null = null;
    if (dialog && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(() => refreshFocusables());
      // Cycle-2 N11: include `type` and `contenteditable` so dynamic input-type
      // changes (e.g., a hidden→text toggle inside a modal form) refresh the
      // focusables cache. The previous filter caught disabled/tabindex/href
      // but missed inputs whose role-as-focusable depends on `type`.
      observer.observe(dialog, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'tabindex', 'href', 'type', 'contenteditable'],
      });
    }
    return () => {
      observer?.disconnect();
      document.body.style.overflow = previousOverflow;
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, refreshFocusables]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && dismissible) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = focusablesRef.current;
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [dismissible, onClose],
  );

  const handleBackdropClick = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  // Per-instance unique IDs (cycle-1.5 F8 fix). React's `useId()` produces a
  // namespace-stable identifier across server / client renders so two
  // <Modal>s mounted simultaneously (e.g., M5 + M6 stacked when the chrome
  // cog stays clickable behind M5) do not produce duplicate `id="modal-title"`
  // / `id="modal-subtitle"` collisions in the DOM. The aria-labelledby /
  // aria-describedby references hop along automatically because they are
  // scoped to this hook output.
  //
  // Hooks must run unconditionally — call useId() before the early-return
  // guard so the call order remains stable.
  const reactId = useId();
  if (!open) return null;

  const titleId = `modal-title-${reactId}`;
  const subtitleId = subtitle ? `modal-subtitle-${reactId}` : undefined;

  return (
    <div className="modal__backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={`modal modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <header className="modal__header">
          <h2 id={titleId} className="modal__title type-h1">
            {title}
          </h2>
          {subtitle ? (
            <p id={subtitleId} className="modal__subtitle type-body-sm">
              {subtitle}
            </p>
          ) : null}
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
