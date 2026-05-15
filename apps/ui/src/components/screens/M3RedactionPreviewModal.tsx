import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Modal } from '@/components/primitives';
import { invoke } from '@/ipc/client';
import type { Persona } from '@/ipc/contract';
import { previewRedactedResponseSchema } from '@/ipc/contract';
import './M3RedactionPreviewModal.css';

/**
 * <M3RedactionPreviewModal> — Sprint 4 (gh#11 criterion 6).
 *
 * Two-stage redaction-preview gating per B6 P1:
 *
 *   Stage 1 (Preview):  shows the masked value + a 30-second countdown.
 *                       The "Confirm publish" button is DISABLED for the
 *                       full timer window. The user MUST wait — there is
 *                       no bypass affordance.
 *   Stage 2 (Confirm):  enabled after the timer expires. The action
 *                       publishes the redaction acknowledgment to the
 *                       audit log. Original VALUE is never returned in
 *                       v0.1 (per security trust contract — capture
 *                       writes redacted YAML only; nothing on disk to
 *                       preview).
 *
 * Per B5 §6.2, M3 sets `window.__trailInRedactionPreview = true` for the
 * lifetime of the modal so the global clipboard.writeText wrapper rejects
 * any copy attempt. The flag clears in cleanup.
 */
export interface M3RedactionPreviewModalProps {
  open: boolean;
  onClose: () => void;
  packetId: string;
  redactionId: string;
  /** Redaction marker as displayed (e.g., `[REDACTED:openai-key]`). */
  marker: string;
  /**
   * Cycle-4.5 W2 (PR #21): persona threading on audit_log_append. The
   * Rust handler rejects auditor with PersonaForbidden. Required so a
   * missing prop fails type-checking.
   */
  persona: Persona;
  /** Test override: skip the 30s timer (drives the green path). */
  initialSecondsRemaining?: number;
  /** Test override: stub the IPC call. */
  fetchOriginal?: () => Promise<{ original: string | null }>;
}

const TIMER_SECONDS = 30;

declare global {
  interface Window {
    __trailInRedactionPreview?: boolean;
  }
}

export function M3RedactionPreviewModal({
  open,
  onClose,
  packetId,
  redactionId,
  marker,
  persona,
  initialSecondsRemaining,
  fetchOriginal,
}: M3RedactionPreviewModalProps) {
  const [seconds, setSeconds] = useState<number>(
    initialSecondsRemaining ?? TIMER_SECONDS,
  );
  const [original, setOriginal] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<boolean>(false);

  // Set the global clipboard-block flag for the modal lifetime.
  useEffect(() => {
    if (!open) return;
    const prev = window.__trailInRedactionPreview ?? false;
    window.__trailInRedactionPreview = true;
    return () => {
      window.__trailInRedactionPreview = prev;
    };
  }, [open]);

  // Countdown.
  useEffect(() => {
    if (!open || confirmed) return;
    if (seconds <= 0) return;
    const id = setTimeout(() => {
      setSeconds((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearTimeout(id);
  }, [open, seconds, confirmed]);

  // Fetch the (always-null in v0.1) original value.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError(null);
    setOriginal(null);
    const loader = fetchOriginal
      ? fetchOriginal()
      : invoke<unknown>('preview_redacted', {
          packet_id: packetId,
          redaction_id: redactionId,
        }).then((raw) => previewRedactedResponseSchema.parse(raw));
    loader
      .then((res) => {
        if (cancelled) return;
        setOriginal(res.original ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Preview unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [open, packetId, redactionId, fetchOriginal]);

  const handleConfirm = useCallback(() => {
    if (seconds > 0) return;
    setConfirmed(true);
    invoke('audit_log_append', {
      event_type: 'tamper_re_verified',
      packet_id: packetId,
      details: { redaction_id: redactionId, action: 'preview-confirmed' },
      // Cycle-4.5 W2 (PR #21): persona threading.
      persona,
    }).catch((e: unknown) => {
      console.warn('[Trail] M3 audit append failed:', e);
    });
  }, [seconds, packetId, redactionId, persona]);

  const canConfirm = seconds <= 0 && !confirmed;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Preview redacted value"
      subtitle="Review before publishing — copy is disabled inside this modal."
      size="md"
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="md"
            disabled={!canConfirm}
            onClick={handleConfirm}
            aria-disabled={!canConfirm}
          >
            {confirmed
              ? 'Acknowledged'
              : seconds > 0
                ? `Confirm publish (${seconds}s)`
                : 'Confirm publish'}
          </Button>
        </>
      }
    >
      <div className="m3__panel" data-testid="m3-panel">
        <div className="m3__row">
          <span className="m3__label type-ui">Redaction marker</span>
          <code className="m3__marker type-mono-sm">{marker}</code>
        </div>
        <div className="m3__row">
          <span className="m3__label type-ui">Original</span>
          {loadError ? (
            <Banner tone="warning" title="Preview unavailable">
              {loadError}
            </Banner>
          ) : original === null ? (
            <Banner tone="info" title="Original not retained on disk">
              Trail's capture pipeline writes redacted YAML only. The original
              value was never persisted; preview shows the marker shape only.
            </Banner>
          ) : (
            <code className="m3__original type-mono-sm" aria-live="polite">
              {original}
            </code>
          )}
        </div>
        {!confirmed ? (
          <p className="m3__notice type-body-sm" role="status">
            {seconds > 0
              ? `You can confirm in ${seconds} seconds. Use this time to verify the redaction is intentional.`
              : 'You can now confirm publication. This appends a tamper_re_verified audit event.'}
          </p>
        ) : (
          <p className="m3__notice m3__notice--confirmed type-body-sm" role="status">
            Acknowledged. The audit log records this preview.
          </p>
        )}
      </div>
    </Modal>
  );
}
