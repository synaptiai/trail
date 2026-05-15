/**
 * Saga client — typed wrapper around `save_decision` + `override_risk` IPC.
 *
 * Sprint 4 (gh#11 criterion 10): the only path through which the UI lands
 * a decision in libSQL + packet YAML. Callers MUST go through this module
 * so the at-time-of-call ISO-timestamp + by-identity defaulting are
 * applied uniformly.
 *
 * The Rust handler invokes the saga (B5 §3.1); this client adds:
 *   - timestamp injection (`new Date().toISOString()`)
 *   - by-identity resolution from settings (falls back to "you")
 *   - saga-failed → toast wiring (the caller is responsible for the
 *     toast emission so this stays test-friendly)
 */
import { invoke } from '@/ipc/client';
import type { DecisionKind, Persona, RiskLevel } from '@/ipc/contract';

export interface SubmitDecisionInput {
  packet_id: string;
  claim_id: string;
  decision: DecisionKind;
  reason?: string;
  /** Decider identity. If not provided, falls back to "you" (Sprint 4
   *  dev surface; a future sprint reads from settings). */
  by?: string;
  /**
   * Cycle-3 C4 (PR #21): persona threading. The Rust handler rejects
   * auditor with `IpcError::PersonaForbidden`; callers MUST pass the
   * active persona (sourced from `App.tsx::readPersonaFromUrl` so
   * client + server enforcement match). Defence-in-depth on top of the
   * UI gating that already prevents auditor from reaching the decision
   * shortcuts.
   */
  persona: Persona;
}

export async function submitDecision(input: SubmitDecisionInput): Promise<void> {
  const at = nowIso();
  const args: Record<string, unknown> = {
    packet_id: input.packet_id,
    claim_id: input.claim_id,
    decision: input.decision,
    by: input.by ?? 'you',
    at,
    persona: input.persona,
  };
  if (input.reason !== undefined) {
    args.reason = input.reason;
  }
  await invoke<{ ok: true }>('save_decision', args);
}

export interface SubmitOverrideInput {
  packet_id: string;
  claim_id: string;
  layer: 'creator' | 'reviewer';
  new_level: RiskLevel;
  reason: string;
  by?: string;
  /** Cycle-3 C4 (PR #21): persona threading — see SubmitDecisionInput. */
  persona: Persona;
}

export async function submitRiskOverride(input: SubmitOverrideInput): Promise<void> {
  const at = nowIso();
  await invoke<{ ok: true }>('override_risk', {
    packet_id: input.packet_id,
    claim_id: input.claim_id,
    layer: input.layer,
    new_level: input.new_level,
    reason: input.reason,
    by: input.by ?? 'you',
    at,
    persona: input.persona,
  });
}

/**
 * Format an ISO-8601 timestamp with the `+00:00` suffix mandated by the
 * schema (NOT `Z`). Mirrors capture-side `nowIso` in
 * apps/capture/src/post/posted-to-pr.ts character-for-character (F25).
 */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString().replace(/Z$/, '+00:00');
}
