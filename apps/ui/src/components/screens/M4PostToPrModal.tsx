import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Modal } from '@/components/primitives';
import {
  classifyGhError,
  postToPr,
  type ClassifiedEdgeFlow,
  type PostToPrOutcome,
} from '@/services/gh-post';
import { GH_CLI_INSTALL_URL, openExternalUrl } from '@/services/open-external';
import './M4PostToPrModal.css';

/**
 * <M4PostToPrModal> — Sprint 5 (gh#12 AC-2; B4 §7.4; B6 P1 hardening).
 *
 * Two-stage flow:
 *
 *   Stage 1 (default) — destination confirmation:
 *     "Posting to: synaptiai/trail#432" displayed in big text;
 *     optional PR-number override input; explicit Confirm button.
 *
 *   Stage 2 (after confirm) — posting:
 *     Calls the post_to_pr IPC. On success: shows "Posted to <url>
 *     (body_hash <prefix>)" + Done button. On failure: surfaces an
 *     edge-flow Banner inline (E1-E7 per classifyGhError); for
 *     gh-not-authenticated, the parent should open the M2 auth modal
 *     (the M4 modal stays open under M2 so Retry returns here).
 *
 * Per B6 P1 hardening (AC-2): the destination owner/name MUST be
 * displayed pre-post and require explicit user confirm. The Rust
 * handler always passes --yes to the CLI (which would skip confirm),
 * so this modal IS the confirmation gate. Without it the post fires
 * with no human-in-the-loop check on the remote destination.
 *
 * Re-post (CR-GH-02): the title flips to "Re-post packet to PR" when
 * the packet already has posted_to_pr[] entries; the "previously
 * posted to" line displays the most-recent entry so the user can
 * compare destinations across re-posts (B6 P1 highlight if changed).
 */

export interface M4PostToPrModalProps {
  open: boolean;
  onClose: () => void;
  packetId: string;
  /**
   * Cycle-2 C15 (PR #21): persona threading. The Rust IPC handler
   * gates `post_to_pr` on persona — auditor is rejected with
   * `IpcError::PersonaForbidden`. This prop is required so the M4
   * modal can pass the active persona through to the IPC. The PacketView
   * orchestrator gates the M4 mount on persona !== 'auditor', so this
   * prop is functionally always 'creator' or 'reviewer' in practice;
   * making it required at the type level prevents an accidental
   * undefined slipping through.
   */
  persona: import('@/ipc/contract').Persona;
  /**
   * Destination string ("owner/name#PR") detected from the packet's
   * git context (passed in from parent — typically loaded via the
   * packet record or queried lazily). Optional: when undefined, the
   * modal lets the user supply a PR number first and the destination
   * is then surfaced from the post_to_pr response post-success.
   */
  detectedDestination?: string | null;
  /**
   * The most recent posted_to_pr[] entry — used to drive re-post
   * differentiation per CR-GH-02. Null = first post.
   */
  lastPosted?: {
    pr_url: string;
    pr_number: number;
    posted_at: string;
  } | null;
  /**
   * Called when the post succeeds. Parent reloads the packet so the
   * new posted_to_pr entry surfaces.
   */
  onPosted?: (outcome: PostToPrOutcome) => void;
  /**
   * Called when the post fails with gh-not-authenticated. Parent
   * opens the M2 auth modal; the M4 modal stays open underneath so
   * Retry returns to the destination-confirm view.
   */
  onAuthFailed?: (errorDetail: string) => void;
}

type Stage = 'confirm' | 'posting' | 'success' | 'error';

