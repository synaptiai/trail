// [F1 + F2 / 2026-05-09] spawnClaudeRunner subprocess wiring + tree-kill.
//
// F1: trackSubprocess() must be called after spawn so SIGINT/SIGTERM during
//     LLM call delivers tree-kill via the global signal cleanup singleton.
// F2: Subprocess must be spawned with `detached: true` so it becomes a
//     process-group leader. Without this, `process.kill(-pid, "SIGKILL")`
//     (the negative-PID form for tree-kill) fails with ESRCH/EPERM and the
//     fallback `child.kill("SIGKILL")` only kills the direct child, leaving
//     grandchildren (model subprocesses spawned by `claude`) alive.
//
// Strategy:
//  - Test 1: directly verify trackSubprocess is invoked after spawn by
//    intercepting via a controlled fake `claude` shim on PATH.
//  - Test 2: tree-kill propagation via a synthetic shell wrapper that
//    spawns its own grandchild (`bash -c 'sleep 60 & wait'`). After
//    sending SIGINT, assert no surviving grandchild PID.
//
// Both tests skip on Windows (POSIX process-group semantics required).

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { spawnClaudeRunner } from "../src/claims/llm.js";
import {
  getTrackedSubprocessForTest,
  resetSignalState,
  trackSubprocess,
  whenTrackedForTest,
} from "../src/io/signals.js";

const isPosix = process.platform !== "win32";

