import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyLru,
  enrichPinsWithLatestPacket,
  MAX_PINNED_SESSIONS,
  _resetForTest,
  type PinnedSession,
} from '@/services/recent-sessions';

beforeEach(() => {
  _resetForTest();
});

describe('recent-sessions LRU helper (gh#8 criterion 2)', () => {
  it('inserts a new pin at the front', () => {
    const next = applyLru([], 'sess-A', '2026-05-09T12:00:00Z');
    expect(next).toHaveLength(1);
    expect(next[0]?.session_id).toBe('sess-A');
  });

  it('moves an existing pin to the front (no duplicate)', () => {
    const start: PinnedSession[] = [
      { session_id: 'sess-A', pinned_at: '2026-05-09T01:00:00Z' },
      { session_id: 'sess-B', pinned_at: '2026-05-09T02:00:00Z' },
    ];
    const next = applyLru(start, 'sess-A', '2026-05-09T03:00:00Z');
    expect(next).toHaveLength(2);
    expect(next[0]?.session_id).toBe('sess-A');
    expect(next[0]?.pinned_at).toBe('2026-05-09T03:00:00Z');
    expect(next[1]?.session_id).toBe('sess-B');
  });

  it('caps at MAX_PINNED_SESSIONS', () => {
    let pins: PinnedSession[] = [];
    for (let i = 0; i < MAX_PINNED_SESSIONS + 3; i++) {
      pins = applyLru(pins, `s-${i}`, `2026-05-09T${String(i).padStart(2, '0')}:00:00Z`);
    }
    expect(pins).toHaveLength(MAX_PINNED_SESSIONS);
    expect(pins[0]?.session_id).toBe(`s-${MAX_PINNED_SESSIONS + 2}`);
  });

  it('produces ISO-8601-ish pinned_at strings', () => {
    const pins = applyLru([], 'sess-A', '2026-05-09T12:00:00.000Z');
    expect(pins[0]?.pinned_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('enrichPinsWithLatestPacket', () => {
  it('joins pins to rows by session_id, preserving order', () => {
    const pins: PinnedSession[] = [
      { session_id: 'A', pinned_at: '2026-05-09T01:00:00Z' },
      { session_id: 'C', pinned_at: '2026-05-09T02:00:00Z' },
    ];
    const rows = [
      { session_id: 'A', packet_id: 'p1', captured_at: 't1', display_name: 'A name' },
      { session_id: 'B', packet_id: 'p2', captured_at: 't2', display_name: 'B name' },
      { session_id: 'A', packet_id: 'p1-old', captured_at: 't0', display_name: 'A name old' },
    ];
    const enriched = enrichPinsWithLatestPacket(pins, rows);
    expect(enriched).toHaveLength(2);
    // 'A' uses the FIRST matching row (rows are pre-sorted by captured_at desc).
    expect(enriched[0]?.latest_packet_id).toBe('p1');
    expect(enriched[0]?.display_name).toBe('A name');
    // 'C' has no row → latest_packet_id stays undefined.
    expect(enriched[1]?.latest_packet_id).toBeUndefined();
  });

  it('returns the original pin unchanged when no matching row', () => {
    const pins: PinnedSession[] = [
      { session_id: 'unknown', pinned_at: '2026-05-09T01:00:00Z' },
    ];
    const enriched = enrichPinsWithLatestPacket(pins, []);
    expect(enriched).toEqual(pins);
  });
});

describe('MAX_PINNED_SESSIONS contract', () => {
  it('matches the spec value (5)', () => {
    expect(MAX_PINNED_SESSIONS).toBe(5);
  });
});