export function M4PostToPrModal({
  open,
  onClose,
  packetId,
  persona,
  detectedDestination,
  lastPosted,
  onPosted,
  onAuthFailed,
}: M4PostToPrModalProps) {
  const [stage, setStage] = useState<Stage>('confirm');
  const [prNumberInput, setPrNumberInput] = useState<string>('');
  const [outcome, setOutcome] = useState<PostToPrOutcome | null>(null);
  const [edgeFlow, setEdgeFlow] = useState<ClassifiedEdgeFlow | null>(null);
  const [genericError, setGenericError] = useState<string | null>(null);

  // Reset stage when the modal closes/opens (so a re-open doesn't
  // resurface the prior success/error frame).
  useEffect(() => {
    if (open) {
      setStage('confirm');
      setOutcome(null);
      setEdgeFlow(null);
      setGenericError(null);
      setPrNumberInput('');
    }
  }, [open]);

  const isRePost = !!lastPosted;
  const titleText = isRePost ? 'Re-post packet to PR' : 'Post packet to PR';

  const parsedPrNumber = (() => {
    const trimmed = prNumberInput.trim();
    if (trimmed === '') return undefined;
    if (!/^[1-9][0-9]*$/.test(trimmed)) return null; // invalid
    const n = Number.parseInt(trimmed, 10);
    if (n < 1 || n > 2_147_483_647) return null;
    return n;
  })();
  const prNumberInvalid = parsedPrNumber === null;

  const handlePost = useCallback(async () => {
    if (prNumberInvalid) return;
    setStage('posting');
    setEdgeFlow(null);
    setGenericError(null);
    try {
      const result = await postToPr({
        packet_id: packetId,
        persona,
        ...(parsedPrNumber !== undefined ? { pr_number: parsedPrNumber } : {}),
      });
      setOutcome(result);
      setStage('success');
      onPosted?.(result);
    } catch (err) {
      const classified = classifyGhError(err);
      if (classified) {
        setEdgeFlow(classified);
        setStage('error');
        if (classified.triggersAuthModal) {
          onAuthFailed?.(
            (classified.cause as { message?: string }).message ?? 'gh auth failed',
          );
        }
        return;
      }
      setGenericError(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }, [packetId, persona, parsedPrNumber, prNumberInvalid, onPosted, onAuthFailed]);

  const handleRetry = useCallback(() => {
    void handlePost();
  }, [handlePost]);

  const destinationDisplay = (() => {
    if (parsedPrNumber !== undefined && detectedDestination) {
      // Replace the #N at the end of the detected destination with the
      // user's override, if any (e.g. detectedDestination=synaptiai/trail#432
      // and prNumberInput=999 → synaptiai/trail#999).
      const m = detectedDestination.match(/^(.*)#\d+$/);
      if (m) return `${m[1]}#${parsedPrNumber}`;
      return `${detectedDestination} (PR #${parsedPrNumber})`;
    }
    return detectedDestination ?? 'Unknown — gh CLI will detect from current branch';
  })();

  // The destination line uses --risk-med highlighting if it differs
  // from the last-posted PR (B6 P1 hardening — visual cue when a
  // contributor's PR has flipped origin under the user).
  const destinationChanged = (() => {
    if (!lastPosted || !detectedDestination) return false;
    return !detectedDestination.endsWith(`#${lastPosted.pr_number}`);
  })();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={titleText}
      size="sm"
      footer={
        stage === 'confirm' ? (
          <>
            <Button variant="secondary" size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={handlePost}
              disabled={prNumberInvalid}
              data-testid="m4-confirm-post"
            >
              {isRePost ? 'Re-post' : 'Post'}
            </Button>
          </>
        ) : stage === 'posting' ? (
          <Button variant="primary" size="md" disabled>
            Posting…
          </Button>
        ) : stage === 'success' ? (
          <Button
            variant="primary"
            size="md"
            onClick={onClose}
            data-testid="m4-done"
          >
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="md" onClick={onClose}>
              Close
            </Button>
            {/* Cycle-1.5 F11 (gh#12 AC-8): when gh CLI is missing,
                surface a real recovery action — open install
                instructions — instead of a Retry that will fail again.
                Mirrors the EdgeFlowBanner per-kind recovery routing in
                PacketView. */}
            {edgeFlow?.kind === 'gh-missing' ? (
              <Button
                variant="primary"
                size="md"
                onClick={() => void openExternalUrl(GH_CLI_INSTALL_URL)}
                data-testid="m4-open-install-instructions"
              >
                Open install instructions
              </Button>
            ) : (
              <Button
                variant="primary"
                size="md"
                onClick={handleRetry}
                data-testid="m4-retry"
              >
                Retry
              </Button>
            )}
          </>
        )
      }
    >
      {stage === 'confirm' || stage === 'posting' ? (
        <>
          <div
            className={`m4__destination${destinationChanged ? ' m4__destination--changed' : ''}`}
            data-testid="m4-destination"
          >
            <span className="m4__destination-label type-ui">Posting to:</span>{' '}
            <strong className="m4__destination-value type-mono-md">
              {destinationDisplay}
            </strong>
            {destinationChanged ? (
              <span className="m4__destination-warn" aria-label="Destination changed since last post">
                {' '}
                ⚠ destination changed
              </span>
            ) : null}
          </div>
          {lastPosted ? (
            <div className="m4__last-posted type-body-sm" data-testid="m4-last-posted">
              <span className="m4__last-posted-label">Previously posted to:</span>{' '}
              <a
                href={lastPosted.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="type-mono-sm"
              >
                {lastPosted.pr_url}
              </a>{' '}
              <span className="m4__last-posted-at">
                ({new Date(lastPosted.posted_at).toLocaleString()})
              </span>
            </div>
          ) : null}
          <div className="m4__pr-input-row">
            <label className="m4__pr-input-label type-ui" htmlFor="m4-pr-input">
              Or override PR number:
            </label>
            <input
              id="m4-pr-input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="m4__pr-input"
              value={prNumberInput}
              onChange={(e) => setPrNumberInput(e.target.value)}
              placeholder="auto-detect"
              aria-invalid={prNumberInvalid}
              data-testid="m4-pr-input"
              disabled={stage === 'posting'}
            />
          </div>
          {prNumberInvalid ? (
            <p className="m4__pr-input-error type-body-sm" role="alert">
              PR number must be a positive integer.
            </p>
          ) : null}
          <p className="m4__rubric type-body-sm">
            This will replace the Trail-managed section of the PR body
            (delimited by{' '}
            <code className="type-mono-sm">&lt;!-- trail:packet:start --&gt;</code> /
            {' '}
            <code className="type-mono-sm">&lt;!-- trail:packet:end --&gt;</code>).
            Other PR body content is preserved.
          </p>
        </>
      ) : null}
      {stage === 'success' && outcome ? (
        <Banner tone="info" title="Posted successfully">
          <p className="type-body-sm" data-testid="m4-success-detail">
            Posted to{' '}
            {outcome.pr_url ? (
              <a
                href={outcome.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="type-mono-sm"
              >
                {outcome.pr_url}
              </a>
            ) : (
              outcome.destination ?? 'PR'
            )}
            {outcome.body_hash_prefix ? (
              <>
                {' '}
                (body_hash{' '}
                <code className="type-mono-sm">{outcome.body_hash_prefix}…</code>)
              </>
            ) : null}
          </p>
        </Banner>
      ) : null}
      {stage === 'error' && edgeFlow ? (
        <div data-testid="m4-edge-flow">
          <Banner tone="alert" title={edgeFlow.title}>
            <p className="type-body-sm">{edgeFlow.body}</p>
            <p
              className="m4__edge-kind type-mono-sm"
              data-testid={`m4-edge-kind-${edgeFlow.kind}`}
            >
              kind: {edgeFlow.kind}
            </p>
          </Banner>
        </div>
      ) : null}
      {stage === 'error' && genericError && !edgeFlow ? (
        <div data-testid="m4-generic-error">
          <Banner tone="alert" title="Post failed">
            <p className="type-body-sm">{genericError}</p>
          </Banner>
        </div>
      ) : null}
    </Modal>
  );
}