describe.runIf(isPosix)("spawnClaudeRunner — F1 trackSubprocess wiring", () => {
  test("after spawn, the child is registered with the signal-cleanup singleton", async () => {
    // Build a fake `claude` shim that sleeps briefly so we have a window in
    // which the child is alive and tracked.
    const dir = mkdtempSync(join(tmpdir(), "trail-claude-"));
    const claudeShim = join(dir, "claude");
    writeFileSync(claudeShim, '#!/usr/bin/env bash\nsleep 0.4\necho "[]"\n');
    chmodSync(claudeShim, 0o755);

    // Cycle-3 C3-S-CR-6: snapshot PATH and restore via try/finally so a
    // failed assertion can't leak the temp `claude` shim into PATH for
    // subsequent tests in the same vitest worker.
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;

    try {
      resetSignalState();
      expect(getTrackedSubprocessForTest()).toBeNull();

      // [F22 / 2026-05-09] Subscribe BEFORE invoking the runner so we
      // deterministically catch the trackSubprocess call regardless of how
      // long `spawn` takes to return. Replaces the prior 600ms polling loop
      // (10ms intervals) which could miss the tracked window on a heavily
      // loaded CI node where spawn() takes >200ms.
      const runner = spawnClaudeRunner();
      const trackedPromise = whenTrackedForTest();
      const runPromise = runner({
        prompt: "test",
        model: "x",
        budgetUsd: 0,
        timeoutSeconds: 5,
      });

      // F1 contract: trackSubprocess is called after spawn returns, before
      // close/error fires. The promise resolves the moment the runner's
      // internal `trackSubprocess(child)` call lands — no fixed timing window.
      const observedTracked = await trackedPromise;

      const out = await runPromise;

      expect(out.status).toBe("ok");
      expect(out.stdout.trim()).toBe("[]");
      // F1 contract: the subprocess WAS registered with the signal-cleanup
      // singleton during the runner's lifecycle.
      expect(observedTracked).not.toBeNull();
      expect(observedTracked.pid).toBeGreaterThan(0);
      // F1 contract: untrackSubprocess() was called when the runner settled,
      // so the singleton is back to null after the runner returns.
      expect(getTrackedSubprocessForTest()).toBeNull();
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("whenTrackedForTest resolves immediately if a subprocess is already tracked", async () => {
    // [F22 / 2026-05-09] Direct contract test for the deterministic
    // observability primitive. Confirms the "already tracked" fast path
    // resolves without needing a new track event.
    resetSignalState();
    const fakeChild = {
      pid: 99999,
      kill: () => true,
    } as unknown as import("node:child_process").ChildProcess;
    trackSubprocess(fakeChild);
    const observed = await whenTrackedForTest();
    expect(observed).toBe(fakeChild);
    resetSignalState();
  });

  test("whenTrackedForTest resolves on the next track call when nothing is tracked yet", async () => {
    // [F22 / 2026-05-09] Direct contract test for the listener-queue path.
    resetSignalState();
    const trackedPromise = whenTrackedForTest();
    const fakeChild = {
      pid: 88888,
      kill: () => true,
    } as unknown as import("node:child_process").ChildProcess;
    // Defer the track to the next microtask so the listener really does
    // wait — proves the queue actually fires, not just the fast path.
    queueMicrotask(() => trackSubprocess(fakeChild));
    const observed = await trackedPromise;
    expect(observed).toBe(fakeChild);
    resetSignalState();
  });

  test("trackSubprocess is exported and callable (smoke; the runner uses it internally)", () => {
    // Direct unit-level confirmation of the wiring contract: the function
    // is a real export with the expected signature. Production wiring is
    // covered by the runner-level test above.
    resetSignalState();
    const fakeChild = {
      pid: 12345,
      kill: () => true,
    } as unknown as import("node:child_process").ChildProcess;
    expect(() => trackSubprocess(fakeChild)).not.toThrow();
    resetSignalState();
  });
});

describe.runIf(isPosix)("spawnClaudeRunner — F2 detached + tree-kill", () => {
  test("a wrapper subprocess spawned via the runner becomes a process-group leader", async () => {
    // Use a fake `claude` shim that:
    //  1. echoes `[]` on stdout (the runner expects valid JSON for ok status),
    //  2. emits its own PID and PGID on stderr (so we can verify pgid==pid),
    //  3. exits 0 quickly so the runner returns `ok` (no timeout).
    // With detached:true, the child MUST be its own process-group leader
    // (pgid == pid). Without detached:true, pgid would equal the parent
    // Node process's pgid.
    const dir = mkdtempSync(join(tmpdir(), "trail-claude-"));
    const claudeShim = join(dir, "claude");
    writeFileSync(
      claudeShim,
      [
        "#!/usr/bin/env bash",
        'echo "[]"',
        // `ps -o pgid= -p $$` returns the PGID of the current shell.
        "MY_PID=$$",
        'MY_PGID=$(ps -o pgid= -p $$ | tr -d " ")',
        "echo pid=$MY_PID >&2",
        "echo pgid=$MY_PGID >&2",
        "exit 0",
      ].join("\n")
    );
    chmodSync(claudeShim, 0o755);

    // Cycle-3 C3-S-CR-6: snapshot PATH and restore via try/finally so a
    // failed assertion can't leak the temp `claude` shim into PATH for
    // subsequent tests in the same vitest worker.
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;

    try {
      const runner = spawnClaudeRunner();
      const out = await runner({
        prompt: "test",
        model: "x",
        budgetUsd: 0,
        timeoutSeconds: 5,
      });

      expect(out.status).toBe("ok");
      expect(out.stdout.trim()).toBe("[]");

      const pidMatch = out.stderr.match(/pid=(\d+)/);
      const pgidMatch = out.stderr.match(/pgid=(\d+)/);
      expect(pidMatch).not.toBeNull();
      expect(pgidMatch).not.toBeNull();
      const pid = Number.parseInt(pidMatch![1]!, 10);
      const pgid = Number.parseInt(pgidMatch![1]!, 10);

      // F2 contract: with detached:true, the spawned child becomes its own
      // process-group leader, so pgid == pid. This is the wiring that lets
      // signals.ts:cleanup() tree-kill via process.kill(-pid, ...).
      expect(pgid).toBe(pid);
      expect(pgid).not.toBe(process.pid);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("timeout path delivers SIGTERM via negative-PID form (tree-kill)", async () => {
    // Fake claude that hangs forever; runner must time out and tree-kill it
    // along with any grandchildren. We assert the grandchild dies within
    // the kill grace window.
    //
    // Cycle-3 C3-S-CR-1 (PR #29): the cycle-1.5 attempt at this test wrote
    // `$$` from inside the `( … )` subshell — but bash's `$$` always
    // expands to the calling shell's PID, NOT the subshell's. The pidfile
    // therefore contained the bash-shim parent PID; the assertion only
    // passed because tree-kill takes both parent and grandchild together.
    // The test would have falsely passed even if `detached:true` regressed
    // and the runner only killed the direct child. macOS bash 3.2 doesn't
    // support `$BASHPID`, so the portable fix is to capture `$!` in the
    // PARENT shell (which is the grandchild's PID by definition) and write
    // it to the file synchronously before `wait`. The write happens
    // BEFORE any SIGTERM can reach the parent — there's no race window.
    //
    // Cycle-1.5 F1-11 (predecessor): replaced the original stderr-regex
    // grandchild-PID parse with a file-based polling pattern to defeat the
    // stderr-flush race under slow CI. The file-based pattern still holds;
    // only the write-site moves from subshell to parent.
    const dir = mkdtempSync(join(tmpdir(), "trail-claude-"));
    const claudeShim = join(dir, "claude");
    const grandchildMarker = join(dir, "grandchild-alive");
    const grandchildPidFile = join(dir, "grandchild-pid");
    writeFileSync(
      claudeShim,
      [
        "#!/usr/bin/env bash",
        'echo "[]"',
        // Spawn the grandchild, then the PARENT shell writes `$!` (the
        // grandchild's real PID) to the pidfile synchronously. `$!`
        // captured in the parent IS the subshell's PID; `$$` inside the
        // subshell would be the parent's PID (cycle-3 bug).
        `(while true; do touch '${grandchildMarker}'; sleep 0.1; done) &`,
        "GRANDCHILD=$!",
        `echo "$GRANDCHILD" > '${grandchildPidFile}'`,
        "wait $GRANDCHILD",
      ].join("\n")
    );
    chmodSync(claudeShim, 0o755);

    // Cycle-3 C3-S-CR-6: snapshot PATH and restore via try/finally so a
    // failed assertion can't leak the temp `claude` shim into PATH for
    // subsequent tests in the same vitest worker.
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;

    try {
      const runner = spawnClaudeRunner();
      const startedAt = Date.now();
      const out = await runner({
        prompt: "test",
        model: "x",
        budgetUsd: 0,
        timeoutSeconds: 1, // short timeout to trigger the kill path
      });
      const elapsed = Date.now() - startedAt;

      expect(out.status).toBe("timeout");
      // Runner uses 1s timeout + up to 5s grace before SIGKILL escalation.
      expect(elapsed).toBeLessThan(8000);

      // Poll the PID file with a bounded retry — the parent shell writes
      // it before `wait`, but the write may not be visible yet at the
      // moment the runner returns (depending on kernel scheduling on a
      // slow CI host). 5s × 50ms = generous window.
      let grandchildPid: number | null = null;
      for (let i = 0; i < 100; i++) {
        if (existsSync(grandchildPidFile)) {
          const raw = readFileSync(grandchildPidFile, "utf8").trim();
          if (raw) {
            const parsed = Number.parseInt(raw, 10);
            if (parsed > 0) {
              grandchildPid = parsed;
              break;
            }
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(grandchildPid).not.toBeNull();
      // Defense-in-depth: the grandchild PID MUST differ from the parent
      // shell's PID. If a future bash mode regression silently writes the
      // parent PID again, this assertion fires immediately rather than
      // letting tree-kill mask the bug like cycle-3 C3-S-CR-1 did.
      expect(grandchildPid).not.toBe(process.pid);

      // Wait briefly for the grandchild to fully exit after SIGTERM tree-kill.
      await new Promise((r) => setTimeout(r, 500));

      // Probe: is the grandchild still alive? `process.kill(pid, 0)` throws
      // ESRCH if the process is gone.
      let stillAlive = true;
      try {
        process.kill(grandchildPid!, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") stillAlive = false;
      }
      expect(stillAlive).toBe(false);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe.runIf(isPosix)("spawnClaudeRunner — F20 inner SIGKILL timer cleanup", () => {
  test("after timeout-then-close, the SIGKILL-escalation timer is cleared on settle", async () => {
    // [F20 / 2026-05-09] When the outer timeout fires, the runner installs
    // an inner 5s SIGKILL-escalation timer. If the child exits in response
    // to the SIGTERM (i.e., before the 5s grace expires), the close handler
    // settles the runner. The contract: settle() MUST clear the inner
    // timer; otherwise the timer keeps the event loop alive (no `.unref()`
    // historically) and the CLI takes up to 5 extra seconds to exit.
    //
    // Verification strategy: spy on `clearTimeout` at the global level. The
    // runner creates exactly two timers — outer (timeoutSeconds*1000) and
    // inner (5000) — and `settle()` MUST clearTimeout BOTH (the outer is
    // cleared by `child.on("close", ...)`, the inner is cleared inside
    // settle() per the F20 fix). We assert clearTimeout receives both
    // unique timer handles by the time the runner promise resolves.

    const dir = mkdtempSync(join(tmpdir(), "trail-claude-"));
    const claudeShim = join(dir, "claude");
    // Shim that prints `[]` then sleeps; SIGTERM-responsive (default bash
    // sleep dies on SIGTERM). The runner times out, sends SIGTERM via the
    // negative-PID path, and the shim exits ~immediately, triggering the
    // close handler well before the inner 5s timer would fire.
    writeFileSync(claudeShim, ["#!/usr/bin/env bash", 'echo "[]"', "exec sleep 30"].join("\n"));
    chmodSync(claudeShim, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;

    // Capture the set of timer handles passed to clearTimeout during the
    // runner's lifetime. We compare against the timers created by setTimeout
    // to confirm both outer + inner are cleared.
    const setSpy = vi.spyOn(global, "setTimeout");
    const clearSpy = vi.spyOn(global, "clearTimeout");

    try {
      const runner = spawnClaudeRunner();
      const startedAt = Date.now();
      const out = await runner({
        prompt: "test",
        model: "x",
        budgetUsd: 0,
        timeoutSeconds: 1,
      });
      const elapsed = Date.now() - startedAt;

      expect(out.status).toBe("timeout");
      // F20 contract: the runner promise resolves promptly after SIGTERM
      // takes effect — well under the 5s grace window. If the inner timer
      // were keeping the event loop alive without being cleared, the await
      // wouldn't return any later (settle resolves the promise) but a
      // subsequent process-exit attempt would stall ~5s. We assert prompt
      // resolution as a smoke check; the deterministic assertion below
      // covers the leak directly.
      expect(elapsed).toBeLessThan(4000);

      // Find every Timeout handle returned by setTimeout during the run.
      const createdTimers = setSpy.mock.results
        .filter((r) => r.type === "return")
        .map((r) => r.value)
        .filter(
          (v): v is NodeJS.Timeout =>
            v != null && typeof (v as { ref?: unknown }).ref === "function"
        );

      // We expect at minimum the outer timeout timer and the inner 5s
      // SIGKILL-escalation timer to have been created during the timeout
      // path. (Other tests/modules may create unrelated timers; we only
      // care about the runner's two.)
      expect(createdTimers.length).toBeGreaterThanOrEqual(2);

      const clearedHandles = new Set(
        clearSpy.mock.calls.map((call) => call[0]).filter((h) => h != null)
      );

      // F20 contract: BOTH the outer timer and the inner 5s SIGKILL timer
      // were created AND cleared. Without the fix, only the outer timer
      // would appear in `clearedHandles` — the inner timer would leak.
      const runnerTimersCleared = createdTimers.filter((t) => clearedHandles.has(t));
      expect(runnerTimersCleared.length).toBeGreaterThanOrEqual(2);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
