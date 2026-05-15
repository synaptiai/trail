import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '@/components/primitives';
import { ClaimRow } from './ClaimRow';
import type { PacketClaimShape, ApprovalTrailEntryShape } from '@/services/packet-loader';
import {
  decisionKeyToSchemaValue,
  useDecisionShortcuts,
  type DecisionKey,
} from '@/services/decision-shortcuts';

/**
 * <ClaimsTab> — Sprint 3b body for the Claims tab; Sprint 4 adds focus
 * tracking + decision shortcuts.
 *
 * The tab maintains a focusedIndex pointing at one row; that row gets
 * `aria-current="true"` so screen readers track the focus state. Keyboard
 * shortcuts (a/c/b/r/j/k/n/p/Shift+A) operate on the focused row via the
 * decision-shortcuts service; M1 (risk override) opens via `r` when the
 * caller passes onOpenRiskOverride.
 *
 * The tab does NOT submit decisions itself — it forwards intent up to the
 * PacketView orchestrator, which holds the saga client + IPC bridge. This
 * keeps ClaimsTab unit-testable without IPC stubs.
 */

export interface ClaimsTabProps {
  claims: PacketClaimShape[];
  /** Approval trail; used to identify "undecided" claims for n/p navigation. */
  approvalTrail: ApprovalTrailEntryShape[];
  /**
   * Called when the user presses a/c/b on the focused row.
   *
   * Cycle-2 C2 (PR #21): callers may return a Promise. ClaimsTab tracks
   * the per-claim "in flight" state so it can mark the row as optimistic
   * (data-decision="<kind>") immediately and durable
   * (data-decision-persisted="true") once the awaited handler resolves.
   * Synchronous callers (returning void) are still supported — the row
   * is marked durable at the next microtask. The perf-gate E2E test
   * relies on these data-attributes; see ClaimRow.tsx for the contract.
   */
  onDecide?: (
    claimId: string,
    decision: 'accept' | 'changes' | 'block' | 'reject',
  ) => void | Promise<void>;
  /** Called when the user presses `r` (request-evidence) — Sprint 4 keeps
   *  this as a separate slot so the caller can open M1 instead. */
  onOpenRiskOverride?: (claimId: string) => void;
  /** Called when Shift+A is pressed. The orchestrator iterates undecided
   *  claims itself (so optimistic UI + saga calls go through one path). */
  onBulkAccept?: () => void;
  /** Disable shortcuts — used when a modal is open. */
  shortcutsEnabled?: boolean;
}

