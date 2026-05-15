import { useState } from 'react';
import { Button, HorizonLine, Modal, Risk } from '@/components/primitives';
import type { RiskLevel } from '@/ipc/contract';
import { submitRiskOverride } from '@/services/saga-client';
import './M1ReviewerModal.css';

/**
 * <M1ReviewerModal> — Sprint 4 (gh#11 criterion 5).
 *
 * Three-row reviewer-mode risk override per B4 §7.1 wireframe:
 *
 *   Row 1 (read-only) Agent's classification + rationale
 *   Row 2 (read-only) Creator's override (if present) — collapses out otherwise
 *   Row 3 (interactive) Reviewer's override + reason field
 *
 * The rows are connected by a vertical `override-stack-vertical` horizon
 * line (B3 §4.4 stacked-dot-with-horizon pattern). When creator did NOT
 * override, only Agent + Reviewer rows render (two rows, one connector
 * segment).
 *
 * Save invokes `submitRiskOverride`, which calls the saga (B5 §3.1) with
 * a `SetRiskOverride` input.
 */

export interface M1ReviewerModalProps {
  open: boolean;
  onClose: () => void;
  packetId: string;
  claimId: string;
  /** Sentence preview of the claim text shown at the top of the modal. */
  claimText: string;
  agentLevel: RiskLevel;
  agentRationale?: string | null;
  /** Creator's override level + reason if any. Null = no creator override. */
  creatorOverride?: {
    level: RiskLevel;
    reason: string | null;
    by: string;
    at: string;
  } | null;
  /** Called after successful save. */
  onSaved?: () => void;
}

const RISK_LEVELS: RiskLevel[] = ['low', 'med', 'high', 'crit'];

export function M1ReviewerModal({
  open,
  onClose,
  packetId,
  claimId,
  claimText,
  agentLevel,
  agentRationale,
  creatorOverride,
  onSaved,
}: M1ReviewerModalProps) {
  const [reviewerLevel, setReviewerLevel] = useState<RiskLevel>(
    creatorOverride?.level ?? agentLevel,
  );
  const [reason, setReason] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const reasonValid = reason.trim().length >= 3;
  const canSave = reasonValid && !submitting;

  const handleSave = async () => {
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitRiskOverride({
        packet_id: packetId,
        claim_id: claimId,
        layer: 'reviewer',
        new_level: reviewerLevel,
        reason,
        // Cycle-3 C4 (PR #21): M1 is the reviewer-only override path
        // (Sprint 4 gh#11 criterion 5); the persona at this surface is
        // always 'reviewer' by construction. The Rust handler still
        // re-validates as defence-in-depth.
        persona: 'reviewer',
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Override risk classification"
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={!canSave}
            onClick={handleSave}
            aria-disabled={!canSave}
          >
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <p className="m1__claim type-body-sm" data-testid="m1-claim-text">
        <span className="m1__claim-label type-ui">Claim:</span> {claimText}
      </p>
      <div className="m1__stack">
        <section className="m1__row m1__row--readonly" aria-labelledby="m1-row-agent">
          <h3 id="m1-row-agent" className="m1__row-title type-ui">
            Agent's classification
          </h3>
          <div className="m1__row-body">
            <Risk variant="chip" level={agentLevel} />
            {agentRationale ? (
              <p className="m1__rationale type-body-sm">{agentRationale}</p>
            ) : null}
          </div>
        </section>
        <HorizonLine variant="override-stack-vertical" aria-label="override history connector" />
        {creatorOverride ? (
          <>
            <section
              className="m1__row m1__row--readonly"
              aria-labelledby="m1-row-creator"
            >
              <h3 id="m1-row-creator" className="m1__row-title type-ui">
                Creator override
              </h3>
              <div className="m1__row-body">
                <Risk variant="chip" level={creatorOverride.level} />
                <span className="m1__meta type-body-sm">
                  by <code className="type-mono-sm">{creatorOverride.by}</code> ·{' '}
                  {creatorOverride.at}
                </span>
                {creatorOverride.reason ? (
                  <p className="m1__rationale type-body-sm">{creatorOverride.reason}</p>
                ) : null}
              </div>
            </section>
            <HorizonLine
              variant="override-stack-vertical"
              aria-label="override history connector"
            />
          </>
        ) : null}
        <section
          className="m1__row m1__row--interactive"
          aria-labelledby="m1-row-reviewer"
        >
          <h3 id="m1-row-reviewer" className="m1__row-title type-ui">
            Your override
          </h3>
          <fieldset className="m1__radios">
            <legend className="sr-only">Risk level</legend>
            {RISK_LEVELS.map((lvl) => (
              <label key={lvl} className="m1__radio">
                <input
                  type="radio"
                  name="reviewer-level"
                  value={lvl}
                  checked={reviewerLevel === lvl}
                  onChange={() => setReviewerLevel(lvl)}
                />
                <Risk variant="chip" level={lvl} />
              </label>
            ))}
          </fieldset>
          <label className="m1__reason">
            <span className="type-ui">
              Reason <span className="m1__required">(required, ≥3 chars)</span>
            </span>
            <textarea
              className="m1__reason-field"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={2000}
              aria-invalid={!reasonValid && reason.length > 0}
              data-testid="m1-reason"
            />
          </label>
          {error ? (
            <p className="m1__error type-body-sm" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      </div>
    </Modal>
  );
}
