import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeRowHash, verifyChain, type AuditLogRow } from '@/db/audit-log-hash';

/**
 * Audit-log hash chain (B5 §7.1) must:
 *   1. Produce stable hashes for identical inputs (deterministic).
 *   2. Detect any in-place row mutation (row_hash mismatch).
 *   3. Detect any deletion (prev_hash chain break).
 */

async function buildChain(events: ReadonlyArray<Omit<AuditLogRow, 'id' | 'row_hash'>>): Promise<AuditLogRow[]> {
  const rows: AuditLogRow[] = [];
  let prev: string | null = null;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    const rowHash = await computeRowHash({ ...ev, prev_hash: prev });
    rows.push({ id: i + 1, ...ev, prev_hash: prev, row_hash: rowHash });
    prev = rowHash;
  }
  return rows;
}

describe('audit-log hash chain', () => {
  it('produces deterministic row hashes', async () => {
    const a = await computeRowHash({
      event_type: 'tamper_dismissed',
      packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      details: '{"by":"daniel"}',
      occurred_at: '2026-05-09T12:00:00Z',
    });
    const b = await computeRowHash({
      event_type: 'tamper_dismissed',
      packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      details: '{"by":"daniel"}',
      occurred_at: '2026-05-09T12:00:00Z',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies an intact chain', async () => {
    const chain = await buildChain([
      { event_type: 'settings_changed_via_ui', details: '{"field":"theme"}', occurred_at: '2026-05-09T11:00:00Z' },
      { event_type: 'tamper_dismissed', packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', details: '{}', occurred_at: '2026-05-09T11:30:00Z' },
      { event_type: 'tamper_re_verified', packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', details: '{}', occurred_at: '2026-05-09T11:35:00Z' },
    ]);
    const result = await verifyChain(chain);
    expect(result.ok).toBe(true);
    expect(result.brokenAt).toBeNull();
  });

  it('detects in-place row mutation', async () => {
    const chain = await buildChain([
      { event_type: 'tamper_dismissed', details: '{}', occurred_at: '2026-05-09T11:00:00Z' },
      { event_type: 'tamper_dismissed', details: '{}', occurred_at: '2026-05-09T11:30:00Z' },
    ]);
    chain[1]!.details = '{"by":"attacker"}';
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it('detects mid-chain deletion', async () => {
    const chain = await buildChain([
      { event_type: 'tamper_dismissed', details: '{"i":1}', occurred_at: '2026-05-09T11:00:00Z' },
      { event_type: 'tamper_dismissed', details: '{"i":2}', occurred_at: '2026-05-09T11:30:00Z' },
      { event_type: 'tamper_dismissed', details: '{"i":3}', occurred_at: '2026-05-09T11:35:00Z' },
    ]);
    // Splice out the second row; the third's prev_hash now misaligns.
    const tampered = [chain[0]!, chain[2]!];
    const result = await verifyChain(tampered);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(3);
  });

  // Per PR #6 cycle-1 review F8 (P2 testing-coverage consensus HIGH):
  // The previous '|'-joined hash input was vulnerable to field-confusion —
  // a malicious `details` containing a literal '|' could collide with a
  // different (event_type, packet_id, details) triple. The length-prefix
  // wire format (LEN:VALUE for every field) is collision-free.
  describe('field-confusion defense (length-prefix)', () => {
    it('rejects the documented collision: ("X", null, "Y|Z") vs ("X", "Y", "Z")', async () => {
      const a = await computeRowHash({
        event_type: 'X',
        packet_id: null,
        details: 'Y|Z',
        occurred_at: 'T',
      });
      const b = await computeRowHash({
        event_type: 'X',
        packet_id: 'Y',
        details: 'Z',
        occurred_at: 'T',
      });
      expect(a).not.toBe(b);
    });

    it('rejects the trailing-pipe collision: ("X|", null, "Y") vs ("X", "", "Y")', async () => {
      const a = await computeRowHash({
        event_type: 'X|',
        packet_id: null,
        details: 'Y',
        occurred_at: 'T',
      });
      const b = await computeRowHash({
        event_type: 'X',
        packet_id: '',
        details: 'Y',
        occurred_at: 'T',
      });
      expect(a).not.toBe(b);
    });

    it('null packet_id and empty-string packet_id produce different hashes', async () => {
      // Both could plausibly happen at the IPC boundary; the hash must
      // distinguish them so a 'null = empty-string' substitution attack
      // doesn't exist.
      const a = await computeRowHash({
        event_type: 'tamper_dismissed',
        packet_id: null,
        details: 'X',
        occurred_at: 'T',
      });
      const b = await computeRowHash({
        event_type: 'tamper_dismissed',
        packet_id: '',
        details: 'X',
        occurred_at: 'T',
      });
      expect(a).not.toBe(b);
    });

    it('property: distinct (event_type, packet_id, details, occurred_at, prev_hash) tuples never collide on the hash input', async () => {
      // fast-check randomly explores the FULL 5-field row space (cycle-2
      // N23: previous version fixed occurred_at + prev_hash to constant
      // values, leaving the bijection across those fields untested).
      // Asserts: if any field differs, the hashes differ. Exercises the
      // length-prefix invariant adversarially across every column.
      // numRuns=64 — sha256 collisions are computationally infeasible, so
      // this is a test of the LP encoding, not of sha256.
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            event_type: fc.string({ maxLength: 64 }),
            packet_id: fc.option(fc.string({ maxLength: 32 }), { nil: null }),
            details: fc.string({ maxLength: 256 }),
            occurred_at: fc.string({ minLength: 1, maxLength: 32 }),
            prev_hash: fc.option(fc.hexaString({ minLength: 64, maxLength: 64 }), { nil: null }),
          }),
          fc.record({
            event_type: fc.string({ maxLength: 64 }),
            packet_id: fc.option(fc.string({ maxLength: 32 }), { nil: null }),
            details: fc.string({ maxLength: 256 }),
            occurred_at: fc.string({ minLength: 1, maxLength: 32 }),
            prev_hash: fc.option(fc.hexaString({ minLength: 64, maxLength: 64 }), { nil: null }),
          }),
          async (a, b) => {
            // Skip if the tuples are identical — same hash is correct.
            const same =
              a.event_type === b.event_type &&
              (a.packet_id ?? null) === (b.packet_id ?? null) &&
              a.details === b.details &&
              a.occurred_at === b.occurred_at &&
              (a.prev_hash ?? null) === (b.prev_hash ?? null);
            if (same) return true;
            const ha = await computeRowHash({
              event_type: a.event_type,
              packet_id: a.packet_id,
              details: a.details,
              occurred_at: a.occurred_at,
              prev_hash: a.prev_hash ?? undefined,
            });
            const hb = await computeRowHash({
              event_type: b.event_type,
              packet_id: b.packet_id,
              details: b.details,
              occurred_at: b.occurred_at,
              prev_hash: b.prev_hash ?? undefined,
            });
            return ha !== hb;
          },
        ),
        { numRuns: 64 },
      );
    });
  });
});
