/**
 * M6 Settings → Capture panel × cli_bridge IPC integration test.
 *
 * Sprint 4 cycle-1.5 (gh#11 criterion 11) — N15 anti-pattern fix.
 *
 * The cycle-1 implementation registered cli_bridge as a Rust module + ran
 * 5 unit tests on it, but the IPC handler was never registered in
 * `main.rs::invoke_handler!` and the M6 panel never invoked it. AC-11
 * was technically false at the IPC layer.
 *
 * This test exercises the FULL UI pathway:
 *   1. Open M6 → Capture panel.
 *   2. Edit the path field.
 *   3. Click "Verify" → fires the `validate_capture_cli_path` IPC.
 *   4. Mock returns success → ✓ verified — version 0.1.0-dev appears.
 *   5. Click "Save (verified)" → onSettingsSaved fires with the new path.
 *
 * N15 evidence: if the IPC contract entry for `validate_capture_cli_path`
 * is removed (e.g., reverting the Sprint 4 cycle-1.5 wiring), the
 * `validateCaptureCliPath` helper in the IPC client throws an
 * `IpcInvocationError` with kind `invalid-arguments` because the zod
 * command schema lookup fails — which the panel surfaces as a
 * "system-error" status. The test below asserts the success path AND
 * the invocation count, which jointly fail when the contract is
 * unregistered.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock the underlying Tauri bridge import (@tauri-apps/api/core) — this
 * lets the REAL `@/ipc/client` code run, which means the real
 * `validateCaptureCliPath` helper validates against IPC_COMMAND_SCHEMAS
 * before forwarding to the bridge. If the contract entry for
 * `validate_capture_cli_path` were removed (the cycle-1 broken state),
 * the IPC client throws InvocationError before the bridge is ever
 * consulted, and the panel surfaces a system-error status.
 *
 * This matches the cycle-1 N15 evidence requirement: a regression that
 * un-wires the IPC layer must cause this test to FAIL.
 */
import { beforeAll } from 'vitest';

interface MockHandler {
  (args: Record<string, unknown>): Promise<unknown> | unknown;
}
const mockHandlers: { current: Record<string, MockHandler> } = { current: {} };

beforeAll(() => {
  // Install a fake __TAURI_INTERNALS__ + intercept @tauri-apps/api/core's
  // invoke before the IPC client's getBridge() runs.
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
      // Bridge-level rejection — the IPC client wraps this as
      // IpcInvocationError, which the panel surfaces as "system-error".
      throw { kind: 'internal', message: `unmocked: ${cmd}` };
    }
    return handler(args);
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
  capture_cli_path: '@synapti/trail-capture',
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
    screen.getByRole('tab', { name: 'Capture' }).click();
  });
  return { onSettingsSaved };
}

describe('M6 Settings → Capture × cli_bridge IPC (gh#11 AC-11)', () => {
  beforeEach(() => {
    setHandlers({});
  });
  afterEach(() => {
    setHandlers({});
  });

  it('successful probe surfaces ✓ verified and gates "Save (verified)"', async () => {
    const validateCalls: Array<Record<string, unknown>> = [];
    const writeCalls: Array<Record<string, unknown>> = [];
    setHandlers({
      validate_capture_cli_path: async (args) => {
        validateCalls.push(args ?? {});
        return { ok: 'true', version: '0.1.0-dev' };
      },
      write_settings: async (args) => {
        writeCalls.push(args ?? {});
        return { ok: true };
      },
      read_settings: async () => ({ ...fixture, capture_cli_path: '/usr/local/bin/trail' }),
      audit_log_append: async () => ({ ok: true }),
    });

    const { onSettingsSaved } = await openCapturePanel();

    const input = screen.getByPlaceholderText('@synapti/trail-capture') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '/usr/local/bin/trail' } });
    });

    // Pre-probe: Save (verified) is disabled because nothing has been verified.
    const saveVerified = screen.getByRole('button', { name: 'Save (verified)' });
    expect(saveVerified).toBeDisabled();

    // Click Verify → IPC fires → success.
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('m6-capture-verified')).toBeInTheDocument();
    });
    expect(screen.getByTestId('m6-capture-verified').textContent).toContain('0.1.0-dev');

    // Exactly one IPC call to validate_capture_cli_path with the typed payload.
    expect(validateCalls).toHaveLength(1);
    expect(validateCalls[0]).toEqual({ path: '/usr/local/bin/trail' });

    // Save (verified) is now enabled.
    expect(saveVerified).not.toBeDisabled();
    await act(async () => {
      saveVerified.click();
    });
    await waitFor(() => {
      expect(writeCalls).toHaveLength(1);
    });
    // Cycle-4.5 W1 (PR #21): persona threaded through writeSettings.
    expect(writeCalls[0]).toEqual({
      partial: { capture_cli_path: '/usr/local/bin/trail' },
      persona: 'creator',
    });
    await waitFor(() => {
      expect(onSettingsSaved).toHaveBeenCalled();
    });
  });

  it('rejected probe surfaces ✗ probe failed and keeps "Save (verified)" disabled', async () => {
    setHandlers({
      validate_capture_cli_path: async () => ({
        ok: 'false',
        kind: 'spawn',
        message: 'no such file: /missing/binary',
      }),
      read_settings: async () => fixture,
      write_settings: async () => ({ ok: true }),
      audit_log_append: async () => ({ ok: true }),
    });

    await openCapturePanel();

    const input = screen.getByPlaceholderText('@synapti/trail-capture') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '/missing/binary' } });
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('m6-capture-rejected')).toBeInTheDocument();
    });
    expect(screen.getByTestId('m6-capture-rejected').textContent).toContain('spawn');
    expect(screen.getByTestId('m6-capture-rejected').textContent).toContain('no such file');
    expect(screen.getByRole('button', { name: 'Save (verified)' })).toBeDisabled();
  });

  it('IPC system error (handler unregistered) surfaces ✗ verification could not run', async () => {
    // Empty mock → invoke() throws IpcInvocationError(`unmocked IPC command:
    // validate_capture_cli_path`). This simulates the cycle-1 broken state
    // (handler not registered in main.rs::invoke_handler!).
    setHandlers({
      read_settings: async () => fixture,
      write_settings: async () => ({ ok: true }),
      audit_log_append: async () => ({ ok: true }),
    });

    await openCapturePanel();

    const input = screen.getByPlaceholderText('@synapti/trail-capture') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '/some/path' } });
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('m6-capture-system-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('m6-capture-system-error').textContent).toContain(
      'verification could not run',
    );
    expect(screen.getByRole('button', { name: 'Save (verified)' })).toBeDisabled();
  });

  it('Save as-is persists without verification (operator override)', async () => {
    const writeCalls: Array<Record<string, unknown>> = [];
    setHandlers({
      read_settings: async () => fixture,
      write_settings: async (args) => {
        writeCalls.push(args ?? {});
        return { ok: true };
      },
      audit_log_append: async () => ({ ok: true }),
    });

    await openCapturePanel();

    const input = screen.getByPlaceholderText('@synapti/trail-capture') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '/build/pipeline/path' } });
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Save as-is' }).click();
    });
    await waitFor(() => {
      expect(writeCalls).toHaveLength(1);
    });
    // Cycle-4.5 W1 (PR #21): persona threaded through writeSettings.
    expect(writeCalls[0]).toEqual({
      partial: { capture_cli_path: '/build/pipeline/path' },
      persona: 'creator',
    });
  });
});
