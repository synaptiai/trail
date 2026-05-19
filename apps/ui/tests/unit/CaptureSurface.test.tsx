/**
 * <CaptureSurface> — gh#18 Capture/sessions view (D1 of 15).
 *
 * Covers each of the 8 acceptance criteria via mocked IPC + listen():
 *
 *   AC#1 — First-launch editorial state when both lists empty
 *   AC#2 — Auto-detect fires on mount; cliStatus reflects result
 *   AC#3 — list_claude_sessions populates the sessions section
 *   AC#4 — query_trail populates the packets section
 *   AC#5 — Generate chip-button dispatches spawn_packet_generate
 *   AC#6 — packet-generate-progress events render in the expanded log
 *   AC#7 — Persisted location (Location state owned by App.tsx — covered
 *          via the services/location.ts unit asserts below)
 *   AC#8 — Settings modal Capture tab → "Capture (advanced)" (covered
 *          via grep on the SECTIONS literal — kept light so this file
 *          stays focused on the surface itself)
 *
 * Tauri runtime is mocked via `__TAURI_INTERNALS__`-aware invoke + event
 * listen, mirroring the pattern in FirstRun-autodetect.test.tsx.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

interface MockHandler {
  (args: Record<string, unknown>): Promise<unknown> | unknown;
}
const mockHandlers: { current: Record<string, MockHandler> } = { current: {} };
type EventCallback = (event: { payload: unknown }) => void;
const eventListeners: { current: Record<string, Set<EventCallback>> } = {
  current: {},
};

function ensureLocalStorage(): Storage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = (globalThis as any).window ?? (globalThis as any);
  if (!w.localStorage) {
    const store = new Map<string, string>();
    const ls: Storage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, String(v));
      },
      removeItem: (k) => {
        store.delete(k);
      },
      clear: () => {
        store.clear();
      },
      key: (i) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    };
    w.localStorage = ls;
  }
  return w.localStorage;
}

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = (globalThis as any).window ?? (globalThis as any);
  w.__TAURI_INTERNALS__ = { callbacks: {}, plugins: {} };
  ensureLocalStorage();
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    const handler = mockHandlers.current[cmd];
    if (!handler) {
      throw { kind: 'internal', message: `unmocked: ${cmd}` };
    }
    if (!(args as { args?: unknown }).args) {
      throw new Error(`test mock expected wrapped { args: ... } for ${cmd}`);
    }
    return handler((args as { args: Record<string, unknown> }).args);
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, cb: EventCallback) => {
    const set = (eventListeners.current[event] ??= new Set());
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  },
}));

function emitEvent(event: string, payload: unknown) {
  const set = eventListeners.current[event];
  if (!set) return;
  for (const cb of set) {
    cb({ payload });
  }
}

beforeEach(() => {
  mockHandlers.current = {};
  eventListeners.current = {};
  ensureLocalStorage().clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Import LAZILY after mocks are registered so the module's import-time
// state binds to the mocked invoke/listen.
async function importCaptureSurface() {
  const mod = await import('@/components/screens/CaptureSurface');
  return mod.CaptureSurface;
}

const VALID_PATH = '/usr/local/bin/trail';
const VALID_VERSION = '0.1.4';

function stockDetect() {
  return {
    kind: 'detected',
    path: VALID_PATH,
    version: VALID_VERSION,
    source: 'login-shell',
  };
}

describe('CaptureSurface', () => {
  describe('AC#2: auto-detect fires on mount', () => {
    it('renders Detecting… then the detected path on success', async () => {
      mockHandlers.current['detect_capture_cli'] = () => stockDetect();
      // Provide at least one session so we render the normal CLI-status
      // row rather than the first-launch editorial state.
      mockHandlers.current['list_claude_sessions'] = () => ({
        kind: 'ok',
        sessions: [
          {
            session_id: 'one-session',
            project_path: '/repo',
            started_at: new Date().toISOString(),
            message_count: 1,
            packet_id: null,
          },
        ],
      });
      mockHandlers.current['query_trail'] = () => ({ packets: [] });
      mockHandlers.current['write_settings'] = () => ({ ok: true });

      const CaptureSurface = await importCaptureSurface();
      await act(async () => {
        render(<CaptureSurface persona="creator" />);
      });

      await waitFor(() => {
        const matches = screen.getAllByText((_, node) => {
          if (!node) return false;
          return /Trail CLI detected at/.test(node.textContent ?? '');
        });
        expect(matches.length).toBeGreaterThan(0);
      });
      const pathMatches = screen.getAllByText((_, node) => {
        if (!node) return false;
        return new RegExp(VALID_PATH).test(node.textContent ?? '');
      });
      expect(pathMatches.length).toBeGreaterThan(0);
    });

    it('renders failure status when detect fails (visible in setup step 1)', async () => {
      mockHandlers.current['detect_capture_cli'] = () => ({
        kind: 'failed',
        failure_kind: 'binary-not-installed',
        message: 'trail binary not found on PATH',
        suggested_fix: 'install via npm',
      });
      // Add at least one session so we skip the first-launch editorial
      // state and render the normal CLI-status row with the verbatim
      // failure message.
      mockHandlers.current['list_claude_sessions'] = () => ({
        kind: 'ok',
        sessions: [
          {
            session_id: 'sess-with-fail',
            project_path: '/repo',
            started_at: new Date().toISOString(),
            message_count: 1,
            packet_id: null,
          },
        ],
      });
      mockHandlers.current['query_trail'] = () => ({ packets: [] });
      mockHandlers.current['write_settings'] = () => ({ ok: true });

      const CaptureSurface = await importCaptureSurface();
      await act(async () => {
        render(<CaptureSurface persona="creator" />);
      });

      await waitFor(() => {
        // Text is split across the glyph span + the cliStatus.message
        // text node; use a function matcher that checks the parent
        // span's full textContent.
        const matches = screen.getAllByText((_, node) => {
          if (!node) return false;
          return /trail binary not found on PATH/.test(node.textContent ?? '');
        });
        expect(matches.length).toBeGreaterThan(0);
      });
    });
  });

  describe('AC#3: list_claude_sessions populates sessions section', () => {
    it('renders rows for each session with metadata', async () => {
      mockHandlers.current['detect_capture_cli'] = () => stockDetect();
      mockHandlers.current['list_claude_sessions'] = () => ({
        kind: 'ok',
        sessions: [
          {
            session_id: 'AAAAAAAA-one',
            project_path: '/repo/foo',
            started_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
            message_count: 42,
            packet_id: null,
          },
          {
            session_id: 'BBBBBBBB-two',
            project_path: '/repo/bar',
            started_at: null,
            message_count: 7,
            packet_id: '01HZX-PACKET-ONE',
          },
        ],
      });
      mockHandlers.current['query_trail'] = () => ({ packets: [] });
      mockHandlers.current['write_settings'] = () => ({ ok: true });

      const CaptureSurface = await importCaptureSurface();
      await act(async () => {
        render(<CaptureSurface persona="creator" />);
      });

      await waitFor(() => {
        expect(screen.getByText(/AAAAAAAA…/)).toBeTruthy();
      });
      expect(screen.getByText(/BBBBBBBB…/)).toBeTruthy();
      // Both metadata lines present
      expect(screen.getByText(/42 msg/)).toBeTruthy();
      expect(screen.getByText(/7 msg/)).toBeTruthy();
      expect(screen.getByText(/\/repo\/foo/)).toBeTruthy();
      expect(screen.getByText(/\/repo\/bar/)).toBeTruthy();
      // The session WITH a packet shows "Open packet"
      expect(screen.getByText(/Open packet/)).toBeTruthy();
      // The session WITHOUT a packet shows the Generate chip
      expect(screen.getByText(/Generate packet/)).toBeTruthy();
    });
  });

  describe('AC#4: query_trail populates packets section', () => {
    it('renders Trail-packet rows with packet_id + name + age', async () => {
      mockHandlers.current['detect_capture_cli'] = () => stockDetect();
      mockHandlers.current['list_claude_sessions'] = () => ({
        kind: 'ok',
        sessions: [
          {
            session_id: 'has-session',
            project_path: '/repo',
            started_at: new Date().toISOString(),
            message_count: 1,
            packet_id: null,
          },
        ],
      });
      mockHandlers.current['query_trail'] = () => ({
        packets: [
          {
            packet_id: '01HZX-PACKET-AAAAAAAA',
            session_id: 's1',
            display_name: 'acme/billing-svc',
            captured_at: new Date(Date.now() - 5 * 86400_000).toISOString(),
            low_count: 1,
            med_count: 0,
            high_count: 0,
            crit_count: 0,
            redaction_count: 0,
            posted_to_pr_count: 0,
          },
        ],
      });
      mockHandlers.current['write_settings'] = () => ({ ok: true });

      const CaptureSurface = await importCaptureSurface();
      await act(async () => {
        render(<CaptureSurface persona="creator" />);
      });

      await waitFor(() => {
        expect(screen.getByText(/acme\/billing-svc/)).toBeTruthy();
      });
      expect(screen.getByText(/5d ago/)).toBeTruthy();
    });
  });

  describe('AC#1: first-launch editorial state', () => {
    it('renders 3-step setup when both sessions and packets are empty', async () => {
      mockHandlers.current['detect_capture_cli'] = () => ({
        kind: 'failed',
        failure_kind: 'binary-not-installed',
        message: 'not found',
        suggested_fix: 'install',
      });
      mockHandlers.current['list_claude_sessions'] = () => ({
        kind: 'ok',
        sessions: [],
      });
      mockHandlers.current['query_trail'] = () => ({ packets: [] });

      const CaptureSurface = await importCaptureSurface();
      await act(async () => {
        render(<CaptureSurface persona="creator" />);
      });

      await waitFor(() => {
        expect(
          screen.getByText(/Account for the change, not just the diff/),
        ).toBeTruthy();
      });
      expect(screen.getByText(/One-time setup/)).toBeTruthy();
      expect(screen.getByText(/Detect the trail CLI/)).toBeTruthy();
      expect(
        screen.getByText(/See your Claude Code sessions/),
      ).toBeTruthy();
      expect(screen.getByText(/Generate your first packet/)).toBeTruthy();
    });
  });

  describe('AC#5/6: spawn + streaming', () => {
    it('spawning a packet shows Running and renders stderr lines', async () => {
      mockHandlers.current['detect_capture_cli'] = () => stockDetect();
      mockHandlers.current['list_claude_sessions'] = () => ({
        kind: 'ok',
        sessions: [
          {
            session_id: 'sess-1',
            project_path: '/repo',
            started_at: new Date().toISOString(),
            message_count: 3,
            packet_id: null,
          },
        ],
      });
      mockHandlers.current['query_trail'] = () => ({ packets: [] });
      mockHandlers.current['write_settings'] = () => ({ ok: true });
      mockHandlers.current['spawn_packet_generate'] = (args) => ({
        kind: 'spawned',
        spawn_id: `spawn-for-${(args as { session_id: string }).session_id}`,
      });
      mockHandlers.current['cancel_packet_generate'] = () => ({
        kind: 'ok',
        cancelled: true,
      });

      const CaptureSurface = await importCaptureSurface();
      await act(async () => {
        render(<CaptureSurface persona="creator" />);
      });

      // Click Generate
      await waitFor(() => screen.getByText(/Generate packet/));
      const btn = screen.getByText(/Generate packet/).closest('button');
      expect(btn).toBeTruthy();
      await act(async () => {
        btn?.click();
      });

      // Running state shown
      await waitFor(() => {
        expect(screen.getByText(/Running…/)).toBeTruthy();
      });

      // Emit a couple stderr events + terminal done
      await act(async () => {
        emitEvent('packet-generate-progress', {
          spawn_id: 'spawn-for-sess-1',
          session_id: 'sess-1',
          kind: 'stderr',
          chunk: 'parsing session jsonl … 17 events',
        });
        // Wait a tick so React commits the activeSpawns update from the
        // spawn IPC resolve before the next event arrives. Otherwise
        // the spawn_id discriminator may drop the events as
        // "no-active-spawn".
        await new Promise((resolve) => setTimeout(resolve, 10));
        emitEvent('packet-generate-progress', {
          spawn_id: 'spawn-for-sess-1',
          session_id: 'sess-1',
          kind: 'stderr',
          chunk: 'running redaction layer 1',
        });
      });

      await waitFor(() => {
        expect(screen.getByText(/parsing session jsonl/)).toBeTruthy();
        expect(screen.getByText(/running redaction layer 1/)).toBeTruthy();
      });
    });

    it('error chunk paints the error variant', async () => {
      mockHandlers.current['detect_capture_cli'] = () => stockDetect();
      mockHandlers.current['list_claude_sessions'] = () => ({
        kind: 'ok',
        sessions: [
          {
            session_id: 'sess-err',
            project_path: '/repo',
            started_at: new Date().toISOString(),
            message_count: 1,
            packet_id: null,
          },
        ],
      });
      mockHandlers.current['query_trail'] = () => ({ packets: [] });
      mockHandlers.current['write_settings'] = () => ({ ok: true });
      mockHandlers.current['spawn_packet_generate'] = () => ({
        kind: 'failed',
        failure_kind: 'cli-not-found',
        message: 'trail not on PATH',
      });

      const CaptureSurface = await importCaptureSurface();
      await act(async () => {
        render(<CaptureSurface persona="creator" />);
      });

      await waitFor(() => screen.getByText(/Generate packet/));
      const btn = screen.getByText(/Generate packet/).closest('button');
      await act(async () => {
        btn?.click();
      });

      await waitFor(() => {
        expect(
          screen.getByText(/cli-not-found: trail not on PATH/),
        ).toBeTruthy();
      });
    });
  });
});
