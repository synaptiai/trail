import { describe, expect, it } from 'vitest';
import {
  IPC_COMMAND_SCHEMAS,
  PostToPrArgs,
  DecideOnPrArgs,
  SaveDecisionArgs,
  OverrideRiskArgs,
  AuditLogAppendArgs,
  ipcErrorSchema,
  uiAuditEventTypeSchema,
  settingsSchema,
} from '@/ipc/contract';

const VALID_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('IPC contract', () => {
  it('exposes the 12 B5 §6.1 commands + validate_capture_cli_path + decide_on_pr (gh#11 F3 + gh#12 AC-4)', () => {
    // Cycle-1.5 F3 added validate_capture_cli_path (13).
    // Sprint 5 (gh#12 AC-4) adds decide_on_pr to wire J9 reviewer-side
    // block-with-reason to Phase 3b's `trail packet decide`. The pin
    // canaries any future addition; updating the test is a deliberate
    // decision point with the cycle that added each entry documented.
    expect(Object.keys(IPC_COMMAND_SCHEMAS).sort()).toEqual([
      'audit_log_append',
      'decide_on_pr',
      'override_risk',
      'post_to_pr',
      'preview_redacted',
      'query_recent_sessions',
      'query_trail',
      'read_packet',
      'read_settings',
      'save_decision',
      'subscribe_fs_watch',
      'subscribe_settings_change',
      'validate_capture_cli_path',
      'write_settings',
    ]);
  });

  describe('post_to_pr', () => {
    it('rejects pr_number ≤ 0', () => {
      const r = PostToPrArgs.safeParse({
        packet_id: VALID_ULID,
        pr_number: 0,
        persona: 'creator',
      });
      expect(r.success).toBe(false);
    });

    it('rejects pr_number > i32 max', () => {
      const r = PostToPrArgs.safeParse({
        packet_id: VALID_ULID,
        pr_number: 2_147_483_648,
        persona: 'creator',
      });
      expect(r.success).toBe(false);
    });

    it('accepts pr_number=null (omit)', () => {
      const r = PostToPrArgs.safeParse({ packet_id: VALID_ULID, persona: 'creator' });
      expect(r.success).toBe(true);
    });

    // Cycle-2 C15 (PR #21): persona must be one of the three documented
    // values. The Rust handler rejects auditor with PersonaForbidden;
    // the Zod boundary tightens the surface area further by rejecting
    // any value outside the closed set.
    it('rejects unknown persona values (C15)', () => {
      const r = PostToPrArgs.safeParse({
        packet_id: VALID_ULID,
        persona: 'admin',
      });
      expect(r.success).toBe(false);
    });

    it('requires persona (C15)', () => {
      const r = PostToPrArgs.safeParse({ packet_id: VALID_ULID });
      expect(r.success).toBe(false);
    });

    it('accepts auditor at the Zod boundary; the Rust handler is the gate (C15)', () => {
      // Zod accepts any of the three valid personas — the Rust handler
      // is responsible for the auditor-rejection. Splitting the
      // enforcement allows the React UI to surface a typed error
      // message ("Auditor mode is read-only") via the IpcError variant
      // rather than a generic Zod-validation error.
      const r = PostToPrArgs.safeParse({ packet_id: VALID_ULID, persona: 'auditor' });
      expect(r.success).toBe(true);
    });
  });

  describe('decide_on_pr (gh#12 AC-4)', () => {
    const baseValid = {
      packet_id: VALID_ULID,
      claim_id: 'CLAIM-001',
      decision: 'block' as const,
      reason: 'breaks the build',
      by: 'reviewer@example.com',
      // Cycle-2 C15 (PR #21): persona threading required by Zod.
      persona: 'reviewer' as const,
    };
    it('accepts a valid block-with-reason payload', () => {
      const r = DecideOnPrArgs.safeParse(baseValid);
      expect(r.success).toBe(true);
    });
    it('accepts accept without reason', () => {
      const r = DecideOnPrArgs.safeParse({
        ...baseValid,
        decision: 'accept',
        reason: undefined,
      });
      expect(r.success).toBe(true);
    });
    it('rejects empty claim_id', () => {
      const r = DecideOnPrArgs.safeParse({ ...baseValid, claim_id: '' });
      expect(r.success).toBe(false);
    });
    it('rejects empty by', () => {
      const r = DecideOnPrArgs.safeParse({ ...baseValid, by: '' });
      expect(r.success).toBe(false);
    });
    // Cycle-3 C5 (PR #21): reason cap reverted to 500 (the product-UX
    // limit, matching the Rust `decide_on_pr` validator at ipc.rs:600).
    // The Rust ARGV_CAP_REASON of 2000 is the security ceiling, not the
    // user-facing limit. Tests for the 500-cap live in the C6 describe
    // block below to keep the cycle-3 changes co-located.
    it('rejects unknown decision values', () => {
      const r = DecideOnPrArgs.safeParse({ ...baseValid, decision: 'yolo' });
      expect(r.success).toBe(false);
    });
    it('rejects pr_number ≤ 0', () => {
      const r = DecideOnPrArgs.safeParse({ ...baseValid, pr_number: 0 });
      expect(r.success).toBe(false);
    });
    // Cycle-2 C14 (PR #21): mirror Rust is_argv_safe (no leading dash).
    it('rejects claim_id with leading dash (argv-flag injection guard)', () => {
      const r = DecideOnPrArgs.safeParse({ ...baseValid, claim_id: '--inject' });
      expect(r.success).toBe(false);
    });
    it('rejects by with leading dash (argv-flag injection guard)', () => {
      const r = DecideOnPrArgs.safeParse({ ...baseValid, by: '-h' });
      expect(r.success).toBe(false);
    });
    it('rejects reason with leading dash (argv-flag injection guard)', () => {
      const r = DecideOnPrArgs.safeParse({ ...baseValid, reason: '--mood=mad' });
      expect(r.success).toBe(false);
    });
    it('rejects claim_id > 256 chars (ARGV_CAP_IDENT)', () => {
      const r = DecideOnPrArgs.safeParse({
        ...baseValid,
        claim_id: 'c'.repeat(257),
      });
      expect(r.success).toBe(false);
    });
    it('rejects by > 256 chars (ARGV_CAP_IDENT)', () => {
      const r = DecideOnPrArgs.safeParse({ ...baseValid, by: 'b'.repeat(257) });
      expect(r.success).toBe(false);
    });
    // Cycle-2 C15 (PR #21): persona enforcement at the Zod boundary.
    it('rejects unknown persona values (C15)', () => {
      const r = DecideOnPrArgs.safeParse({ ...baseValid, persona: 'admin' });
      expect(r.success).toBe(false);
    });
    it('requires persona (C15)', () => {
      const { persona, ...withoutPersona } = baseValid;
      void persona;
      const r = DecideOnPrArgs.safeParse(withoutPersona);
      expect(r.success).toBe(false);
    });
    it('accepts auditor at the Zod boundary; Rust handler is the gate (C15)', () => {
      const r = DecideOnPrArgs.safeParse({ ...baseValid, persona: 'auditor' });
      expect(r.success).toBe(true);
    });
  });

  describe('save_decision', () => {
    const baseSave = {
      packet_id: VALID_ULID,
      claim_id: 'cl-1',
      decision: 'accept' as const,
      by: 'daniel',
      at: '2026-05-09T12:00:00Z',
      // Cycle-3 C4 (PR #21): persona is required.
      persona: 'creator' as const,
    };
    it('rejects invalid decision values', () => {
      const r = SaveDecisionArgs.safeParse({ ...baseSave, decision: 'yolo' });
      expect(r.success).toBe(false);
    });

    it('accepts the four documented decision kinds', () => {
      for (const d of ['accept', 'changes', 'block', 'reject']) {
        const r = SaveDecisionArgs.safeParse({ ...baseSave, decision: d });
        expect(r.success, `decision=${d}`).toBe(true);
      }
    });

    // Cycle-3 C4 (PR #21): persona is required by Zod and rejects
    // unknown values. Pairs with the Rust-side reject_auditor + the
    // Persona enum closed-set deserialize.
    it('requires persona (C4)', () => {
      const { persona, ...withoutPersona } = baseSave;
      void persona;
      const r = SaveDecisionArgs.safeParse(withoutPersona);
      expect(r.success).toBe(false);
    });
    it('rejects unknown persona values (C4)', () => {
      const r = SaveDecisionArgs.safeParse({ ...baseSave, persona: 'admin' });
      expect(r.success).toBe(false);
    });
    it('accepts auditor at the Zod boundary; Rust handler is the gate (C4)', () => {
      const r = SaveDecisionArgs.safeParse({ ...baseSave, persona: 'auditor' });
      expect(r.success).toBe(true);
    });
  });

  describe('override_risk (C4)', () => {
    const baseOv = {
      packet_id: VALID_ULID,
      claim_id: 'cl-1',
      layer: 'reviewer' as const,
      new_level: 'high' as const,
      reason: 'breaks build',
      by: 'reviewer@example.com',
      at: '2026-05-09T12:00:00Z',
      persona: 'reviewer' as const,
    };
    it('accepts a valid payload', () => {
      const r = OverrideRiskArgs.safeParse(baseOv);
      expect(r.success).toBe(true);
    });
    it('requires persona (C4)', () => {
      const { persona, ...withoutPersona } = baseOv;
      void persona;
      const r = OverrideRiskArgs.safeParse(withoutPersona);
      expect(r.success).toBe(false);
    });
    it('rejects unknown persona values (C4)', () => {
      const r = OverrideRiskArgs.safeParse({ ...baseOv, persona: 'admin' });
      expect(r.success).toBe(false);
    });
  });

  // Cycle-3 C1 (PR #21): the runtime ipcErrorSchema must include
  // persona-forbidden so client.ts::asIpcError validates it as a typed
  // variant, not coerce to internal. Without this contract addition,
  // a legitimate Rust-side rejection round-trips as IpcError.internal
  // and the Banner shows generic copy.
  describe('ipcErrorSchema persona-forbidden (C1)', () => {
    it('accepts the persona-forbidden variant emitted by the Rust handler', () => {
      const r = ipcErrorSchema.safeParse({
        kind: 'persona-forbidden',
        persona: 'auditor',
        command: 'post_to_pr',
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.kind).toBe('persona-forbidden');
      }
    });

    it('rejects persona-forbidden missing required fields', () => {
      const missingPersona = ipcErrorSchema.safeParse({
        kind: 'persona-forbidden',
        command: 'post_to_pr',
      });
      expect(missingPersona.success).toBe(false);
      const missingCommand = ipcErrorSchema.safeParse({
        kind: 'persona-forbidden',
        persona: 'auditor',
      });
      expect(missingCommand.success).toBe(false);
    });
  });

  // Cycle-3 C6 (PR #21): control-character rejection on argv-safe
  // fields. Pairs with Rust `is_argv_safe`'s `c.is_control()` check.
  describe('decide_on_pr control-char guard (C6)', () => {
    const valid = {
      packet_id: VALID_ULID,
      claim_id: 'CLAIM-001',
      decision: 'accept' as const,
      by: 'reviewer',
      persona: 'reviewer' as const,
    };
    it('rejects claim_id containing NUL', () => {
      const r = DecideOnPrArgs.safeParse({ ...valid, claim_id: 'a b' });
      expect(r.success).toBe(false);
    });
    it('rejects by containing newline', () => {
      const r = DecideOnPrArgs.safeParse({ ...valid, by: 'alice\nbob' });
      expect(r.success).toBe(false);
    });
    it('rejects reason containing tab', () => {
      const r = DecideOnPrArgs.safeParse({
        ...valid,
        decision: 'block',
        reason: 'has\ttab',
      });
      expect(r.success).toBe(false);
    });
    it('rejects reason containing DEL (0x7F)', () => {
      const r = DecideOnPrArgs.safeParse({
        ...valid,
        decision: 'block',
        reason: 'delchar',
      });
      expect(r.success).toBe(false);
    });
    // Cycle-3 C5 (PR #21): reason cap is 500 chars (UX limit; Rust
    // ARGV_CAP_REASON 2000 is the security ceiling, not the UX limit).
    it('rejects reason > 500 chars (C5: UX limit, was cycle-2 2000)', () => {
      const r = DecideOnPrArgs.safeParse({
        ...valid,
        decision: 'block',
        reason: 'x'.repeat(501),
      });
      expect(r.success).toBe(false);
    });
    it('accepts reason at exactly 500 chars (C5 boundary)', () => {
      const r = DecideOnPrArgs.safeParse({
        ...valid,
        decision: 'block',
        reason: 'x'.repeat(500),
      });
      expect(r.success).toBe(true);
    });
  });

  describe('audit_log_append', () => {
    it('admits ONLY the three UI-emittable event types', () => {
      const allowed = ['tamper_dismissed', 'tamper_re_verified', 'settings_changed_via_ui'];
      for (const ev of allowed) {
        // Cycle-4.5 W2 (PR #21): persona threading required at the Zod boundary.
        expect(
          AuditLogAppendArgs.safeParse({
            event_type: ev,
            details: {},
            persona: 'creator',
          }).success,
        ).toBe(true);
      }
      expect(uiAuditEventTypeSchema.safeParse('tamper_detected').success).toBe(false);
      expect(uiAuditEventTypeSchema.safeParse('saga_recovered').success).toBe(false);
    });

    // Cycle-4.5 W2 (PR #21): the persona field is now required at the Zod
    // boundary. Without it the Rust handler still rejects (defence in depth)
    // but tightening the React boundary turns the rejection into a typed
    // validation error rather than a serde failure.
    it('rejects when persona is omitted (W2)', () => {
      const r = AuditLogAppendArgs.safeParse({
        event_type: 'tamper_dismissed',
        details: {},
      });
      expect(r.success).toBe(false);
    });

    it('rejects unknown persona values (W2)', () => {
      const r = AuditLogAppendArgs.safeParse({
        event_type: 'tamper_dismissed',
        details: {},
        persona: 'admin',
      });
      expect(r.success).toBe(false);
    });
  });

  describe('settings schema', () => {
    it('applies sensible defaults', () => {
      const r = settingsSchema.parse({});
      expect(r.theme).toBe('system');
      expect(r.density).toBe('comfortable');
      expect(r.disable_tamper_warnings).toBe(false);
      expect(r.heavy_redaction_threshold).toBe(15);
      // v0.1.3 bug-2: default is the BINARY name `trail`, not the npm
      // package name (the package's `bin` field installs `trail`).
      expect(r.capture_cli_path).toBe('trail');
    });

    it('rejects unknown theme values', () => {
      const r = settingsSchema.safeParse({ theme: 'off' });
      expect(r.success).toBe(false);
    });

    it('clamps redaction threshold range', () => {
      expect(settingsSchema.safeParse({ heavy_redaction_threshold: 0 }).success).toBe(false);
      expect(settingsSchema.safeParse({ heavy_redaction_threshold: 501 }).success).toBe(false);
    });
  });
});
