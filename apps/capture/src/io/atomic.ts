// Atomic write — tmp + rename. Spec §3 step 10f / §5 step 9.
// Caller registers tmp paths with a SignalCleanup so cleanup happens on
// SIGINT/SIGTERM. On any I/O failure: unlink tmp file, propagate the error.

import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";

export interface SignalCleanup {
  trackTmp(path: string): void;
  untrackTmp(path: string): void;
}

export const NOOP_SIGNAL_CLEANUP: SignalCleanup = {
  trackTmp() {},
  untrackTmp() {},
};

export function atomicWrite(
  finalPath: string,
  contents: string | Buffer,
  cleanup: SignalCleanup = NOOP_SIGNAL_CLEANUP
): void {
  const tmpPath = `${finalPath}.tmp`;
  cleanup.trackTmp(tmpPath);
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, "w", 0o644);
    const buf = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf-8");
    writeSync(fd, buf);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, finalPath);
    cleanup.untrackTmp(tmpPath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp may already be missing; ignore.
    }
    cleanup.untrackTmp(tmpPath);
    throw err;
  }
}
