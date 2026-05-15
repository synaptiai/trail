import { Banner, Button } from '@/components/primitives';
import './EdgeFlowBanner.css';

/**
 * <EdgeFlowBanner> — Sprint 5 (gh#12 AC-8): one-component switch for the
 * seven edge flows the post-to-PR + decide-on-PR pipelines surface to
 * the UI. Each kind has distinct copy and a distinct recovery action,
 * mirrored verbatim from B2 §6:
 *
 *   E1 — corrupt packet           : packet YAML schema-failed; offer
 *                                    "Open in editor" + "Re-capture"
 *   E2 — missing fixture          : packet YAML missing on disk; offer
 *                                    "Reload" / "Re-capture"
 *   E3 — libSQL out-of-sync       : last_known_hash drifted; offer
 *                                    "Re-verify and re-hash" (via the
 *                                    existing J12 dismiss flow)
 *   E4 — gh CLI absent            : install gh; offer "Open install
 *                                    instructions"
 *   E5 — gh auth expired          : same as E3 (gh-auth) → triggers M2
 *   E6 — network failure mid-post : retry; offer "Retry"
 *   E7 — concurrent edit          : stale local state; offer "Reload
 *                                    packet"
 *
 * Cycle-1.5 F4 (gh#12 AC-7): split previous `not-found` collapse into
 * `pr-not-found` (gh CLI exit 9 — branch has no associated PR) and
 * `packet-not-found` (exit 2 — local packet YAML missing on disk).
 * Each surfaces distinct copy + a distinct recovery action so the user
 * is not told "PR not found" when their packet is the one missing.
 *
 * Each kind always has a recovery action — no dead-end Banners. The
 * onRecover callback is supplied by the parent (PacketView typically).
 */

export type EdgeFlowKind =
  | 'corrupt-packet' // E1
  | 'missing-fixture' // E2
  | 'libsql-out-of-sync' // E3
  | 'gh-cli-absent' // E4
  | 'gh-auth-expired' // E5
  | 'network-failure-mid-post' // E6
  | 'concurrent-edit' // E7
  | 'pr-not-found' // AC-7: gh exit 9 — no PR associated with the branch
  | 'packet-not-found'; // AC-7: gh exit 2 — local packet YAML missing

export interface EdgeFlowBannerProps {
  kind: EdgeFlowKind;
  /** Optional inline detail (e.g. stderr or yaml path). */
  detail?: string | null;
  onRecover: () => void;
  /** When supplied, renders a secondary Dismiss button. */
  onDismiss?: () => void;
}

interface EdgeFlowCopy {
  title: string;
  body: string;
  recoveryLabel: string;
  /**
   * Banner tone. 'alert' for security/auth-affecting (red); 'warning'
   * for recoverable-but-attention (mustard); 'info' for informational.
   * The Banner primitive accepts info|warning|alert.
   */
  tone: 'alert' | 'warning' | 'info';
}

const COPY: Record<EdgeFlowKind, EdgeFlowCopy> = {
  'corrupt-packet': {
    title: 'Packet failed schema validation',
    body: 'The packet YAML did not validate against the v0.1 schema. Re-capture the session, or open the YAML in your editor to inspect.',
    // Cycle-4.5 W8 (PR #21): the action wired to onRecover is
    // `reloadPacket()`, NOT a re-capture flow. The Banner copy still
    // mentions re-capture as a remediation strategy, but the BUTTON
    // label must accurately describe what the click does — pressing
    // "Re-capture" but actually firing reload was a UX honesty bug.
    // v0.2 may add a true re-capture affordance (would need to call
    // the capture CLI bridge); until then, keep the label aligned to
    // the actual action.
    recoveryLabel: 'Reload',
    tone: 'alert',
  },
  'missing-fixture': {
    title: 'Packet YAML missing on disk',
    body: 'The expected packet YAML could not be read. The watcher or libSQL row references a path that no longer exists. Reload to re-scan.',
    recoveryLabel: 'Reload',
    tone: 'warning',
  },
  'libsql-out-of-sync': {
    title: 'Trail index drifted from packet on disk',
    body: 'The libSQL last_known_hash and the YAML approval_trail block do not match. Re-verify and re-hash, or dismiss after inspection.',
    recoveryLabel: 'Re-verify',
    tone: 'alert',
  },
  'gh-cli-absent': {
    title: 'GitHub CLI not installed',
    body: 'Install the gh CLI from https://cli.github.com/ and retry. Trail uses gh as its sole network egress.',
    recoveryLabel: 'Open install instructions',
    tone: 'alert',
  },
  'gh-auth-expired': {
    title: 'GitHub authentication expired',
    body: 'The gh CLI session is no longer valid. Run `gh auth login` in your terminal, then retry.',
    recoveryLabel: 'Open auth modal',
    tone: 'alert',
  },
  'network-failure-mid-post': {
    title: 'Network failure mid-post',
    body: 'Could not reach GitHub. Check connectivity and retry; the packet was not modified.',
    recoveryLabel: 'Retry',
    tone: 'alert',
  },
  'concurrent-edit': {
    title: 'Packet changed under us',
    body: 'The local packet record could not be updated because another process modified it. Reload to see the latest state.',
    recoveryLabel: 'Reload packet',
    tone: 'alert',
  },
  'pr-not-found': {
    title: 'Pull request not found',
    body: 'No PR was detected for the current branch, or the specified PR number does not exist in this repository. Specify a PR number explicitly or open a PR for this branch.',
    recoveryLabel: 'Specify PR number',
    tone: 'alert',
  },
  'packet-not-found': {
    title: 'Packet not found on disk',
    body: 'The local packet YAML could not be located. The watcher or libSQL row references a path that no longer exists. Reload to re-scan, or re-capture the session.',
    recoveryLabel: 'Reload',
    tone: 'warning',
  },
};

export function EdgeFlowBanner({
  kind,
  detail,
  onRecover,
  onDismiss,
}: EdgeFlowBannerProps) {
  const copy = COPY[kind];
  return (
    <div data-testid={`edge-flow-${kind}`} data-edge-flow-kind={kind}>
      <Banner
        tone={copy.tone}
        title={copy.title}
        action={
          <div className="edge-flow__actions">
            {onDismiss ? (
              <Button variant="secondary" size="sm" onClick={onDismiss}>
                Dismiss
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              onClick={onRecover}
              data-testid={`edge-flow-${kind}-recover`}
            >
              {copy.recoveryLabel}
            </Button>
          </div>
        }
      >
        <p className="edge-flow__body type-body-sm">{copy.body}</p>
        {detail ? (
          <pre
            className="edge-flow__detail type-mono-sm"
            data-testid={`edge-flow-${kind}-detail`}
          >
            {detail}
          </pre>
        ) : null}
      </Banner>
    </div>
  );
}
