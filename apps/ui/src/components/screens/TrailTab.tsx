import { ApprovalTrail } from './ApprovalTrail';
import type { ApprovalTrailEntryShape } from '@/services/packet-loader';
import type { Persona } from '@/ipc/contract';

/**
 * <TrailTab> — Sprint 3b body for the Trail tab.
 *
 * Thin wrapper around `<ApprovalTrail>` (Sprint 3a) so the four-tab spine
 * has symmetric component composition. The wrapper's job is the prop
 * surface (persona-aware empty-state elevation) without leaking ApprovalTrail's
 * internals into PacketView; Sprint 4's posted_to_pr edge will land here.
 */

export interface TrailTabProps {
  entries: ApprovalTrailEntryShape[];
  persona: Persona;
  /**
   * When true (auditor + HIGH/CRIT histogram + empty trail), the empty
   * state escalates to "Audit-relevant: HIGH-risk packet without recorded
   * approval" per B4 §4.7. Computed by PacketView, not this component, so
   * the audit-finding logic lives in one place.
   */
  audit_high_risk_unrecorded: boolean;
}

export function TrailTab({ entries, persona, audit_high_risk_unrecorded }: TrailTabProps) {
  return (
    <ApprovalTrail
      entries={entries}
      persona={persona}
      audit_high_risk_unrecorded={audit_high_risk_unrecorded}
    />
  );
}
