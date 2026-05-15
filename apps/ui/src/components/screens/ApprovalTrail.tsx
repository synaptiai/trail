import './ApprovalTrail.css';
import { EmptyState } from '@/components/primitives';
import type { ApprovalTrailEntryShape } from '@/services/packet-loader';
import type { Persona } from '@/ipc/contract';

/**
 * <ApprovalTrail> read-only render (B4 §4.5 'Trail tab' / gh#9 criterion 4).
 *
 * Renders chronological approval-trail entries from the loaded packet's
 * `approval_trail[]`. The on-disk YAML invariant (schema's
 * approval_trail_entry rules) requires entries in chronological order, so
 * the UI renders them in array order — no client-side resort, no risk of
 * the UI reordering and losing the audit chain's intent.
 *
 * F25 lesson: this component mirrors apps/capture/src/render/markdown.ts's
 * "## Approval Trail" section character-for-character at the field level —
 * same decision labels, same column order, same reason-empty placeholder.
 * A reviewer comparing the PR-body markdown render to the in-app Trail tab
 * MUST see byte-equivalent content; drift between renderers is exactly the
 * failure mode "auditor gets two different stories from the same packet".
 *
 * Audit-mode empty state (B4 §4.7): when persona='auditor' and the packet
 * has 0 entries, the empty state IS the audit finding. The headline
 * elevates this case so a HIGH-risk packet with no decisions reads as a
 * dispositive blank (job-003.emotional). Non-auditor empty states stay
 * neutral — creators see "no decisions yet" as a normal pre-decide state.
 */

const DECISION_LABELS: Record<ApprovalTrailEntryShape['decision'], string> = {
  // Markdown render uses emoji prefixes (markdown.ts:248-253). The React
  // component drops the emoji because emoji on dark surfaces have rendered
  // inconsistently across macOS / Linux vendors and the WCAG 1.4.1
  // redundancy contract is already paid by the per-row tone class +
  // the verbal aria-label below.
  accept: 'accept',
  changes: 'changes',
  block: 'block',
  reject: 'reject',
};

export interface ApprovalTrailProps {
  entries: ApprovalTrailEntryShape[];
  /** Surfaces audit-mode-elevated empty-state copy when the trail is empty. */
  persona: Persona;
  /** When true, the empty state's audit-elevated headline is shown — the
   *  caller decides this based on packet risk (B4 §4.7 'audit-relevant: HIGH-risk
   *  packet without recorded approval'). Sprint 3a lifts the decision up so the
   *  component remains pure-render. */
  audit_high_risk_unrecorded?: boolean;
}

export function ApprovalTrail({
  entries,
  persona,
  audit_high_risk_unrecorded = false,
}: ApprovalTrailProps) {
  if (entries.length === 0) {
    if (persona === 'auditor' && audit_high_risk_unrecorded) {
      return (
        <EmptyState
          variant="full"
          headline="No approval decisions recorded."
          body="Audit-relevant: HIGH-risk packet without recorded approval."
        />
      );
    }
    return (
      <EmptyState
        variant="full"
        headline="No approval decisions recorded for this packet."
        body="Decisions land here once the reviewer runs `trail packet decide` (CLI) or wires the in-app saga (Sprint 4)."
      />
    );
  }

  return (
    <section className="approval-trail" aria-label="Approval trail">
      <p className="approval-trail__caption type-body-sm">
        {entries.length} decision{entries.length === 1 ? '' : 's'} recorded via{' '}
        <code className="type-mono-sm">trail packet decide</code>. Chronological order.
      </p>
      <ol className="approval-trail__list" aria-label="Approval trail entries">
        {entries.map((entry, idx) => {
          const label = DECISION_LABELS[entry.decision];
          // Per-entry verbal label gives screen-reader users a single
          // sentence per decision: "Decision N: <decision> on claim <id>
          // by <by> at <at> — <reason>".
          const verbal =
            `Decision ${idx + 1}: ${label} on claim ${entry.claim_id} ` +
            `by ${entry.by} at ${entry.at}` +
            (entry.reason ? ` — ${entry.reason}` : '');
          return (
            <li
              key={`${entry.claim_id}-${entry.at}-${idx}`}
              className={`approval-trail__entry approval-trail__entry--${entry.decision}`}
              aria-label={verbal}
            >
              <div className="approval-trail__row">
                <time
                  className="approval-trail__time type-mono-sm tabular-nums"
                  dateTime={entry.at}
                >
                  {entry.at}
                </time>
                <span
                  className={`approval-trail__decision approval-trail__decision--${entry.decision} type-mono-sm`}
                >
                  {label}
                </span>
                <span className="approval-trail__claim type-mono-sm" title={entry.claim_id}>
                  {entry.claim_id}
                </span>
                <span className="approval-trail__by type-body-sm">{entry.by}</span>
              </div>
              {entry.reason && entry.reason.trim() !== '' ? (
                <p className="approval-trail__reason type-body-sm">{entry.reason}</p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
