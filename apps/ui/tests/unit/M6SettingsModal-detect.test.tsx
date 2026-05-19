/**
 * M6 Settings → Capture × detect_capture_cli IPC integration test (gh#17).
 *
 * Exercises the Detect button's full UI pathway:
 *   1. Open M6 → Capture panel.
 *   2. Click "Detect" → fires the `detect_capture_cli` IPC.
 *   3a. Mocked success → path auto-fills, ✓ verified banner shows the
 *       version + source ("detected via login shell"), Save (verified)
 *       enables.
 *   3b. Mocked failure → failure card renders with the classified
 *       failure_kind + message + suggested_fix, and a Copy fix button.
 *
 * AC#1 (button exists + probes via login-shell/candidates/marker),
 * AC#4 (success path auto-fills + marks verified + shows version),
 * AC#5 (failure surfaces specific failure mode + targeted fix command).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockHandler {
  (args: Record<string, unknown>): Promise<unknown> | unknown;
}
const mockHandlers: { current: Record<string, MockHandler> } = { current: {} };

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window.__TAURI_INTERNALS__ = {
    callbacks: {},
    plugins: {},
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    const handler = mockHandlers.current[cmd];
    if (!handler) {
      throw { kind: 'internal', message: `unmocked: ${cmd}` };
    }
    // v0.1.1 B3 strict-wrap pin (the IPC client always wraps in { args }).
    if (!(args as { args?: unknown }).args) {
      throw new Error(
        `test mock expected wrapped envelope { args: ... } from real client.ts; got: ${JSON.stringify(args)}`,
      );
    }
    return handler((args as { args: Record<string, unknown> }).args);
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}));

import { M6SettingsModal } from '@/components/screens/M6SettingsModal';
import type { Settings } from '@/ipc/contract';

function setHandlers(map: Record<string, MockHandler>) {
  mockHandlers.current = map;
}

const fixture: Settings = {
  theme: 'system',
  density: 'comfortable',
  disable_tamper_warnings: false,
  heavy_redaction_threshold: 15,
  capture_cli_path: 'trail',
  pinned_sessions: [],
};

async function openCapturePanel(initialSettings: Settings = fixture) {
  const onSettingsSaved = vi.fn();
  render(
    <M6SettingsModal
      open
      onClose={() => {}}
      initialSettings={initialSettings}
      onSettingsSaved={onSettingsSaved}
      persona="creator"
    />,
  );
  await act(async () => {
    screen.getByRole('tab', { name: 'Capture (advanced)' }).click();
  });
  return { onSettingsSaved };
}

describe('M6 Settings → Capture × detect_capture_cli (gh#17)', () => {
  beforeEach(() => {
    setHandlers({});
  });
  afterEach(() => {
    setHandlers({});
  });

  it('renders the Detect button', async () => {
    setHandlers({
      read_settings: async () => fixture,
    });
    await openCapturePanel();
    expect(screen.getByTestId('m6-capture-detect')).toBeInTheDocument();
    expect(screen.getByTestId('m6-capture-detect').textContent).toContain('Detect');
  });

  it('success: auto-fills path, shows ✓ verified with version, surfaces detection source', async () => {
    const detectCalls: Array<Record<string, unknown>> = [];
    setHandlers({
      detect_capture_cli: async (args) => {
        detectCalls.push(args ?? {});
        return {
          kind: 'detected',
          path: '/opt/homebrew/bin/trail',
          version: '0.1.4',
          source: 'login-shell',
        };
      },
      read_settings: async () => fixture,
      write_settings: async () => ({ ok: true }),
      audit_log_append: async () => ({ ok: true }),
    });

    await openCapturePanel();

    const input = screen.getByPlaceholderText('trail') as HTMLInputElement;
    expect(input.value).toBe('trail');

    await act(async () => {
      screen.getByTestId('m6-capture-detect').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('m6-capture-verified')).toBeInTheDocument();
    });

    // AC#4: path auto-filled.
    expect(input.value).toBe('/opt/homebrew/bin/trail');
    // AC#4: marked verified + version shown.
    const verified = screen.getByTestId('m6-capture-verified').textContent ?? '';
    expect(verified).toContain('0.1.4');
    // AC#1: source surfaced — humanised from kebab-case to spaces.
    expect(verified).toContain('login shell');
    // Exactly one IPC call to detect_capture_cli with the empty payload.
    expect(detectCalls).toHaveLength(1);
    expect(detectCalls[0]).toEqual({});
    // Save (verified) is enabled (auto-filled path differs from settings).
    expect(screen.getByRole('button', { name: 'Save (verified)' })).not.toBeDisabled();
  });

  it('failure (node-missing): renders failure card with classified kind + suggested_fix', async () => {
    setHandlers({
      detect_capture_cli: async () => ({
        kind: 'failed',
        failure_kind: 'node-missing',
        message:
          "Found `trail` but `env` could not locate `node` (exit 127). On macOS, GUI-launched apps inherit a minimal PATH that does not include where Homebrew installs node.",
        suggested_fix:
          'sudo ln -s /opt/homebrew/bin/node /usr/local/bin/node — or relaunch from a terminal',
      }),
      read_settings: async () => fixture,
    });

    await openCapturePanel();

    await act(async () => {
      screen.getByTestId('m6-capture-detect').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('m6-capture-detect-failure')).toBeInTheDocument();
    });

    const failureCard = screen.getByTestId('m6-capture-detect-failure');
    // AC#5: classified failure_kind on the card (data attribute + text).
    expect(failureCard.getAttribute('data-failure-kind')).toBe('node-missing');
    expect(failureCard.textContent).toContain('node missing');
    // AC#5: targeted message + suggested fix surfaced verbatim.
    expect(failureCard.textContent).toContain('env');
    expect(failureCard.textContent).toContain('GUI-launched apps');
    expect(failureCard.textContent).toContain('ln -s /opt/homebrew/bin/node');
    // Copy button is present.
    expect(screen.getByTestId('m6-capture-detect-failure-copy')).toBeInTheDocument();
  });

  it('failure (binary-not-installed): surfaces install command', async () => {
    setHandlers({
      detect_capture_cli: async () => ({
        kind: 'failed',
        failure_kind: 'binary-not-installed',
        message:
          'Could not find a `trail` binary on PATH or at standard install locations.',
        suggested_fix: 'Install with: npm install -g @synapti/trail-capture',
      }),
      read_settings: async () => fixture,
    });

    await openCapturePanel();
    await act(async () => {
      screen.getByTestId('m6-capture-detect').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('m6-capture-detect-failure')).toBeInTheDocument();
    });
    const failureCard = screen.getByTestId('m6-capture-detect-failure');
    expect(failureCard.getAttribute('data-failure-kind')).toBe('binary-not-installed');
    expect(failureCard.textContent).toContain('binary not installed');
    expect(failureCard.textContent).toContain('npm install -g @synapti/trail-capture');
  });

  it('failure (probe-timed-out): surfaces probe-timed-out kind', async () => {
    setHandlers({
      detect_capture_cli: async () => ({
        kind: 'failed',
        failure_kind: 'probe-timed-out',
        message: 'Probing the `trail` binary did not return in time.',
        suggested_fix: 'Re-run Detect, or set the path manually in Settings.',
      }),
      read_settings: async () => fixture,
    });

    await openCapturePanel();
    await act(async () => {
      screen.getByTestId('m6-capture-detect').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('m6-capture-detect-failure')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('m6-capture-detect-failure').getAttribute('data-failure-kind'),
    ).toBe('probe-timed-out');
  });

  it('failure (probe-error): surfaces probe-error kind with exit-line summary', async () => {
    setHandlers({
      detect_capture_cli: async () => ({
        kind: 'failed',
        failure_kind: 'probe-error',
        message: 'Probe exited with code 2: trail: bad usage',
        suggested_fix:
          'Check that the binary at the configured path is executable and prints its version on --version.',
      }),
      read_settings: async () => fixture,
    });

    await openCapturePanel();
    await act(async () => {
      screen.getByTestId('m6-capture-detect').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('m6-capture-detect-failure')).toBeInTheDocument();
    });
    const card = screen.getByTestId('m6-capture-detect-failure');
    expect(card.getAttribute('data-failure-kind')).toBe('probe-error');
    expect(card.textContent).toContain('code 2');
    expect(card.textContent).toContain('trail: bad usage');
  });

  it('IPC system error (handler unregistered): surfaces "Detect could not run"', async () => {
    setHandlers({
      read_settings: async () => fixture,
    });
    await openCapturePanel();
    await act(async () => {
      screen.getByTestId('m6-capture-detect').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('m6-capture-detect-system-error')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('m6-capture-detect-system-error').textContent,
    ).toContain('Detect could not run');
  });

  it('race fix (gh#17 cycle-2 F1): edit during in-flight Detect does NOT overwrite typed path on resolve', async () => {
    // Reproduces the race the cycle-2 review surfaced: user clicks Detect
    // with a slow IPC, types a custom path while the probe is in flight,
    // and the Detect promise resolves AFTER the typing. The detectGenRef
    // counter should invalidate the late resolution so the typed value
    // survives and no `verified` state is announced for a path the user
    // didn't ask to verify.
    let resolveDetect!: (value: unknown) => void;
    const detectGate = new Promise((resolve) => {
      resolveDetect = resolve;
    });
    setHandlers({
      detect_capture_cli: async () => {
        await detectGate;
        return {
          kind: 'detected',
          path: '/opt/homebrew/bin/trail',
          version: '0.1.4',
          source: 'login-shell',
        };
      },
      read_settings: async () => fixture,
    });
    await openCapturePanel();
    const input = screen.getByPlaceholderText('trail') as HTMLInputElement;

    // 1. Click Detect (IPC is gated; will not resolve until we release it)
    await act(async () => {
      screen.getByTestId('m6-capture-detect').click();
    });
    // Confirm we are in the detecting state.
    expect(screen.getByTestId('m6-capture-detect').textContent).toContain('Detecting');

    // 2. User types a different path while Detect is in flight.
    await act(async () => {
      fireEvent.change(input, { target: { value: '/custom/user-typed/trail' } });
    });
    expect(input.value).toBe('/custom/user-typed/trail');

    // 3. Release the Detect IPC — it resolves with /opt/homebrew/bin/trail
    //    but the user has since edited. Without the race guard this would
    //    overwrite the typed value.
    await act(async () => {
      resolveDetect(undefined);
      // Allow the promise resolution + state updates to flush.
      await new Promise((r) => setTimeout(r, 10));
    });

    // The typed value survives.
    expect(input.value).toBe('/custom/user-typed/trail');
    // No `verified` banner for the stale-detected path.
    expect(screen.queryByTestId('m6-capture-verified')).toBeNull();
  });

  it('detect-then-verify: detected path can be re-verified independently', async () => {
    const detectCalls: Array<Record<string, unknown>> = [];
    const validateCalls: Array<Record<string, unknown>> = [];
    setHandlers({
      detect_capture_cli: async (args) => {
        detectCalls.push(args ?? {});
        return {
          kind: 'detected',
          path: '/opt/homebrew/bin/trail',
          version: '0.1.4',
          source: 'candidate',
        };
      },
      validate_capture_cli_path: async (args) => {
        validateCalls.push(args ?? {});
        return { ok: 'true', version: '0.1.4' };
      },
      read_settings: async () => fixture,
    });

    await openCapturePanel();

    await act(async () => {
      screen.getByTestId('m6-capture-detect').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('m6-capture-verified')).toBeInTheDocument();
    });

    // Re-verify the just-detected path.
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    await waitFor(() => {
      expect(validateCalls).toHaveLength(1);
    });
    expect(validateCalls[0]).toEqual({ path: '/opt/homebrew/bin/trail' });
  });
});