export function ClaimsTab({
  claims,
  approvalTrail,
  onDecide,
  onOpenRiskOverride,
  onBulkAccept,
  shortcutsEnabled = true,
}: ClaimsTabProps) {
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Cycle-2 C2 (PR #21): optimistic + persisted decision tracking. Two
  // maps keyed by claim id (stable_id when present, else c.id):
  //   optimistic: the in-flight decision kind (cleared on persist).
  //   persisted: the set of ids for which the saga IPC has acked.
  // The perf-gate E2E test queries each row's data-decision +
  // data-decision-persisted to time the optimistic vs durable budget.
  const [optimistic, setOptimistic] = useState<
    Record<string, 'accept' | 'changes' | 'block' | 'reject'>
  >({});
  const [persisted, setPersisted] = useState<Record<string, boolean>>({});

  // Re-clamp focus when claims length changes.
  useEffect(() => {
    if (focusedIndex >= claims.length && claims.length > 0) {
      setFocusedIndex(claims.length - 1);
    }
  }, [claims.length, focusedIndex]);

  const decidedSet = useMemo(() => {
    const s = new Set<string>();
    for (const e of approvalTrail) s.add(e.claim_id);
    return s;
  }, [approvalTrail]);

  const onMoveDown = useCallback(() => {
    setFocusedIndex((i) => Math.min(i + 1, claims.length - 1));
  }, [claims.length]);
  const onMoveUp = useCallback(() => {
    setFocusedIndex((i) => Math.max(i - 1, 0));
  }, []);
  const onJumpNextUndecided = useCallback(() => {
    setFocusedIndex((i) => {
      for (let k = i + 1; k < claims.length; k++) {
        const c = claims[k]!;
        if (!decidedSet.has(c.id) && (!c.stable_id || !decidedSet.has(c.stable_id))) {
          return k;
        }
      }
      return i;
    });
  }, [claims, decidedSet]);
  const onJumpPrevUndecided = useCallback(() => {
    setFocusedIndex((i) => {
      for (let k = i - 1; k >= 0; k--) {
        const c = claims[k]!;
        if (!decidedSet.has(c.id) && (!c.stable_id || !decidedSet.has(c.stable_id))) {
          return k;
        }
      }
      return i;
    });
  }, [claims, decidedSet]);
  const onShortcutDecide = useCallback(
    (decision: DecisionKey) => {
      const c = claims[focusedIndex];
      if (!c) return;
      if (decision === 'request-evidence') {
        // r → open M1 risk override on the focused claim. The schema also
        // accepts 'reject' as a decision; the UI surfaces this as
        // request-evidence + the M1 modal lets the reviewer record reason.
        if (onOpenRiskOverride) {
          onOpenRiskOverride(c.stable_id ?? c.id);
          return;
        }
      }
      if (onDecide) {
        const cid = c.stable_id ?? c.id;
        const kind = decisionKeyToSchemaValue(decision);
        // Cycle-2 C2 (PR #21): optimistic mark fires synchronously so
        // the perf-test can observe data-decision before the saga's IPC
        // resolves. Then we await the handler (which is itself async in
        // production: PacketView.handleDecide -> submitDecision ->
        // invoke('save_decision')). On resolve, flip persisted; on
        // failure, clear optimistic so the row visually reverts.
        setOptimistic((prev) => ({ ...prev, [cid]: kind }));
        Promise.resolve(onDecide(cid, kind))
          .then(() => {
            setPersisted((prev) => ({ ...prev, [cid]: true }));
          })
          .catch((err: unknown) => {
            // Cycle-3 C13 (PR #21): the previous silent catch swallowed
            // every saga / IPC failure — a regression in
            // saga-client.submitDecision (e.g., a contract change that
            // failed Zod parse) would leave the row visually reverted
            // with no diagnostic anywhere. Log a structured warning so
            // the failure surfaces in DevTools / tracing logs; the
            // visual revert is still applied so the UI stays honest.
            //
            // Cycle-4.5 W17 (PR #21): carry claim_id + decision kind in
            // the structured payload. The previous single-arg log left
            // the operator searching log lines for context — which
            // claim and which decision kind tripped the failure.
            // Including both makes the trail-needs-investigation log
            // actionable.
            console.warn('[Trail] shortcut decision failed:', { cid, kind, err });
            setOptimistic((prev) => {
              const next = { ...prev };
              delete next[cid];
              return next;
            });
          });
      }
    },
    [claims, focusedIndex, onDecide, onOpenRiskOverride],
  );

  useDecisionShortcuts(
    {
      onDecide: onShortcutDecide,
      onMoveDown,
      onMoveUp,
      onJumpNextUndecided,
      onJumpPrevUndecided,
      ...(onBulkAccept ? { onBulkAccept } : {}),
    },
    shortcutsEnabled,
  );

  if (claims.length === 0) {
    return (
      <EmptyState
        variant="full"
        headline="No claims captured."
        body="Re-run `trail packet generate` from the project root to refresh this packet."
      />
    );
  }
  return (
    <div className="claims-tab" role="list" aria-label="Claims" ref={containerRef}>
      {claims.map((c, i) => {
        const cid = c.stable_id ?? c.id;
        // Cycle-2 C2 (PR #21): a claim already in approval_trail when
        // ClaimsTab mounts is durably persisted by definition — flip
        // persisted=true so the perf-test gate sees it without needing
        // a fresh dispatch. The optimistic decision attribute mirrors
        // the same approval_trail entry so the row's pigment reflects
        // the persisted decision, not just an in-flight one.
        const trailEntry = approvalTrail.find(
          (e) => e.claim_id === c.id || (c.stable_id && e.claim_id === c.stable_id),
        );
        const optimisticForRow =
          optimistic[cid] ??
          (trailEntry
            ? (trailEntry.decision as 'accept' | 'changes' | 'block' | 'reject')
            : undefined);
        const persistedForRow = persisted[cid] || trailEntry !== undefined;
        return (
          <div
            role="listitem"
            key={c.id}
            aria-current={i === focusedIndex ? 'true' : undefined}
            data-focused={i === focusedIndex}
            data-claim-id={cid}
            onClick={() => setFocusedIndex(i)}
          >
            <ClaimRow
              claim={c}
              {...(optimisticForRow ? { optimisticDecision: optimisticForRow } : {})}
              {...(persistedForRow ? { persisted: true } : {})}
            />
          </div>
        );
      })}
    </div>
  );
}
