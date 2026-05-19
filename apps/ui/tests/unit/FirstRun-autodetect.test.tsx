/**
 * <FirstRun> × detect_capture_cli first-launch auto-detect (gh#17 AC#6).
 *
 * AC#6: "First-launch path: detection runs automatically (no settings.json
 * exists yet) — user sees 'Trail CLI detected at /path/to/trail' toast
 * without entering Settings."
 *
 * Tests cover:
 *   - Auto-detect fires once on mount when the localStorage flag is absent.
 *   - On success: success toast names the path + version; the detected
 *     path is persisted via writeSettings.
 *   - On failure: warning toast names the failure_kind + points at Settings.
 *   - The localStorage flag prevents re-detection on subsequent mounts.
 *   - Auditor persona skips writeSettings (the Rust handler rejects auditor
 *     for capture_cli_path writes).
 */
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockHandler {
  (args: Record<string, unknown>): Promise<unknown> | unknown;
}
const mockHandlers: { current: Record<string, MockHandler> } = { current: {} };
const invocationCounts: { current: Record<string, number> } = { current: {} };

// Polyfill localStorage if happy-dom does not surface it — keeps the
// auto-detect gating logic testable without coupling to the runtime.
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
  w.__TAURI_INTERNALS__ = {
    callbacks: {},
    plugins: {},
  };
  ensureLocalStorage();
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    invocationCounts.current[cmd] = (invocationCounts.current[cmd] ?? 0) + 1;
    const handler = mockHandlers.current[cmd];
    if (!handler) {
      throw { kind: 'internal', message: `unmocked: ${cmd}` };
    }
    if (!(args as { args?: unknown }).args) {
      throw new Error(
        `test mock expected wrapped envelope { args: ... }; got: ${JSON.stringify(args)}`,
      );
    }
    return handler((args as { args: Record<string, unknown> }).args);
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}));

// Mock emitToast so we can introspect the calls without rendering the
// host. The host renders into ToastHost which we don't need for these
// tests; what we want to assert is "the user would see this toast".
const toastCalls: Array<Record<string, unknown>> = [];
vi.mock('@/components/screens/ToastHost', () => ({
  emitToast: (toast: Record<string, unknown>) => {
    toastCalls.push(toast);
  },
  ToastHost: () => null,
}));

import { FirstRun } from '@/components/screens/FirstRun';

const AUTODETECT_FLAG_KEY = 'trail_autodetect_ran';

function setHandlers(map: Record<string, MockHandler>) {
  mockHandlers.current = map;
}

