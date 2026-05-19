import { useCallback, useEffect, useRef } from 'react';
import { Button, EmptyState, HorizonLine, KeyboardKey } from '@/components/primitives';
import { emitToast } from '@/components/screens/ToastHost';
import { detectCaptureCli, writeSettings } from '@/ipc/client';
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
 *
 * gh#17 AC#6: first-launch auto-detect of the trail CLI. On the very
 * first FirstRun mount per machine we fire `detect_capture_cli` and
 * emit a toast: success → "Trail CLI detected at /path"; failure →
 * "Could not detect the trail CLI" with a link to Settings. A
 * localStorage flag (`trail_autodetect_ran`) gates the auto-run so
 * re-mounts (every empty-packet state) don't re-trigger. On success
 * the detected path is persisted via writeSettings so subsequent
 * launches use it.
 */

const DOCS_URL = 'https://github.com/synaptiai/trail#readme';
const AUTODETECT_FLAG_KEY = 'trail_autodetect_ran';

interface FirstRunProps {
  /**
   * Persona of the active workspace user, forwarded to `writeSettings`
   * when auto-detect succeeds and the path is persisted. The Rust
   * `write_settings` handler rejects auditor for most fields; auto-
   * detect only writes `capture_cli_path` which is allowed for
   * creator and reviewer. Auditor mode skips the persist step.
   */
  persona?: import('@/ipc/contract').Persona;
}

export function FirstRun({ persona = 'creator' }: FirstRunProps = {}) {
  // Re-entry guard: useEffect deps are [], so this fires once per mount.
  // The localStorage flag prevents re-detect when the user navigates
  // away from a packet back to the empty state (FirstRun re-mounts).
  const ranRef = useRef<boolean>(false);

  useEffect(() => {
    if (ranRef.current) return;
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (window.localStorage.getItem(AUTODETECT_FLAG_KEY) === '1') return;
    ranRef.current = true;
    runAutoDetect(persona).catch((err) => {
      // runAutoDetect already emits a toast on IPC failure; swallow
      // the rejection here so we don't end up with an unhandled
      // rejection in the test environment. Surface a console.warn
      // so a downstream programming error (e.g., toast emit throws)
      // is observable in DevTools (gh#17 ERR-4).
      console.warn('[Trail] auto-detect rejected:', err);
    });
  }, [persona]);

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
    <div className="first-run" data-testid="first-run">
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

/**
 * gh#17 AC#6: first-launch auto-detect implementation. Called once per
 * mount, gated by the `trail_autodetect_ran` localStorage flag AND the
 * in-memory `ranRef`.
 *
 * Success path: emit a polite `success`-tone toast naming the detected
 * path. Persist via `writeSettings` so the next launch starts in a
 * verified state. The localStorage flag is set ONLY after both detect
 * AND persist succeed (or detect succeeds for auditor, which doesn't
 * persist). Rationale for the post-success-only flag (gh#17 ERR-1 /
 * ERR-2 fix): a user who installs Trail before the CLI, sees the
 * "Could not detect" toast, then runs `npm install -g @synapti/trail-
 * capture`, gets auto-detect on their NEXT launch — they don't have to
 * navigate to Settings to trigger it manually. The in-memory `ranRef`
 * (set by the caller before this fn runs) prevents toast spam from
 * re-mounts within a single session.
 *
 * Failure path: emit a `warning`-tone toast inviting the user to open
 * Settings → Capture for diagnostics. localStorage flag is NOT set so
 * the next launch retries.
 *
 * IPC system error: emit a `warning`-tone toast naming the error. flag
 * unset so the next launch retries.
 *
 * Persist failure (after successful detect): emit an info-tone toast
 * pointing the user at Settings → Capture to save manually. flag unset
 * so the next launch retries the persist. The user already saw the
 * success toast for the detect itself.
 */
async function runAutoDetect(
  persona: import('@/ipc/contract').Persona,
): Promise<void> {
  let result;
  try {
    result = await detectCaptureCli();
  } catch (err) {
    emitToast({
      tone: 'warning',
      title: 'Auto-detect could not run',
      description:
        err instanceof Error ? err.message : 'Unknown IPC error. Try Settings → Capture → Detect.',
    });
    throw err;
  }
  if (result.kind === 'failed') {
    emitToast({
      tone: 'warning',
      title: 'Could not detect the trail CLI',
      description: `${result.message} Open Settings → Capture for diagnostics.`,
    });
    return;
  }
  // result.kind === 'detected'
  emitToast({
    tone: 'success',
    title: `Trail CLI detected at ${result.path}`,
    description: `Version ${result.version} — ready to capture sessions.`,
  });
  // Persist for next launch. Auditor cannot write settings (Rust
  // handler rejects); skip persistence on that persona — flag-set is
  // still appropriate because we DID complete the user-visible work.
  if (persona === 'auditor') {
    setAutodetectFlag();
    return;
  }
  try {
    await writeSettings({ capture_cli_path: result.path }, persona);
    setAutodetectFlag();
  } catch (err) {
    // Persist failure is not blocking — Detect surfaced the path to
    // the user. Emit a console.warn so the diagnostic exists when
    // users report "auto-detect kept running" (gh#17 ERR-1).
    console.warn('[Trail] writeSettings failed after auto-detect:', err);
    emitToast({
      tone: 'info',
      title: 'Detected but could not save',
      description:
        'Open Settings → Capture to save the detected path manually so the next launch starts verified.',
    });
    // Deliberately do NOT set the flag — next launch retries the
    // detect + persist round-trip.
  }
}

function setAutodetectFlag(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(AUTODETECT_FLAG_KEY, '1');
  }
}
