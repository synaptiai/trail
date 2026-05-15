/**
 * Open an external URL in the user's default browser.
 *
 * Sprint 5 cycle-1.5 F11 (gh#12 AC-8): the EdgeFlowBanner's
 * `gh-cli-absent` recovery button previously had no real action — it
 * just dismissed the banner. AC-8 mandates each edge flow has a real
 * recovery action; the install path is to launch the gh CLI install
 * page in the user's browser.
 *
 * Routes through `tauri-apps/plugin-shell.open()` when running inside
 * the desktop shell; falls back to `window.open` for web/Storybook/test
 * environments. Mirrors the FirstRun.tsx onDocsClick pattern (PR #6
 * cycle-2 N29) so failure surfaces a polite toast rather than silent
 * dead-button.
 *
 * The capability allowlist in src-tauri/capabilities/default.json
 * limits the URL scope to known-safe targets (GitHub Trail repo,
 * cli.github.com).
 */

import { emitToast } from '@/components/screens/ToastHost';

export const GH_CLI_INSTALL_URL = 'https://cli.github.com/';

/**
 * Open `url` via the Tauri shell plugin or a window.open fallback.
 * On any failure, emits a polite toast carrying the URL so the user
 * has a copy-out-of-band recourse — never silent.
 */
export async function openExternalUrl(url: string): Promise<void> {
  let tauriHandled = false;
  try {
    const tauriInternals = (window as unknown as Record<string, unknown>)[
      '__TAURI_INTERNALS__'
    ];
    if (tauriInternals) {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
      tauriHandled = true;
    }
  } catch (err) {
    emitToast({
      tone: 'warning',
      title: 'Could not open URL in browser',
      description: `${url} — ${err instanceof Error ? err.message : 'shell open failed'}`,
    });
    // Fall through to window.open below as last resort.
  }
  if (tauriHandled) return;
  if (typeof window !== 'undefined') {
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) {
      emitToast({
        tone: 'warning',
        title: 'Browser blocked the popup',
        description: `Open ${url} manually.`,
      });
    }
  }
}
