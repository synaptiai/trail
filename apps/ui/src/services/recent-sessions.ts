/**
 * Recent-sessions pin service (gh#8 criterion 2).
 *
 * The "Your recent sessions" pin at the top of the Trail sidebar persists
 * across app restarts via `~/.trail/settings.json` (B5 §6.6). The Rust
 * settings module owns the file I/O via the atomic-write protocol; this TS
 * module is the React-facing wrapper:
 *
 *   - `loadPinnedSessions()`  — reads the pin list at sidebar mount.
 *   - `pinSession(sessionId)` — moves a session to the front (LRU).
 *   - `unpinSession(sessionId)` — removes a session from the pin list.
 *
 * Cap: 5 entries (B4 §3.4 "up to 5 most-recent sessions"). LRU eviction
 * happens implicitly on `pinSession` — the matching invariants are tested
 * in `tests/unit/recent-sessions.test.ts`.
 *
 * Outside the desktop shell (Storybook / vitest), the IPC layer raises
 * `IpcUnavailableError` on every call. The wrapper catches that and falls
 * back to an in-memory list so visual review still works.
 */
import { invoke, IpcUnavailableError, readSettings, writeSettings } from '@/ipc/client';
import type { Persona, Settings } from '@/ipc/contract';

export interface PinnedSession {
  session_id: string;
  pinned_at: string;
}

export const MAX_PINNED_SESSIONS = 5;

/** In-memory fallback used outside the Tauri shell. Keyed by ULID. */
let inMemoryFallback: PinnedSession[] = [];
let inMemoryActive = false;

/**
 * Load the pinned sessions, in LRU order (most-recent first). Returns an
 * empty array when no pins exist or the IPC bridge is unavailable.
 */
export async function loadPinnedSessions(): Promise<PinnedSession[]> {
  try {
    const settings = await readSettings();
    return settings.pinned_sessions ?? [];
  } catch (err) {
    if (err instanceof IpcUnavailableError) {
      inMemoryActive = true;
      return inMemoryFallback;
    }
    throw err;
  }
}

/**
 * Pin (or re-pin) a session. Idempotent: re-pinning an existing session
 * moves it to the front without duplicating; the LRU cap is enforced.
 *
 * Returns the new pinned-sessions list.
 */
export async function pinSession(
  sessionId: string,
  persona: Persona,
  now: Date = new Date(),
): Promise<PinnedSession[]> {
  if (sessionId.length === 0) {
    throw new Error('session_id must be non-empty');
  }
  const pinnedAt = now.toISOString();
  // Pure transform — applied to whichever side (real settings or fallback).
  const transform = (existing: PinnedSession[]): PinnedSession[] => {
    const filtered = existing.filter((p) => p.session_id !== sessionId);
    const next = [{ session_id: sessionId, pinned_at: pinnedAt }, ...filtered];
    return next.slice(0, MAX_PINNED_SESSIONS);
  };

  try {
    const settings = await readSettings();
    const next = transform(settings.pinned_sessions ?? []);
    // Cycle-4.5 W1 (PR #21): persona threading on writeSettings.
    await writeSettings({ pinned_sessions: next } as Partial<Settings>, persona);
    return next;
  } catch (err) {
    if (err instanceof IpcUnavailableError) {
      inMemoryActive = true;
      inMemoryFallback = transform(inMemoryFallback);
      return inMemoryFallback;
    }
    throw err;
  }
}

/**
 * Unpin a session. Idempotent: unpinning a non-pinned session is a no-op.
 */
export async function unpinSession(
  sessionId: string,
  persona: Persona,
): Promise<PinnedSession[]> {
  const transform = (existing: PinnedSession[]): PinnedSession[] =>
    existing.filter((p) => p.session_id !== sessionId);
  try {
    const settings = await readSettings();
    const next = transform(settings.pinned_sessions ?? []);
    // Cycle-4.5 W1 (PR #21): persona threading on writeSettings.
    await writeSettings({ pinned_sessions: next } as Partial<Settings>, persona);
    return next;
  } catch (err) {
    if (err instanceof IpcUnavailableError) {
      inMemoryFallback = transform(inMemoryFallback);
      return inMemoryFallback;
    }
    throw err;
  }
}

/**
 * Pure transform exposed for tests so the LRU + cap invariants are
 * verified without touching IPC.
 */
export function applyLru(
  existing: readonly PinnedSession[],
  sessionId: string,
  pinnedAt: string,
): PinnedSession[] {
  const filtered = existing.filter((p) => p.session_id !== sessionId);
  const next = [{ session_id: sessionId, pinned_at: pinnedAt }, ...filtered];
  return next.slice(0, MAX_PINNED_SESSIONS);
}

/** Test-only: reset the in-memory fallback. */
export function _resetForTest(): void {
  inMemoryFallback = [];
  inMemoryActive = false;
}

/** Test-only: peek at the in-memory state. */
export function _inMemoryStateForTest(): { active: boolean; pins: PinnedSession[] } {
  return { active: inMemoryActive, pins: [...inMemoryFallback] };
}

/**
 * Stub used by the sidebar to mirror a Rust-resolved query for the pinned
 * sessions: enriches the `PinnedSession` shape with the latest packet
 * captured for that session, joining against the rows already loaded for
 * the timeline. This is a CLIENT-side resolution because the SidebarRow
 * already includes session_id; no extra IPC roundtrip is needed.
 */
export function enrichPinsWithLatestPacket<
  TRow extends { session_id: string; packet_id: string; captured_at: string; display_name: string },
>(
  pins: readonly PinnedSession[],
  rows: readonly TRow[],
): Array<PinnedSession & { latest_packet_id?: string; display_name?: string; latest_captured_at?: string }> {
  // Build a session_id → latest row map (rows are already sorted by captured_at desc).
  const bySession = new Map<string, TRow>();
  for (const row of rows) {
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, row);
  }
  return pins.map((pin) => {
    const match = bySession.get(pin.session_id);
    if (!match) return pin;
    return {
      ...pin,
      latest_packet_id: match.packet_id,
      latest_captured_at: match.captured_at,
      display_name: match.display_name,
    };
  });
}
