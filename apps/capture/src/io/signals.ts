// Signal handling. Spec §8.2.
// SIGINT/SIGTERM trigger reverse-order cleanup:
//   1. Tree-kill any in-flight LLM subprocess (SIGKILL immediately).
//   2. Unlink any tracked tmp files.
// Then exit with 130 (SIGINT) or 143 (SIGTERM).

import type { ChildProcess } from "node:child_process";
import { unlinkSync } from "node:fs";

const trackedTmp = new Set<string>();
let trackedSubprocess: ChildProcess | null = null;
let installed = false;
let installedExitFn: (code: number) => void = (code) => process.exit(code);

// [F22 / 2026-05-09] One-shot listener queue for the next non-null
// trackSubprocess transition. Lets tests await tracked-state deterministically
// without polling, eliminating the timing-window flakiness in the F1 test on
// loaded CI nodes. Listeners fire exactly once on the next non-null track and
// are removed atomically; the queue is cleared by resetSignalState().
type TrackListener = (child: ChildProcess) => void;
const onTrackOnceListeners: TrackListener[] = [];

export interface InstallOptions {
  exitFn?: (code: number) => void;
  log?: (message: string) => void;
}

export function trackTmp(path: string): void {
  trackedTmp.add(path);
}

export function untrackTmp(path: string): void {
  trackedTmp.delete(path);
}

export function trackSubprocess(child: ChildProcess | null): void {
  trackedSubprocess = child;
  if (child !== null && onTrackOnceListeners.length > 0) {
    // Drain the listener queue under a snapshot so a listener registering a
    // new listener doesn't get fired in the same drain cycle.
    const snapshot = onTrackOnceListeners.splice(0);
    for (const listener of snapshot) {
      try {
        listener(child);
      } catch {
        // Test-only hook; swallow to avoid disrupting production callers.
      }
    }
  }
}

export function untrackSubprocess(): void {
  trackedSubprocess = null;
}

// Test-observability hook (per F1 verification): returns the currently tracked
// subprocess reference, or null when none is tracked. Production callers
// SHOULD NOT depend on this — it exists to let tests assert the
// `spawnClaudeRunner` ↔ signal-cleanup wiring contract holds at runtime.
// See test/spawn-claude-runner.test.ts.
export function getTrackedSubprocessForTest(): ChildProcess | null {
  return trackedSubprocess;
}

/**
 * [F22 / 2026-05-09] Returns a Promise that resolves with the ChildProcess
 * reference the next time `trackSubprocess` is called with a non-null value.
 * If a subprocess is ALREADY tracked at call time, resolves immediately with
 * that reference. Used by `spawn-claude-runner.test.ts` to await tracked-state
 * deterministically rather than polling on a fixed window — the polling
 * approach went flaky on heavily-loaded CI when spawn took >200ms.
 *
 * Test-only — production code MUST NOT call this. Reset by resetSignalState().
 */
export function whenTrackedForTest(): Promise<ChildProcess> {
  if (trackedSubprocess !== null) return Promise.resolve(trackedSubprocess);
  return new Promise<ChildProcess>((resolve) => {
    onTrackOnceListeners.push(resolve);
  });
}

function cleanup(log: (m: string) => void): void {
  if (trackedSubprocess?.pid) {
    try {
      // Try tree-kill via process group; falls back to direct kill.
      try {
        process.kill(-trackedSubprocess.pid, "SIGKILL");
      } catch {
        try {
          trackedSubprocess.kill("SIGKILL");
        } catch {
          log(
            `warning: LLM subprocess ${trackedSubprocess.pid} may have leaked; check 'ps' for stragglers`
          );
        }
      }
    } catch {
      // ignore
    }
  }
  for (const path of [...trackedTmp]) {
    try {
      unlinkSync(path);
    } catch {
      // ignore — tmp may already be renamed/removed.
    }
    trackedTmp.delete(path);
  }
}

/**
 * Install SIGINT/SIGTERM handlers that flush tmp files and tree-kill any
 * tracked LLM subprocess before exiting with 130/143.
 *
 * @remarks
 * **[F9 / 2026-05-09] Process-singleton constraint**:
 *
 * 1. **Idempotent for one process**: `installed` guard makes a second call
 *    a no-op. The first `opts.exitFn`/`opts.log` win; subsequent calls
 *    cannot override.
 *
 * 2. **Additive to other libraries' handlers**: `process.on("SIGINT", ...)`
 *    is not exclusive — handlers already registered (e.g., better-sqlite3
 *    native shutdown, Drizzle, vitest, an embedding host) keep running.
 *    `installSignalHandlers` does NOT call
 *    `process.removeAllListeners("SIGINT")` because that would silently
 *    break the embedding host's expectations. If you need exclusive
 *    handler ownership, call `removeAllListeners` yourself before
 *    invoking this function.
 *
 * 3. **Module-level state is process-global**: `trackedTmp` (Set) and
 *    `trackedSubprocess` (ref) are module-scoped. Multiple concurrent
 *    invocations of `generate()` in the SAME process will see each
 *    other's tracked state — fine for the Phase 1 CLI usage (single
 *    invocation per process) but UNSAFE for Phase 2 server / library
 *    embedding where multiple `generate()` calls overlap. For Phase 2
 *    this should be refactored to a per-call instance with a returned
 *    cleanup handle.
 *
 * @see resetSignalState — clears module-level state for tests.
 */
export function installSignalHandlers(opts: InstallOptions = {}): void {
  if (installed) return;
  installed = true;
  installedExitFn = opts.exitFn ?? installedExitFn;
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));

  process.on("SIGINT", () => {
    cleanup(log);
    log("trail aborted on SIGINT");
    installedExitFn(130);
  });
  process.on("SIGTERM", () => {
    cleanup(log);
    log("trail aborted on SIGTERM");
    installedExitFn(143);
  });
}

export function resetSignalState(): void {
  trackedTmp.clear();
  trackedSubprocess = null;
  // [F22 / 2026-05-09] Drop any pending one-shot track listeners so tests
  // start each case with a clean observability slate.
  onTrackOnceListeners.length = 0;
}

export const signalCleanupHandle = {
  trackTmp,
  untrackTmp,
};
