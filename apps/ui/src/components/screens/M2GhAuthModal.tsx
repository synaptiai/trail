import { useState } from 'react';
import { Banner, Button, Modal } from '@/components/primitives';
import './M2GhAuthModal.css';

/**
 * <M2GhAuthModal> — Sprint 5 (gh#12 AC-1; B4 §7.2; B2 §6.3 E3).
 *
 * Surfaces when `post_to_pr` or `decide_on_pr` returns
 * IpcError.gh-not-authenticated. The user runs `gh auth login` in a
 * terminal, then clicks Retry — the modal calls `onRetry` which the
 * parent (M4 modal or PacketView action surface) invokes the original
 * post/decide IPC again.
 *
 * Why an in-app modal instead of a redirect-to-terminal: B4 §7.2
 * specifies the modal as the recovery path; the user keeps Trail open
 * and re-authenticates externally.
 *
 * The exit-code distinction (AC-1: auth failure vs posting failure)
 * is enforced upstream — Phase 3b CLI exits 3 on auth fail, 1/7 on
 * posting fail — so the M4 modal's catch can branch on
 * IpcError.kind to decide whether to open M2 or surface the relevant
 * E1-E7 Banner inline.
 */

export interface M2GhAuthModalProps {
  open: boolean;
  onClose: () => void;
  /** Called when user clicks Retry. Parent re-invokes the failed IPC. */
  onRetry: () => Promise<void> | void;
  /** Optional original error message to show inside the modal. */
  errorDetail?: string | null;
}

const GH_LOGIN_CMD = 'gh auth login';

export function M2GhAuthModal({
  open,
  onClose,
  onRetry,
  errorDetail,
}: M2GhAuthModalProps) {
  const [retrying, setRetrying] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const handleCopy = async () => {
    try {
      // navigator.clipboard.writeText is the WebView clipboard API.
      // In the Tauri shell + browser test env it works; in offline
      // dev it may reject — we ignore failures (user can copy manually).
      await navigator.clipboard?.writeText(GH_LOGIN_CMD);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // Cycle-3 ERR-9 (PR #21): the empty catch swallowed every
      // clipboard failure (sandboxed dev, missing clipboard plugin,
      // user-denied permission prompt). The fallback ("user can
      // select-copy from the code block") is still the operative
      // recovery path; log at debug level so a developer
      // investigating "Copy button does nothing" sees the underlying
      // reason in DevTools without burdening end users with a toast.
      console.debug('[Trail] M2 copy failed (clipboard unavailable):', err);
    }
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="GitHub authentication required"
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose} disabled={retrying}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleRetry}
            disabled={retrying}
            data-testid="m2-retry"
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        </>
      }
    >
      <p className="m2__lede type-body-sm">
        Trail uses the GitHub CLI (<code className="type-mono-sm">gh</code>) to
        post packet markdown to your PR. The CLI is not authenticated.
      </p>
      <div className="m2__cmd-row">
        <pre className="m2__cmd type-mono-sm" aria-label="Run this command in your terminal">
          {GH_LOGIN_CMD}
        </pre>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleCopy}
          aria-label="Copy command"
          data-testid="m2-copy"
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="m2__instruction type-body-sm">
        Run that command in your terminal, finish the OAuth flow in your
        browser, then click <strong>Retry</strong>.
      </p>
      {errorDetail ? (
        <Banner tone="alert" title="Original error">
          <code className="type-mono-sm m2__error-detail" data-testid="m2-error-detail">
            {errorDetail}
          </code>
        </Banner>
      ) : null}
    </Modal>
  );
}
