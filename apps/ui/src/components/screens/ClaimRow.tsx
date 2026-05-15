import { useState } from 'react';
import './ClaimRow.css';
import { Risk } from '@/components/primitives';
import type { PacketClaimShape } from '@/services/packet-loader';

/**
 * <ClaimRow> (B4 §4.4 / gh#9 criterion 3).
 *
 * Single claim row in the Sprint 3a foundation: collapsed by default,
 * expand to reveal a hint of the upcoming evidence subsection (Sprint 3b
 * wires the full diff hunk + decision actions). The Sprint 3a row surfaces:
 *
 *   - risk pigment chip (LOW/MED/HIGH/CRIT) via `<Risk variant="dot">`
 *     when classified, OR a `(unclassified)` neutral chip when no risk
 *     classification block is populated (Phase 1 capture default state).
 *   - claim text (Layer-1 redacted by Phase 1; UI does NOT re-redact —
 *     the on-disk text IS the redacted form).
 *   - stable_id reference: 8 hex chars truncated, hover/title shows full
 *     16-hex ID. When stable_id is missing (legacy v0.1 capture), the
 *     human-facing CLAIM-NNN id is shown instead.
 *   - evidence_refs count: a pill counting how many DIFF/CMD/TEST/PROMPT
 *     items support this claim. ≥1 always (cross-reference invariant).
 *
 * The row is an `<article>` so screen readers announce it as discrete
 * content; the expand button is `<button aria-expanded>` so the toggle
 * is keyboard-actionable AND screen-reader-announced as 'collapsed' /
 * 'expanded'.
 *
 * Sprint 3b will replace the placeholder evidence panel with `<DiffHunk>`
 * + decision actions; criterion 3 only requires the row spine + chip
 * encoding to ship now.
 */
export interface ClaimRowProps {
  claim: PacketClaimShape;
  /** Initial collapsed state — defaults to true (B4 §4.4: 'each claim row
   *  collapses/expands. Collapsed shows: risk glyph + label + claim text'). */
  defaultExpanded?: boolean;
  /**
   * Cycle-2 C2 (PR #21): the perf-test gate at
   * apps/ui/tests/e2e/sprint6-perf-gates.spec.ts observes `data-decision`
   * (optimistic mark — set BEFORE the saga IPC has acked) and
   * `data-decision-persisted` (set AFTER the saga IPC resolves) on each
   * `.claim-row`. The orchestrator (ClaimsTab) tracks optimistic +
   * persisted state and passes them in here so the perf budget for
   * "click → optimistic" and "click → durable" can be measured against
   * real DOM signals instead of falling back to the time-budget proxy.
   *
   * Both attributes are absent in the no-decision idle case (the test's
   * "wait for the row to be there" probe does not depend on either).
   */
  optimisticDecision?: 'accept' | 'changes' | 'block' | 'reject';
  persisted?: boolean;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

function formatId(claim: PacketClaimShape): { display: string; full: string } {
  if (claim.stable_id) {
    return { display: claim.stable_id.slice(0, 8) + '…', full: claim.stable_id };
  }
  return { display: claim.id, full: claim.id };
}

export function ClaimRow({
  claim,
  defaultExpanded = false,
  optimisticDecision,
  persisted,
}: ClaimRowProps) {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  const id = formatId(claim);

  // Cycle-2 C2 (PR #21): optimistic + durable signals for the perf-gate
  // E2E test. Both are emitted as data-attributes on the same node the
  // test queries (`.claim-row`); `undefined` values yield `null`, which
  // React omits, so the no-decision idle case stays untouched.
  const dataDecision = optimisticDecision ?? null;
  const dataDecisionPersisted = persisted ? 'true' : null;

  return (
    <article
      className={`claim-row ${expanded ? 'claim-row--expanded' : 'claim-row--collapsed'}`}
      aria-labelledby={`claim-${claim.id}-text`}
      data-decision={dataDecision}
      data-decision-persisted={dataDecisionPersisted}
    >
      <button
        type="button"
        className="claim-row__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="claim-row__caret type-mono-sm" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        {claim.risk_level ? (
          <Risk level={claim.risk_level} variant="dot" />
        ) : (
          <span
            className="claim-row__unclassified type-mono-sm"
            aria-label="Risk level: unclassified"
          >
            ◌ —
          </span>
        )}
        <span
          id={`claim-${claim.id}-text`}
          className="claim-row__text type-body-sm"
        >
          {truncate(claim.text, 160)}
        </span>
      </button>
      <div className="claim-row__meta type-mono-sm">
        <span
          className="claim-row__id"
          title={id.full}
          aria-label={`Stable ID: ${id.full}`}
        >
          {id.display}
        </span>
        <span
          className="claim-row__evidence"
          aria-label={`${claim.evidence_count} evidence ${claim.evidence_count === 1 ? 'reference' : 'references'}`}
        >
          ev × {claim.evidence_count}
        </span>
        <span className="claim-row__confidence" aria-label={`Confidence: ${claim.confidence}`}>
          {claim.confidence}
        </span>
      </div>
      {expanded ? (
        <div className="claim-row__detail" role="region" aria-label="Claim evidence">
          <p className="type-body claim-row__full-text">{claim.text}</p>
          <p className="claim-row__hint type-body-sm">
            Evidence references:{' '}
            <span className="type-mono-sm">{claim.evidence_refs.join(' · ')}</span>
          </p>
          <p className="claim-row__hint claim-row__hint--pending type-body-sm">
            Diff hunk + decision actions ship in Sprint 3b / Sprint 4. The packet view
            spine renders here per gh#9 criterion 3.
          </p>
        </div>
      ) : null}
    </article>
  );
}
