import { Banner, Button, EmptyState } from '@/components/primitives';
import type { RedactionSummaryShape } from '@/services/packet-loader';
import './RedactionTab.css';

/**
 * <RedactionTab> — Sprint 3b (gh#10 criterion 1; B4 §4.5).
 *
 * Surfaces the redaction summary from `agent_session.redaction_metadata`:
 *   - Pattern set version + origin (bundled vs user-supplied integrity flag).
 *   - Total redactions applied across all captured fields.
 *   - Per-pattern × count table (sorted alphabetically — already by the loader).
 *   - Validation errors (Layer 2 catches; SHOULD be empty).
 *   - Opt-in preview note (Sprint 4 wires the M3 modal).
 *
 * NOT in this Sprint:
 *   - Per-pattern × per-layer breakdown (the M3 redaction-audit detail) —
 *     deferred to Sprint 4 alongside the modal.
 *   - "preview original" buttons — deferred to Sprint 4 (M3 modal entry).
 *
 * Why a flat table over a nested list:
 *   B4 §4.5's mock shows columns "Pattern · Layer · Count · Locations". Sprint 3b
 *   ships the canonical 2-column slice (Pattern · Count) since the v0.1.1 packet
 *   only commits the 2-column shape via redaction_metadata.redactions_by_pattern.
 *   The 4-column form requires the redaction_audit array which is not yet
 *   universally populated; widening the spec to 4 columns prematurely would
 *   surface "—" placeholders that read as missing data instead of unsupported.
 */

export interface RedactionTabProps {
  redaction_summary: RedactionSummaryShape;
  /** Sprint 4: when defined, the table renders a "Preview" button per row
   *  that opens M3RedactionPreviewModal. Auditor mode passes undefined so
   *  the read-only surface excludes the affordance. */
  onPreviewClick?: (redactionId: string, marker: string) => void;
}

export function RedactionTab({ redaction_summary, onPreviewClick }: RedactionTabProps) {
  const {
    pattern_set_version,
    pattern_set_origin,
    redactions_applied,
    by_pattern,
    validation_errors,
  } = redaction_summary;
  const isUserSupplied = pattern_set_origin === 'user-supplied';

  return (
    <div className="redaction-tab">
      <header className="redaction-tab__header">
        <h3 className="type-h3 redaction-tab__title">Redaction summary</h3>
        <p className="type-body-sm redaction-tab__meta">
          <span>
            Pattern set:{' '}
            <code className="type-mono-sm">v{pattern_set_version}</code>
          </span>
          {pattern_set_origin ? (
            <>
              {' · '}
              <span
                className={
                  isUserSupplied
                    ? 'redaction-tab__origin redaction-tab__origin--user-supplied'
                    : 'redaction-tab__origin'
                }
              >
                {pattern_set_origin}
              </span>
            </>
          ) : null}
          {' · '}
          <span>{redactions_applied} redactions applied</span>
        </p>
      </header>

      {isUserSupplied ? (
        <Banner tone="warning" title="User-supplied pattern set">
          Pattern set version is forgeable when origin ≠ bundled. Verify the source before trusting the displayed counts.
        </Banner>
      ) : null}

      {validation_errors.length > 0 ? (
        <Banner tone="warning" title={`${validation_errors.length} validation error(s)`}>
          <ul className="redaction-tab__errors">
            {validation_errors.map((err, idx) => (
              <li key={idx} className="type-mono-sm">
                {err}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      {by_pattern.length === 0 ? (
        <EmptyState
          variant="full"
          headline={
            redactions_applied === 0
              ? 'No redactions applied'
              : `${redactions_applied} redactions, none grouped by pattern`
          }
          body={
            redactions_applied === 0
              ? 'Either no captured field matched a configured pattern, or this packet ran on a pattern set with zero patterns. Pattern set version is recorded above for audit.'
              : 'Pattern grouping returned an empty map; this is unexpected when redactions_applied > 0. Re-run capture or inspect bin/trail-redaction-patterns.yml.'
          }
        />
      ) : (
        <table className="redaction-tab__table" aria-label="Redactions by pattern">
          <thead>
            <tr>
              <th scope="col" className="type-mono-sm">
                Pattern
              </th>
              <th scope="col" className="type-mono-sm redaction-tab__count-col">
                Count
              </th>
              {onPreviewClick ? (
                <th scope="col" className="type-mono-sm">
                  Action
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {by_pattern.map((row) => (
              <tr key={row.pattern_name}>
                <td className="type-mono">{row.pattern_name}</td>
                <td className="type-mono redaction-tab__count-col tabular-nums">{row.count}</td>
                {onPreviewClick ? (
                  <td>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        onPreviewClick(row.pattern_name, `[REDACTED:${row.pattern_name}]`)
                      }
                    >
                      Preview
                    </Button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="type-body-sm redaction-tab__opt-in">
        Preview-original is opt-in. Enable in Settings → Redaction → "Allow in-memory preview".
      </p>
    </div>
  );
}
