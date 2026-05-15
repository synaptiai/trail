/**
 * Audit-log hash-chain (B5 §7.1, three-level integrity defense).
 *
 * Wire format (per PR #6 cycle-1 review F8 — field-confusion defense):
 *   row_hash = sha256(lp(event_type)
 *                  || lp(packet_id)
 *                  || lp(details)
 *                  || lp(occurred_at)
 *                  || lp(prev_hash))
 *
 * Where `lp(value)` is:
 *   - `n:`              when value is null/undefined (the "absent" sentinel)
 *   - `0:`              when value is the empty string (present, zero-length)
 *   - `<bytes>:value`   otherwise (UTF-8 byte length, decimal, ':')
 *
 * This removes the bijection failure of the previous '|'-joined scheme: a
 * `details` field containing a literal '|' could be reinterpreted as field
 * boundary collisions. The triple
 *   ('X', null, 'Y|Z', T, P)
 * and
 *   ('X', 'Y',  'Z',   T, P)
 * previously serialized to the SAME hash input ('X||Y|Z|T|P'). Length-prefix
 * is now collision-free, and the n: / 0: split forbids a 'null ↔ empty
 * string' substitution attack.
 *
 * Pure module — no I/O. The DB layer + tests both consume it; the chain
 * verifier surfaces the first mismatching id (the deletion point) so a
 * subsequent `audit_log_verify` IPC can report it.
 */

const subtleAvailable = typeof globalThis.crypto?.subtle !== 'undefined';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  if (subtleAvailable) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return bytesToHex(new Uint8Array(buf));
  }
  // Node-only fallback (used by vitest happy-dom env when SubtleCrypto is partial).
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}

export interface AuditLogRowInput {
  event_type: string;
  packet_id?: string | null | undefined;
  details: string;
  occurred_at: string;
  prev_hash?: string | null | undefined;
}

/**
 * Length-prefix a single field.
 *
 * Encoding:
 *   - null/undefined → `n:`         (the "absent" sentinel)
 *   - "" (empty)     → `0:`         (present, zero-length)
 *   - "X..."         → `<bytes>:X...` (present, UTF-8 byte length)
 *
 * UTF-8 byte length (NOT character count) is used so multi-byte characters
 * round-trip safely. `n:` and `0:` are deliberately distinct so a substitution
 * attack ('null' ↔ '') cannot collide.
 */
function lp(value: string | null | undefined): string {
  if (value == null) return 'n:';
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  return `${bytes.length}:${value}`;
}

export async function computeRowHash(row: AuditLogRowInput): Promise<string> {
  const input =
    lp(row.event_type) +
    lp(row.packet_id) +
    lp(row.details) +
    lp(row.occurred_at) +
    lp(row.prev_hash);
  return sha256Hex(input);
}

export interface AuditLogRow extends AuditLogRowInput {
  id: number;
  row_hash: string;
}

export interface ChainVerifyResult {
  ok: boolean;
  /** First mismatching row id (or null when chain is intact). */
  brokenAt: number | null;
}

/**
 * Walks the audit log in id-order and recomputes each row_hash.
 * Returns the first row id whose stored hash does not match the recomputed
 * value. Caller surfaces the breach as a tamper event.
 */
export async function verifyChain(rows: readonly AuditLogRow[]): Promise<ChainVerifyResult> {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const expectedPrev = i === 0 ? null : rows[i - 1]!.row_hash;
    if ((row.prev_hash ?? null) !== expectedPrev) return { ok: false, brokenAt: row.id };
    const recomputed = await computeRowHash({
      event_type: row.event_type,
      packet_id: row.packet_id ?? null,
      details: row.details,
      occurred_at: row.occurred_at,
      prev_hash: expectedPrev,
    });
    if (recomputed !== row.row_hash) return { ok: false, brokenAt: row.id };
  }
  return { ok: true, brokenAt: null };
}