describe('<FirstRun> first-launch auto-detect (gh#17 AC#6)', () => {
  beforeEach(() => {
    setHandlers({});
    invocationCounts.current = {};
    toastCalls.length = 0;
    ensureLocalStorage().clear();
  });
  afterEach(() => {
    setHandlers({});
    ensureLocalStorage().clear();
  });

  it('auto-runs detect_capture_cli on mount when the flag is absent', async () => {
    setHandlers({
      detect_capture_cli: async () => ({
        kind: 'detected',
        path: '/opt/homebrew/bin/trail',
        version: '0.1.4',
        source: 'login-shell',
      }),
      write_settings: async () => ({ ok: true }),
    });

    await act(async () => {
      render(<FirstRun persona="creator" />);
    });

    await waitFor(() => {
      expect(invocationCounts.current.detect_capture_cli).toBe(1);
    });
  });

  it('emits a success toast naming the detected path + version', async () => {
    setHandlers({
      detect_capture_cli: async () => ({
        kind: 'detected',
        path: '/opt/homebrew/bin/trail',
        version: '0.1.4',
        source: 'login-shell',
      }),
      write_settings: async () => ({ ok: true }),
    });

    await act(async () => {
      render(<FirstRun persona="creator" />);
    });

    await waitFor(() => {
      expect(toastCalls.length).toBeGreaterThan(0);
    });
    const toast = toastCalls.find(
      (t) => typeof t.title === 'string' && t.title.includes('Trail CLI detected'),
    );
    expect(toast).toBeDefined();
    expect((toast as { title: string }).title).toContain('/opt/homebrew/bin/trail');
    expect((toast as { description: string }).description).toContain('0.1.4');
    expect((toast as { tone: string }).tone).toBe('success');
  });

  it('persists the detected path via writeSettings on success', async () => {
    const writeCalls: Array<Record<string, unknown>> = [];
    setHandlers({
      detect_capture_cli: async () => ({
        kind: 'detected',
        path: '/opt/homebrew/bin/trail',
        version: '0.1.4',
        source: 'candidate',
      }),
      write_settings: async (args) => {
        writeCalls.push(args ?? {});
        return { ok: true };
      },
    });

    await act(async () => {
      render(<FirstRun persona="creator" />);
    });

    await waitFor(() => {
      expect(writeCalls).toHaveLength(1);
    });
    expect(writeCalls[0]).toEqual({
      partial: { capture_cli_path: '/opt/homebrew/bin/trail' },
      persona: 'creator',
    });
  });

  it('emits a warning toast on failure pointing the user at Settings', async () => {
    setHandlers({
      detect_capture_cli: async () => ({
        kind: 'failed',
        failure_kind: 'binary-not-installed',
        message: 'Could not find a `trail` binary.',
        suggested_fix: 'npm install -g @synapti/trail-capture',
      }),
    });

    await act(async () => {
      render(<FirstRun persona="creator" />);
    });

    await waitFor(() => {
      expect(toastCalls.length).toBeGreaterThan(0);
    });
    const toast = toastCalls.find(
      (t) =>
        typeof t.title === 'string' && t.title.includes('Could not detect'),
    );
    expect(toast).toBeDefined();
    expect((toast as { tone: string }).tone).toBe('warning');
    expect((toast as { description: string }).description).toContain('Settings');
  });

  it('skips auto-detect on subsequent mounts (localStorage flag set)', async () => {
    ensureLocalStorage().setItem(AUTODETECT_FLAG_KEY, '1');
    // No handlers registered → detect_capture_cli would throw if invoked.
    setHandlers({});

    await act(async () => {
      render(<FirstRun persona="creator" />);
    });

    // Give any async effects a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(invocationCounts.current.detect_capture_cli ?? 0).toBe(0);
    expect(toastCalls.length).toBe(0);
  });

  it('sets the localStorage flag after a successful run so re-mounts do not re-detect', async () => {
    setHandlers({
      detect_capture_cli: async () => ({
        kind: 'detected',
        path: '/opt/homebrew/bin/trail',
        version: '0.1.4',
        source: 'login-shell',
      }),
      write_settings: async () => ({ ok: true }),
    });

    await act(async () => {
      render(<FirstRun persona="creator" />);
    });

    await waitFor(() => {
      expect(ensureLocalStorage().getItem(AUTODETECT_FLAG_KEY)).toBe('1');
    });
  });

  it('does NOT set the localStorage flag on detect failure so a fixed install retries (gh#17 F2 / ERR-2)', async () => {
    setHandlers({
      detect_capture_cli: async () => ({
        kind: 'failed',
        failure_kind: 'binary-not-installed',
        message: 'not found',
        suggested_fix: 'install it',
      }),
    });

    await act(async () => {
      render(<FirstRun persona="creator" />);
    });

    // Wait for the warning toast to confirm runAutoDetect ran fully.
    await waitFor(() => {
      expect(toastCalls.length).toBeGreaterThan(0);
    });
    // After the failure path settles, the flag MUST remain unset so
    // the next launch (after the user installs the CLI) re-runs detect.
    expect(ensureLocalStorage().getItem(AUTODETECT_FLAG_KEY)).toBe(null);
  });

  it('does NOT set the localStorage flag on IPC system error so a fixed install retries', async () => {
    // No detect_capture_cli handler → invoke throws.
    setHandlers({});

    await act(async () => {
      render(<FirstRun persona="creator" />);
    });

    await waitFor(() => {
      expect(toastCalls.length).toBeGreaterThan(0);
    });
    expect(ensureLocalStorage().getItem(AUTODETECT_FLAG_KEY)).toBe(null);
  });

  it('does NOT set the localStorage flag when writeSettings fails (persist failure retry next launch)', async () => {
    setHandlers({
      detect_capture_cli: async () => ({
        kind: 'detected',
        path: '/opt/homebrew/bin/trail',
        version: '0.1.4',
        source: 'login-shell',
      }),
      write_settings: async () => {
        throw { kind: 'internal', message: 'simulated persist failure' };
      },
    });

    await act(async () => {
      render(<FirstRun persona="creator" />);
    });

    // The success toast for detect fires, then a follow-up info toast
    // for the persist failure. Flag remains unset.
    await waitFor(() => {
      expect(
        toastCalls.some(
          (t) => typeof t.title === 'string' && t.title.includes('could not save'),
        ),
      ).toBe(true);
    });
    expect(ensureLocalStorage().getItem(AUTODETECT_FLAG_KEY)).toBe(null);
  });

  it('auditor persona: skips writeSettings (Rust handler would reject)', async () => {
    const writeCalls: Array<Record<string, unknown>> = [];
    setHandlers({
      detect_capture_cli: async () => ({
        kind: 'detected',
        path: '/opt/homebrew/bin/trail',
        version: '0.1.4',
        source: 'login-shell',
      }),
      write_settings: async (args) => {
        writeCalls.push(args ?? {});
        return { ok: true };
      },
    });

    await act(async () => {
      render(<FirstRun persona="auditor" />);
    });

    // Detection should still emit the success toast.
    await waitFor(() => {
      expect(invocationCounts.current.detect_capture_cli).toBe(1);
    });
    // But writeSettings is skipped for auditor.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(writeCalls).toHaveLength(0);
  });

  it('IPC system error: emits warning toast naming the failure', async () => {
    // No detect_capture_cli handler → invoke throws.
    setHandlers({});

    await act(async () => {
      render(<FirstRun persona="creator" />);
    });

    await waitFor(() => {
      expect(toastCalls.length).toBeGreaterThan(0);
    });
    const toast = toastCalls.find(
      (t) => typeof t.title === 'string' && t.title.includes('Auto-detect could not run'),
    );
    expect(toast).toBeDefined();
    expect((toast as { tone: string }).tone).toBe('warning');
  });
});
