import { useCallback, useEffect, useMemo, useState } from 'react';
import { Banner, Button, Card, EmptyState, Skeleton, Tabs, type TabItem } from '@/components/primitives';
import type { Persona, RiskLevel } from '@/ipc/contract';
import {
  loadPacketViaIpc,
  loadPacketViaFetch,
  type LoadedPacket,
  PacketLoadException,
} from '@/services/packet-loader';
import { submitDecision } from '@/services/saga-client';
import { subscribeFsWatch, type ExternalChangePayload } from '@/services/watcher-events';
import { invoke, IpcInvocationError } from '@/ipc/client';
import { useDecisionShortcuts } from '@/services/decision-shortcuts';
import { PacketHeader } from './PacketHeader';
import { RiskHistogram } from './RiskHistogram';
import { ClaimsTab } from './ClaimsTab';
import { DiffTab } from './DiffTab';
import { RedactionTab } from './RedactionTab';
import { TrailTab } from './TrailTab';
import { RecaptureBanner } from './RecaptureBanner';
import { M1ReviewerModal } from './M1ReviewerModal';
import { M2GhAuthModal } from './M2GhAuthModal';
import { M3RedactionPreviewModal } from './M3RedactionPreviewModal';
import { M4PostToPrModal } from './M4PostToPrModal';
import { M5RecaptureDriftModal } from './M5RecaptureDriftModal';
import { M6SettingsModal } from './M6SettingsModal';
import { KeyboardOverlay } from './KeyboardOverlay';
import { EdgeFlowBanner, type EdgeFlowKind } from './EdgeFlowBanner';
import { postToPr, classifyGhError, type PostToPrOutcome } from '@/services/gh-post';
// Cycle-4.5 W3 (PR #21): openExternalUrl + GH_CLI_INSTALL_URL imports
// were deleted along with the orphaned EdgeFlowBanner block — they
// were only referenced inside that block's onRecover dispatch (M4
// owns its own gh-cli-absent recovery flow now).
import './PacketView.css';

/**
 * <PacketView> (B4 §4) — packet detail surface in three modes.
 *
 * Sprint 4 (gh#11) wires the keystone surface:
 *   - M1 reviewer-mode risk override modal (opens on `r` shortcut or
 *     RecaptureBanner inner action; reviewer mode only).
 *   - M3 redaction-preview modal (opens on click into RedactionTab —
 *     wired via onPreviewClick callback).
 *   - M5 re-capture drift modal (opens from RecaptureBanner click).
 *   - M6 settings modal (currently opened from a top-bar surface
 *     via openSettings; Sprint 4 ships the modal even though the
 *     trigger button is wired in TopBar — see App.tsx).
 *   - KeyboardOverlay shell (`?` shortcut from anywhere in the app).
 *   - J12 tamper banner (subscribes to packet-changed-externally event;
 *     ARIA-alert + audit_log_append on dismiss).
 *   - Decision shortcuts (a/c/b/r/j/k/n/p/Shift+A) routed through the
 *     ClaimsTab focus controller.
 */

const DEFAULT_TAB: Record<Persona, string> = {
  creator: 'claims',
  reviewer: 'claims',
  auditor: 'trail',
};

function buildTabs(redactionCount: number): TabItem[] {
  return [
    { id: 'claims', label: 'Claims' },
    { id: 'diff', label: 'Diff' },
    {
      id: 'redaction',
      label: redactionCount > 0 ? `Redaction (${redactionCount})` : 'Redaction',
    },
    { id: 'trail', label: 'Trail' },
  ];
}

export interface PacketViewProps {
  packetId: string;
  persona: Persona;
  fixtureUrl?: string;
  loadedPacket?: LoadedPacket;
  /** Sprint 4: opens the M5 re-capture drift modal. */
  onOpenRecaptureReview?: (parent_packet_id: string) => void;
  /** Sprint 4: when the parent (App) wants to open settings, it can pass
   *  this state down; otherwise PacketView opens its own settings modal
   *  via the top bar trigger. */
  settingsOpen?: boolean;
  onSettingsClose?: () => void;
}

interface TamperState {
  packetId: string;
  mismatch: ExternalChangePayload['mismatch_type'];
}

