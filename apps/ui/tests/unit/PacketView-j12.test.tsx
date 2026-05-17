/**
 * PacketView × J12 banner — Sprint 4 cycle-1.5 F2 fix.
 *
 * Cycle-1 review F2 (P2): the watcher emitted parse-error / missing
 * variants of `packet-changed-externally` with `packet_id: ""`, so the
 * PacketView filter at PacketView.tsx:146
 *   if (payload.packet_id === packetId) setTamper(...)
 * silently swallowed two of three J12 mismatch variants for the
 * currently-open packet (AC-4 PARTIAL).
 *
 * The Rust-side fix reverse-looks-up the packet_id from the watcher
 * path via libSQL `select_packet_id_by_path` BEFORE emitting, so the
 * payload now carries the correct packet_id for parse-error / missing
 * branches. This test exercises the React side of the contract: when
 * the event arrives with a non-empty packet_id matching the open
 * packet, the J12 banner fires for ALL three mismatch_type variants.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Inject a controllable subscribeFsWatch mock so the test can fire
// watcher events synchronously.
//
// v0.1.1 B6: `packet_id` is `string | null` on the wire (was always
// a string in cycle-1.5; an unresolved packet_id was serialised as ""
// via `unwrap_or_default`). The empty-string regression test below is
// now expressed as `packet_id: null`.
let lastCallback:
  | ((payload: {
      packet_id: string | null;
      mismatch_type: 'hash-mismatch' | 'missing' | 'parse-error';
      message?: string;
    }) => void)
  | null = null;
let unsubscribeFn: () => void = () => {};

vi.mock('@/services/watcher-events', () => ({
  subscribeFsWatch: vi.fn(async (cbs: {
    onPacketChangedExternally?: (payload: {
      packet_id: string | null;
      mismatch_type: 'hash-mismatch' | 'missing' | 'parse-error';
      message?: string;
    }) => void;
  }) => {
    lastCallback = cbs.onPacketChangedExternally ?? null;
    return unsubscribeFn;
  }),
}));

// PacketView pulls invoke from @/ipc/client for the audit-log dismiss
// path; the audit call is fire-and-forget so we mock it as a noop.
vi.mock('@/ipc/client', async () => {
  const actual = await vi.importActual<typeof import('@/ipc/client')>('@/ipc/client');
  return {
    ...actual,
    invoke: vi.fn(async () => ({ ok: true })),
  };
});

import { PacketView } from '@/components/screens/PacketView';
import type { LoadedPacket } from '@/services/packet-loader';

const PACKET_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const FIXTURE: LoadedPacket = {
  source_path: '/test/fixture.yml',
  header: {
    packet_id: PACKET_ID,
    session_id: '18e374b5-4eb9-424d-a3ff-a639d1c6fada',
    generated_at: '2026-05-09T12:00:00.000+00:00',
    generator_name: 'trail',
    generator_version: '0.1.0-dev',
    schema_version: '0.1.1',
    parent_packet_id: null,
    packet_n: 1,
    is_recapture: false,
    repository: 'synaptiai/trail',
    branch: 'main',
  },
  claims: [
    {
      id: 'CLAIM-001',
      stable_id: 'aaaaaaaaaaaaaaaa',
      text: 'low-risk claim',
      evidence_refs: ['DIFF-001'],
      evidence_count: 1,
      confidence: 'supported',
      risk_level: 'low',
    },
  ],
  histogram: { low: 1, med: 0, high: 0, crit: 0, classified_total: 1 },
  approval_trail: [],
  diff_summary: {
    base_sha: '0000000000000000000000000000000000000000',
    head_sha: '1111111111111111111111111111111111111111',
    files_changed: 1,
    lines_added: 1,
    lines_deleted: 0,
    modules_touched: ['src'],
    semantic_changes: [],
  },
  redaction_summary: {
    pattern_set_version: '0.1.3',
    pattern_set_origin: 'bundled',
    redactions_applied: 0,
    by_pattern: [],
    validation_errors: [],
  },
  posted_to_pr: [],
};

describe('<PacketView> J12 banner × all three mismatch types (cycle-1.5 F2)', () => {
  beforeEach(() => {
    lastCallback = null;
  });
  afterEach(() => {
    lastCallback = null;
  });

  async function mountAndCaptureCallback() {
    render(
      <PacketView packetId={PACKET_ID} persona="creator" loadedPacket={FIXTURE} />,
    );
    // The subscribeFsWatch mock is async; React installs the
    // useEffect cleanup AFTER the promise resolves. Wait until our
    // mock has captured the callback.
    await waitFor(() => {
      expect(lastCallback).not.toBeNull();
    });
  }

  it('fires for hash-mismatch when packet_id matches open packet', async () => {
    await mountAndCaptureCallback();
    await act(async () => {
      lastCallback!({ packet_id: PACKET_ID, mismatch_type: 'hash-mismatch' });
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('fires for parse-error when packet_id matches open packet (F2 closure)', async () => {
    // Cycle-1 broken state: payload.packet_id was '' so the filter
    // never matched. The Rust-side reverse lookup now populates the
    // resolved packet_id so the React filter trips.
    await mountAndCaptureCallback();
    await act(async () => {
      lastCallback!({
        packet_id: PACKET_ID,
        mismatch_type: 'parse-error',
        message: 'invalid YAML',
      });
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('fires for missing when packet_id matches open packet (F2 closure)', async () => {
    await mountAndCaptureCallback();
    await act(async () => {
      lastCallback!({ packet_id: PACKET_ID, mismatch_type: 'missing' });
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('does NOT fire when payload.packet_id is null (v0.1.1 B6 wire shape)', async () => {
    // Regression guard: if the Rust-side reverse lookup returns None
    // (path not in libSQL — e.g., a freshly-captured packet not yet
    // ingested), the watcher emits with `packet_id: null` (v0.1.1 B6
    // replaced the cycle-1.5 `""` sentinel with proper JSON null).
    // The React filter MUST keep its per-packet guarantee — never
    // raise the J12 banner for a null packet_id, only for a positive
    // match on the open packet.
    await mountAndCaptureCallback();
    await act(async () => {
      lastCallback!({ packet_id: null, mismatch_type: 'parse-error' });
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does NOT fire when payload.packet_id targets a different packet', async () => {
    await mountAndCaptureCallback();
    await act(async () => {
      lastCallback!({
        packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
        mismatch_type: 'hash-mismatch',
      });
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
