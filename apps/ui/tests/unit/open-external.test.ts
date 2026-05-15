/**
 * open-external service unit tests (gh#12 cycle-3 V3).
 *
 * The F11 service had no direct unit tests in cycle-2; M4 modal tests
 * asserted the install button rendered (m4-open-install-instructions)
 * but did not verify (a) the URL passed to window.open, (b) the
 * `noopener,noreferrer` window-feature string, or (c) the toast-on-
 * popup-blocked path. A future refactor that dropped the security
 * window features or swapped the URL constant would not have failed
 * any test. This file locks all three.
 *
 * Three test cases:
 *   1. window.open fallback receives `noopener,noreferrer`.
 *   2. popup-blocked path (window.open returns null) emits a warning
 *      toast carrying the URL.
 *   3. tauri-internals path delegates to @tauri-apps/plugin-shell and
 *      does NOT call window.open.
 *
 * Mocking style mirrors gh-post.test.ts: vi.mock at module level for
 * @tauri-apps/plugin-shell, ToastHost.emitToast spied via vi.fn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the plugin-shell module so we can swap the open() implementation
// per-test. The real module would only load inside the Tauri runtime;
// in vitest we provide a stub.
const pluginShellOpen = vi.fn<(url: string) => Promise<void>>();
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: (url: string) => pluginShellOpen(url),
}));

// Mock the toast emitter so we can assert on emitted toasts directly.
const emitToastMock = vi.fn();
vi.mock('@/components/screens/ToastHost', () => ({
  emitToast: (entry: unknown) => emitToastMock(entry),
}));

// Import after mocks register so the service captures the mocked
// emitToast / plugin-shell binding.
import { GH_CLI_INSTALL_URL, openExternalUrl } from '@/services/open-external';

describe('openExternalUrl (gh#12 cycle-3 V3)', () => {
  beforeEach(() => {
    pluginShellOpen.mockReset();
    emitToastMock.mockReset();
  });

  afterEach(() => {
    // Clean up any Tauri-internals stub on the test window.
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('GH_CLI_INSTALL_URL is the canonical install page', () => {
    // Locks the URL constant — a refactor that swapped this for a
    // hostile or wrong URL would fail this assertion.
    expect(GH_CLI_INSTALL_URL).toBe('https://cli.github.com/');
  });

  it('window.open fallback receives the URL + noopener,noreferrer features', async () => {
    // Ensure no Tauri internals → service falls through to window.open.
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue({} as unknown as Window);
    await openExternalUrl(GH_CLI_INSTALL_URL);
    // The third argument is the security-critical window-features
    // string. A refactor that drops `noopener,noreferrer` would expose
    // the parent window to the opened tab via window.opener — F11
    // explicitly requires both flags.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      GH_CLI_INSTALL_URL,
      '_blank',
      'noopener,noreferrer',
    );
    // Plugin-shell path must not have been touched (no Tauri internals).
    expect(pluginShellOpen).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('popup-blocked path emits warning toast carrying the URL', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    // window.open returning null is the standard popup-blocked signal.
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    await openExternalUrl(GH_CLI_INSTALL_URL);
    expect(openSpy).toHaveBeenCalledTimes(1);
    // A warning toast must be emitted so the user can copy the URL
    // out-of-band rather than face a silent dead-button.
    expect(emitToastMock).toHaveBeenCalledTimes(1);
    const toast = emitToastMock.mock.calls[0]![0] as {
      tone: string;
      title: string;
      description: string;
    };
    expect(toast.tone).toBe('warning');
    expect(toast.description).toContain(GH_CLI_INSTALL_URL);
    expect(toast.title.toLowerCase()).toMatch(/popup|blocked|browser/);
    openSpy.mockRestore();
  });

  it('tauri-internals path delegates to plugin-shell.open and skips window.open', async () => {
    // Simulate the desktop-shell environment: presence of
    // __TAURI_INTERNALS__ tells the service to route through the
    // plugin-shell IPC instead of the web fallback.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      callbacks: {},
      plugins: {},
    };
    pluginShellOpen.mockResolvedValue(undefined);
    const openSpy = vi.spyOn(window, 'open');
    await openExternalUrl(GH_CLI_INSTALL_URL);
    expect(pluginShellOpen).toHaveBeenCalledTimes(1);
    expect(pluginShellOpen).toHaveBeenCalledWith(GH_CLI_INSTALL_URL);
    // Critical: when Tauri shell handles the open, the web fallback
    // must NOT also fire (would double-open in dual-stack scenarios
    // and could leak window.opener).
    expect(openSpy).not.toHaveBeenCalled();
    // No toast on the happy path.
    expect(emitToastMock).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
