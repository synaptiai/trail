import { useCallback } from 'react';
import { Button, EmptyState, HorizonLine, KeyboardKey } from '@/components/primitives';
import { emitToast } from '@/components/screens/ToastHost';
import './FirstRun.css';

/**
 * <FirstRun> (B4 §5.2, B3 §10.5) — first-launch hero state.
 *
 * Centered horizontal horizon with the Trail mark above; two CTAs below
 * (capture-current-session + open-docs). The horizon inscribes-in once on first
 * render (B3 §10.6 — animation degrades to final state under reduced-motion).
 *
 * CTA wiring (per PR #6 cycle-1 review F11):
 *   - "Capture current session" emits a polite toast pointing at the CLI
 *     entry-point (capture is CLI-driven in v0.1; the desktop-spawn variant
 *     lands in Sprint 4 once the saga + watcher are wired). The toast cites
 *     the canonical command so a user hitting the button gets a real next
 *     step rather than silent failure.
 *   - "Open documentation" routes through `tauri-apps/plugin-shell.open()`
 *     to launch the user's default browser at the public README. Falls back
 *     to `window.open` when running outside the desktop shell (Storybook,
 *     unit tests).
 */

const DOCS_URL = 'https://github.com/synaptiai/trail#readme';

export function FirstRun() {
  const onCaptureClick = useCallback(() => {
    emitToast({
      tone: 'info',
      title: 'Capture runs from the CLI in v0.1',
      description:
        'After Claude Code wraps, run `trail packet generate` in your terminal. The desktop-driven capture lands in Sprint 4.',
    });
  }, []);

  const onDocsClick = useCallback(async () => {
    // Cycle-2 N29: previously this catch was empty. If both the Tauri shell
    // path AND the window.open fallback fail (e.g., webview popup-blocking
    // policy), the user got silent failure. Now we surface the failure
    // through a polite toast so the user can copy the URL out of band.
    let tauriHandled = false;
    try {
      const tauriInternals = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
      if (tauriInternals) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(DOCS_URL);
        tauriHandled = true;
      }
    } catch (err) {
      emitToast({
        tone: 'warning',
        title: 'Could not open documentation in browser',
        description: `${DOCS_URL} — ${err instanceof Error ? err.message : 'shell open failed'}`,
      });
      // Fall through to window.open below as last resort.
    }
    if (tauriHandled) return;
    if (typeof window !== 'undefined') {
      const opened = window.open(DOCS_URL, '_blank', 'noopener,noreferrer');
      if (!opened) {
        // Webview blocked the popup. Surface the URL so the user has recourse.
        emitToast({
          tone: 'warning',
          title: 'Browser blocked the documentation popup',
          description: `Open ${DOCS_URL} manually.`,
        });
      }
    }
  }, []);

  return (
    <div className="first-run">
      <span className="first-run__mark type-display-1">Trail</span>
      <HorizonLine variant="first-run-hero" animateOnce aria-label="Trail horizon" />
      <EmptyState
        variant="full"
        headline="The trail starts here."
        body={
          <>
            Run <KeyboardKey>trail packet generate</KeyboardKey> after Claude Code wraps to
            capture your first session. Each packet records the AI-assisted change as a
            reviewable, redacted, decisional trail — visible only to you until you post it.
          </>
        }
        action={
          <div className="first-run__actions">
            <Button variant="primary" onClick={onCaptureClick}>
              Capture current session
            </Button>
            <Button variant="ghost" onClick={onDocsClick}>
              Open documentation
            </Button>
          </div>
        }
      />
    </div>
  );
}