export function PacketView({
  packetId,
  persona,
  fixtureUrl,
  loadedPacket,
  onOpenRecaptureReview,
  settingsOpen,
  onSettingsClose,
}: PacketViewProps) {
  const [activeTab, setActiveTab] = useState<string>(DEFAULT_TAB[persona]);
  const [packet, setPacket] = useState<LoadedPacket | null>(loadedPacket ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!loadedPacket);
  const [tamper, setTamper] = useState<TamperState | null>(null);
  const [m1Open, setM1Open] = useState<{ claimId: string } | null>(null);
  const [m5Open, setM5Open] = useState<{ parentId: string } | null>(null);
  const [m3Open, setM3Open] = useState<{ redactionId: string; marker: string } | null>(
    null,
  );
  const [overlayOpen, setOverlayOpen] = useState<boolean>(false);
  // Sprint 5 (gh#12) — M2 + M4 state.
  //
  // Cycle-4.5 W3 (PR #21): the orphaned `edgeFlow` state was deleted
  // here. C12 routed all edge-flow recovery into M4PostToPrModal which
  // owns its OWN `edgeFlow: ClassifiedEdgeFlow | null` state — the
  // PacketView-level state was never set to a non-null value
  // (`setEdgeFlow(null)` was the only call), and its only consumer was
  // an EdgeFlowBanner block whose recovery routing duplicated M4's.
  // Deleting it removes ~60 lines of dead state + UI without any
  // behavior change.
  const [m4Open, setM4Open] = useState<boolean>(false);
  const [m2Open, setM2Open] = useState<{ errorDetail: string | null } | null>(null);
  const [postToast, setPostToast] = useState<PostToPrOutcome | null>(null);

  /**
   * Re-fire the packet loader (IPC or fixture-fetch). Used by both the
   * error-state EdgeFlowBanner recovery (E1/E2 corrupt-packet /
   * missing-fixture) and the inline `packet-not-found` edge-flow recovery
   * route (cycle-3 V1 — replaces the dead-loop `setM4Open(true)` that
   * mirrored the F11 anti-pattern).
   *
   * Lifted to component scope so both branches can share it. A fixture-
   * driven packet (loadedPacket prop set) cannot be re-loaded — bail
   * with a no-op so the user sees no spurious spinner.
   */
  const reloadPacket = useCallback(() => {
    if (loadedPacket) return;
    setError(null);
    setLoading(true);
    const loader = fixtureUrl ? loadPacketViaFetch(fixtureUrl) : loadPacketViaIpc(packetId);
    loader
      .then((result) => {
        setPacket(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof PacketLoadException
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to load packet',
        );
        setLoading(false);
      });
  }, [packetId, fixtureUrl, loadedPacket]);

  useEffect(() => {
    if (loadedPacket) {
      setPacket(loadedPacket);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const loader = fixtureUrl ? loadPacketViaFetch(fixtureUrl) : loadPacketViaIpc(packetId);
    loader
      .then((result) => {
        if (cancelled) return;
        setPacket(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof PacketLoadException
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to load packet';
        setError(message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [packetId, fixtureUrl, loadedPacket]);

  // Sprint 4: watcher event subscription. J12 banner shows when our packet
  // is the target of an external edit; trail-needs-refresh is consumed
  // higher up (TrailSidebar listens too).
  useEffect(() => {
    let dispose: (() => void) | null = null;
    let cancelled = false;
    subscribeFsWatch({
      onPacketChangedExternally: (payload) => {
        if (cancelled) return;
        if (payload.packet_id === packetId) {
          setTamper({ packetId: payload.packet_id, mismatch: payload.mismatch_type });
        }
      },
    }).then((d) => {
      if (cancelled) {
        d();
        return;
      }
      dispose = d;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [packetId]);

  // ARIA-alert role on a banner; only when we have an active tamper state.
  //
  // Cycle-3 ERR-7 (PR #21): the audit append is best-effort. A failure
  // (DB poisoned, IO error, or the renderer running outside Tauri in a
  // dev-mode preview) surfaces in DevTools / tracing logs as a console
  // warning but does NOT block the dismiss UX — the user already
  // pressed Dismiss, and an "audit append failed" toast would be
  // hostile UX for a security-warning that's already in the audit
  // path's hot-loop. v0.2 follow-up: surface a "audit-log-degraded"
  // banner-tier signal when the chain hash refuses to write so the
  // operator knows tamper-events aren't being durably recorded.
  const handleDismissTamper = useCallback(() => {
    setTamper((prev) => {
      if (prev) {
        invoke('audit_log_append', {
          event_type: 'tamper_dismissed',
          packet_id: prev.packetId,
          details: { mismatch_type: prev.mismatch, dismissed_by: 'user' },
          // Cycle-4.5 W2 (PR #21): persona threading on audit_log_append.
          persona,
        }).catch((e: unknown) => console.warn('[Trail] tamper_dismissed audit failed:', e));
      }
      return null;
    });
  }, [persona]);

  const handleDecide = useCallback(
    async (claimId: string, decision: 'accept' | 'changes' | 'block' | 'reject') => {
      try {
        await submitDecision({
          packet_id: packetId,
          claim_id: claimId,
          decision,
          // Cycle-3 C4 (PR #21): persona threading. The Rust handler
          // rejects auditor with PersonaForbidden; the UI gates the
          // decision shortcuts already (handleDecide isn't reachable
          // from auditor mode), but pass for IPC contract symmetry.
          persona,
        });
        // Re-load the packet so approval_trail tab refreshes.
        if (!loadedPacket) {
          const refreshed = fixtureUrl
            ? await loadPacketViaFetch(fixtureUrl)
            : await loadPacketViaIpc(packetId);
          setPacket(refreshed);
        }
      } catch (err) {
        console.warn('[Trail] decision save failed:', err);
        // Cycle-4.5 W15 (PR #21): route the catch through the shared
        // classifier so persona-forbidden + other typed IPC errors
        // surface with their human-readable Banner copy instead of the
        // raw Error.message which would say something like "IPC
        // invocation failed (kind: persona-forbidden)" — opaque and
        // unhelpful for the user.
        const classified =
          err instanceof IpcInvocationError ? classifyGhError(err) : null;
        setError(
          classified
            ? `${classified.title}: ${classified.body}`
            : err instanceof Error
              ? err.message
              : 'Decision save failed',
        );
      }
    },
    [packetId, persona, fixtureUrl, loadedPacket],
  );

  const handleOpenRiskOverride = useCallback(
    (claimId: string) => {
      if (persona !== 'reviewer') return; // M1 reviewer variant is reviewer-only
      setM1Open({ claimId });
    },
    [persona],
  );

  const handleBulkAccept = useCallback(async () => {
    if (!packet) return;
    const decided = new Set(packet.approval_trail.map((e) => e.claim_id));
    // Cycle-4.5 W15 (PR #21): collect rejected claim_ids + their
    // classified error copy so the loop can surface user-visible
    // feedback after the run. The previous version swallowed every
    // failure with console.warn — silent-failure is hostile UX for a
    // bulk action where 0/N claims may have actually persisted. The
    // user sees the green spinner finish and assumes everything went
    // through.
    const skipped: Array<{ claimId: string; reason: string }> = [];
    for (const c of packet.claims) {
      const id = c.stable_id ?? c.id;
      if (decided.has(c.id) || (c.stable_id && decided.has(c.stable_id))) continue;
      try {
        await submitDecision({
          packet_id: packetId,
          claim_id: id,
          decision: 'accept',
          // Cycle-3 C4 (PR #21): persona threading.
          persona,
        });
      } catch (err) {
        console.warn(`[Trail] bulk-accept skip ${id}:`, err);
        const classified =
          err instanceof IpcInvocationError ? classifyGhError(err) : null;
        skipped.push({
          claimId: id,
          reason: classified
            ? classified.title
            : err instanceof Error
              ? err.message
              : 'Unknown error',
        });
      }
    }
    // Refresh once after the loop.
    if (!loadedPacket) {
      try {
        const refreshed = fixtureUrl
          ? await loadPacketViaFetch(fixtureUrl)
          : await loadPacketViaIpc(packetId);
        setPacket(refreshed);
      } catch (err) {
        console.warn('[Trail] post-bulk reload failed:', err);
      }
    }
    // Cycle-4.5 W15 (PR #21): surface a top-level error if any claim
    // was skipped. We summarise the FIRST classified reason; the
    // console.warn logs above carry per-claim detail for diagnostics.
    if (skipped.length > 0) {
      const first = skipped[0]!;
      setError(
        `Bulk-accept skipped ${skipped.length} claim(s) (first: ${first.claimId} — ${first.reason}). Check DevTools for per-claim detail.`,
      );
    }
  }, [packet, packetId, persona, fixtureUrl, loadedPacket]);

  /**
   * Sprint 5 (gh#12 AC-2): M4 trigger from `g` shortcut or top-bar
   * button. Auditor cannot post (read-only mode).
   */
  const handleOpenPost = useCallback(() => {
    if (persona === 'auditor') return;
    setM4Open(true);
  }, [persona]);

  /**
   * Sprint 5 (gh#12): M4 modal succeeded → reload packet so the
   * new posted_to_pr[] entry surfaces in the Trail tab + drives the
   * "previously posted to" indicator on the next M4 open.
   */
  const handlePosted = useCallback(
    async (outcome: PostToPrOutcome) => {
      setPostToast(outcome);
      window.setTimeout(() => setPostToast(null), 6000);
      if (loadedPacket) return; // fixture-driven; re-load not applicable
      try {
        const refreshed = fixtureUrl
          ? await loadPacketViaFetch(fixtureUrl)
          : await loadPacketViaIpc(packetId);
        setPacket(refreshed);
      } catch (err) {
        console.warn('[Trail] post-success reload failed:', err);
      }
    },
    [packetId, fixtureUrl, loadedPacket],
  );

  /**
   * Sprint 5 (gh#12 AC-1): M4 detected gh-not-authenticated → open M2.
   * The M4 modal stays open underneath; M2 sits on top so Retry returns
   * to the destination-confirm view.
   */
  const handleAuthFailed = useCallback((errorDetail: string) => {
    setM2Open({ errorDetail });
  }, []);

  /**
   * Sprint 5 (gh#12 AC-1, AC-7): M2 retry — re-fire post via the bridge.
   * If the retry succeeds we close M2; if it fails we leave M2 open
   * with the new error detail so the user can fix and retry again.
   */
  const handleM2Retry = useCallback(async () => {
    try {
      // Cycle-2 C15 (PR #21): persona threading — Rust handler rejects
      // auditor with PersonaForbidden. M2 is only reachable from a
      // failed M4 post attempt, which auditor cannot reach in the UI;
      // pass persona for defence-in-depth + IPC contract symmetry.
      const result = await postToPr({ packet_id: packetId, persona });
      setM2Open(null);
      void handlePosted(result);
    } catch (err) {
      const classified = classifyGhError(err);
      // Cycle-3 C1 (PR #21): IpcInvocationError extends Error, so the
      // `err instanceof Error` branch covers both. The synthesised
      // message in IpcInvocationError now handles the persona-forbidden
      // variant (no inner .message field) — see ipc/client.ts.
      const detail =
        classified?.body ?? (err instanceof Error ? err.message : 'Unknown error');
      setM2Open({ errorDetail: detail });
    }
  }, [packetId, persona, handlePosted]);

  // Decision shortcuts: enabled when no modal is open. The post `g`
  // shortcut lives here too (B4 §9). Auditor cannot post — passing
  // undefined causes the dispatcher to ignore `g` keystrokes.
  const auditChip =
    persona === 'auditor' ? (
      <span
        className="packet-view__audit-chip type-mono-sm"
        aria-label="Audit mode: read-only"
      >
        AUDIT · READ-ONLY
      </span>
    ) : null;

  const currentClaim = useMemo(() => {
    if (!packet || !m1Open) return null;
    return (
      packet.claims.find(
        (c) => c.id === m1Open.claimId || c.stable_id === m1Open.claimId,
      ) ?? null
    );
  }, [packet, m1Open]);

  // Hooks must run on every render — before any early-return branch.
  // The shortcut handler is a no-op when the packet is not yet loaded
  // (handleOpenPost guards on persona; the dispatcher swallows `g`
  // when no callback is supplied, so an early-load `g` keystroke
  // simply does nothing).
  const anyModalOpenForShortcuts =
    !!m1Open ||
    !!m5Open ||
    !!m3Open ||
    overlayOpen ||
    !!settingsOpen ||
    m4Open ||
    !!m2Open;
  useDecisionShortcuts(
    persona === 'auditor' || !packet ? {} : { onOpenPost: handleOpenPost },
    !anyModalOpenForShortcuts,
  );

  if (loading) {
    return (
      <div className="packet-view" data-mode={persona}>
        <Card density="comfortable">
          <Skeleton variant="block" />
          <Skeleton variant="block" />
          <Skeleton variant="block" />
        </Card>
      </div>
    );
  }

  if (error || !packet) {
    // Sprint 5 (gh#12 AC-8): map load-time errors to the E1 (corrupt
    // packet — schema-rejected) or E2 (missing fixture / yaml-parse-
    // failed) edge flows so the user gets a recovery action, not a
    // dead-end EmptyState. The reload affordance re-fires the loader
    // via the component-scoped reloadPacket helper.
    const looksLikeMissing =
      typeof error === 'string' &&
      (error.toLowerCase().includes('missing on disk') ||
        error.toLowerCase().includes('not found') ||
        error.toLowerCase().includes('did not parse'));
    const edgeKind: EdgeFlowKind = looksLikeMissing ? 'missing-fixture' : 'corrupt-packet';
    return (
      <div className="packet-view" data-mode={persona}>
        <EdgeFlowBanner kind={edgeKind} detail={error} onRecover={reloadPacket} />
      </div>
    );
  }

  const claimCount = packet.claims.length;
  const hasParent = packet.header.is_recapture;
  const auditHighRiskUnrecorded =
    persona === 'auditor' &&
    packet.approval_trail.length === 0 &&
    (packet.histogram.high > 0 || packet.histogram.crit > 0);

  const tabs = buildTabs(packet.redaction_summary.redactions_applied);
  const anyModalOpen =
    !!m1Open ||
    !!m5Open ||
    !!m3Open ||
    overlayOpen ||
    !!settingsOpen ||
    m4Open ||
    !!m2Open;

  const handleOpenRecaptureReview = (parentId: string) => {
    setM5Open({ parentId });
    onOpenRecaptureReview?.(parentId);
  };

  // Sprint 5 (gh#12): pre-detect destination from header.repository +
  // header.branch + lastPosted.pr_number, when available. The packet
  // header carries `repository` (typically "owner/name"), and the most
  // recent posted_to_pr entry pins the PR number for re-posts. On first
  // post we leave the destination string empty and let the gh CLI
  // resolve from the current branch.
  const lastPosted = packet.posted_to_pr.length > 0 ? packet.posted_to_pr[0]! : null;
  const detectedDestination =
    lastPosted && packet.header.repository
      ? `${packet.header.repository}#${lastPosted.pr_number}`
      : packet.header.repository
        ? `${packet.header.repository} (branch ${packet.header.branch})`
        : null;

  return (
    <div className="packet-view" data-mode={persona}>
      {tamper ? (
        <Banner
          tone="alert"
          title="Packet changed externally — possible tampering"
          action={
            <Button variant="secondary" size="sm" onClick={handleDismissTamper}>
              Dismiss
            </Button>
          }
        >
          The on-disk approval_trail hash for this packet does not match Trail's
          last_known_hash. Mismatch type:{' '}
          <code className="type-mono-sm">{tamper.mismatch}</code>. Reload the packet
          to re-sync, or investigate the source of the change.
        </Banner>
      ) : null}
      {hasParent ? (
        <RecaptureBanner
          parent_packet_id={packet.header.parent_packet_id as string}
          claim_count={claimCount}
          onOpenRecaptureReview={handleOpenRecaptureReview}
        />
      ) : null}
      {/* Cycle-4.5 W3 (PR #21): the EdgeFlowBanner block was deleted
          from this slot. The PacketView-level edgeFlow state was
          orphaned — `setEdgeFlow(null)` was the only call, no code
          path produced a non-null value. C12's per-kind routing now
          lives entirely inside M4PostToPrModal which owns its own
          ClassifiedEdgeFlow state and renders its own per-kind
          recovery actions. Deleting the dead block removes ~60 lines
          of duplicate routing without any behavior change. */}
      {postToast ? (
        <Banner
          tone="info"
          title="Posted to PR"
          onDismiss={() => setPostToast(null)}
        >
          {postToast.pr_url ? (
            <p className="type-body-sm" data-testid="post-toast-detail">
              Posted to{' '}
              <a
                href={postToast.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="type-mono-sm"
              >
                {postToast.pr_url}
              </a>
              {postToast.body_hash_prefix ? (
                <>
                  {' '}
                  (body_hash{' '}
                  <code className="type-mono-sm">{postToast.body_hash_prefix}…</code>)
                </>
              ) : null}
            </p>
          ) : (
            <p className="type-body-sm">Packet synced to GitHub.</p>
          )}
        </Banner>
      ) : null}
      <Card density="comfortable">
        <div className="packet-view__top">
          <PacketHeader header={packet.header} claim_count={claimCount} />
          {persona === 'auditor' ? null : (
            <Button
              variant="primary"
              size="sm"
              onClick={handleOpenPost}
              data-testid="packet-view-post-button"
              aria-label="Post packet to PR (g)"
            >
              {lastPosted ? 'Re-post to PR' : 'Post to PR'}
            </Button>
          )}
          {auditChip}
        </div>
        <RiskHistogram histogram={packet.histogram} />
        <Tabs
          items={tabs}
          activeId={activeTab}
          onChange={setActiveTab}
          orientation="horizontal"
          emphasize={persona === 'reviewer'}
          panel={
            activeTab === 'claims' ? (
              <ClaimsTab
                claims={packet.claims}
                approvalTrail={packet.approval_trail}
                {...(persona === 'auditor' ? {} : { onDecide: handleDecide })}
                {...(persona === 'reviewer'
                  ? { onOpenRiskOverride: handleOpenRiskOverride }
                  : {})}
                {...(persona === 'auditor' ? {} : { onBulkAccept: handleBulkAccept })}
                shortcutsEnabled={!anyModalOpen}
              />
            ) : activeTab === 'diff' ? (
              <DiffTab diff_summary={packet.diff_summary} />
            ) : activeTab === 'redaction' ? (
              <RedactionTab
                redaction_summary={packet.redaction_summary}
                {...(persona === 'auditor'
                  ? {}
                  : {
                      onPreviewClick: (redactionId: string, marker: string) =>
                        setM3Open({ redactionId, marker }),
                    })}
              />
            ) : activeTab === 'trail' ? (
              <TrailTab
                entries={packet.approval_trail}
                persona={persona}
                audit_high_risk_unrecorded={auditHighRiskUnrecorded}
              />
            ) : null
          }
        />
      </Card>
      {/* Modal layer — Sprint 4. */}
      {currentClaim ? (
        <M1ReviewerModal
          open
          packetId={packetId}
          claimId={m1Open!.claimId}
          claimText={currentClaim.text}
          agentLevel={(currentClaim.risk_level ?? 'med') as RiskLevel}
          agentRationale={null}
          creatorOverride={null}
          onClose={() => setM1Open(null)}
          onSaved={() => {
            // Re-load to surface override row.
            if (!loadedPacket) {
              const loader = fixtureUrl
                ? loadPacketViaFetch(fixtureUrl)
                : loadPacketViaIpc(packetId);
              loader
                .then(setPacket)
                .catch((err: unknown) => console.warn('[Trail] post-M1 reload:', err));
            }
          }}
        />
      ) : null}
      {m5Open ? (
        <M5RecaptureDriftModal
          open
          parentPacketId={m5Open.parentId}
          currentClaims={packet.claims.map((c) => ({
            id: c.id,
            stable_id: c.stable_id,
            claim_text: c.text,
            risk_level: (c.risk_level ?? 'unknown') as string,
          }))}
          onClose={() => setM5Open(null)}
        />
      ) : null}
      {m3Open ? (
        <M3RedactionPreviewModal
          open
          packetId={packetId}
          redactionId={m3Open.redactionId}
          marker={m3Open.marker}
          persona={persona}
          onClose={() => setM3Open(null)}
        />
      ) : null}
      {overlayOpen ? (
        <KeyboardOverlay open onClose={() => setOverlayOpen(false)} />
      ) : null}
      {settingsOpen ? (
        <M6SettingsModal
          open
          onClose={() => onSettingsClose?.()}
          persona={persona}
        />
      ) : null}
      {/* Sprint 5 (gh#12) — M4 post-to-PR + M2 gh-auth modals. */}
      {m4Open ? (
        <M4PostToPrModal
          open
          onClose={() => setM4Open(false)}
          packetId={packetId}
          persona={persona}
          detectedDestination={detectedDestination}
          lastPosted={lastPosted}
          onPosted={(outcome) => {
            setM4Open(false);
            void handlePosted(outcome);
          }}
          onAuthFailed={(detail) => handleAuthFailed(detail)}
        />
      ) : null}
      {m2Open ? (
        <M2GhAuthModal
          open
          onClose={() => setM2Open(null)}
          onRetry={handleM2Retry}
          errorDetail={m2Open.errorDetail}
        />
      ) : null}
    </div>
  );
}
