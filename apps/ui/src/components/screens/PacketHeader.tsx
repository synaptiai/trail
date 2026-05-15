import './PacketHeader.css';
import { HorizonLine } from '@/components/primitives';
import type { PacketHeaderShape } from '@/services/packet-loader';

/**
 * <PacketHeader> (B4 §4.2 / gh#9 criterion 1).
 *
 * Renders packet identity + provenance metadata above the packet view's
 * tab strip. The header is a `<header>` element so screen readers announce
 * the document landmark — this is the first surface a reviewer / auditor
 * lands on, and the Trail tab in audit mode is the dispositive surface
 * (B4 §4.7) so the announce-on-focus path matters.
 *
 * Fields displayed (per acceptance criterion 1):
 *   - packet_id (ULID truncated to first 8 chars for display; full ID on
 *     hover via `title` attribute — verbatim copyable)
 *   - session_id (full UUID for traceability)
 *   - generated_at (ISO 8601, rendered via tabular-nums)
 *   - generator name + version (Commit Mono, audit-relevant)
 *   - packet-N indicator: when `packet_n >= 2` we show "packet-2" hint;
 *     the explicit re-capture chain comes via <RecaptureBanner> which
 *     this component does NOT render (the banner sits above the header
 *     when needed, so the header itself stays narrow).
 */
export interface PacketHeaderProps {
  header: PacketHeaderShape;
  /** Total claim count across the packet — the header surfaces this for the
   *  reviewer's at-a-glance scan. Drives the "12 claims · X redactions" line. */
  claim_count: number;
  /** Optional — when present, surfaces "X of Y decided" below the histogram.
   *  Sprint 3a does not render the actions yet (Sprint 4 owns saga); the
   *  count itself ships now because it's a pure summary read. */
  decided_count?: number;
  /** Optional redactions count — computed from the packet's redaction_audit
   *  / redaction_metadata. Defaults to 0 when the packet has no redactions. */
  redaction_count?: number;
}

/** Truncate a ULID to "01ARZ3ND…" for display. Full ID lives in the
 *  title attribute so the audit-trail copy-paste path stays intact. */
function truncateId(id: string, head = 8): string {
  if (id.length <= head + 1) return id;
  return `${id.slice(0, head)}…`;
}

export function PacketHeader({
  header,
  claim_count,
  decided_count,
  redaction_count = 0,
}: PacketHeaderProps) {
  const decidedSuffix =
    typeof decided_count === 'number'
      ? ` · ${decided_count} of ${claim_count} decided`
      : '';
  const redactionSuffix =
    redaction_count > 0
      ? ` · ${redaction_count} redaction${redaction_count === 1 ? '' : 's'}`
      : '';
  return (
    <header className="packet-header" aria-label="Packet metadata">
      <div className="packet-header__title-row">
        <h1 className="packet-header__title type-display-2">
          {header.repository}
          <span className="packet-header__branch type-mono"> / {header.branch}</span>
        </h1>
        {header.is_recapture ? (
          <span
            className="packet-header__packet-n type-mono-sm"
            aria-label={
              header.packet_n !== null
                ? `Re-capture: this is packet number ${header.packet_n} in the chain`
                : 'Re-capture: this packet has a parent in its session chain'
            }
            title={`Parent packet: ${header.parent_packet_id ?? '—'}`}
          >
            {header.packet_n !== null ? `packet-${header.packet_n}` : 're-captured'}
          </span>
        ) : null}
      </div>
      <p className="packet-header__meta type-body-sm">
        <span className="packet-header__id type-mono-sm" title={header.packet_id}>
          {truncateId(header.packet_id)}
        </span>
        <span className="packet-header__sep" aria-hidden="true">
          {' · '}
        </span>
        <span>session </span>
        <span className="type-mono-sm" title={header.session_id}>
          {truncateId(header.session_id, 8)}
        </span>
        <span className="packet-header__sep" aria-hidden="true">
          {' · '}
        </span>
        <span>generated </span>
        <time
          dateTime={header.generated_at}
          className="packet-header__time type-mono-sm tabular-nums"
        >
          {header.generated_at}
        </time>
      </p>
      <p className="packet-header__sub type-body-sm">
        <span>by </span>
        <span className="type-mono-sm">
          {header.generator_name} v{header.generator_version}
        </span>
        <span className="packet-header__sep" aria-hidden="true">
          {' · '}
        </span>
        <span>schema </span>
        <span className="type-mono-sm">v{header.schema_version}</span>
      </p>
      <HorizonLine variant="packet-header" />
      <p className="packet-header__counts type-body-sm tabular-nums">
        {claim_count} claim{claim_count === 1 ? '' : 's'}
        {decidedSuffix}
        {redactionSuffix}
      </p>
    </header>
  );
}
