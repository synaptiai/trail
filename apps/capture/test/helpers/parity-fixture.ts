// Stage the committed redacted transcript fixture for py-reference. We
// expose a tempdir via the `TRAIL_CLAUDE_PROJECTS_ROOT` env var (honored by
// py-reference's `CLAUDE_PROJECTS_ROOT` resolution) so the parity tests do
// NOT need to override HOME — overriding HOME detaches Python from the
// user's pyyaml install at `~/Library/Python/3.x/lib/python/site-packages`.
//
// Closes synaptiai/trail#5: the pre-#5 parity tests skipped on every
// contributor checkout and CI run because the live transcript path was
// absent.

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ParityFixtureStaging {
  /** Absolute path to the committed redacted fixture. The TS port reads from this directly. */
  fixturePath: string;
  /** Value to set as `TRAIL_CLAUDE_PROJECTS_ROOT` on the py-reference subprocess env. */
  projectsRootForPy: string;
  /** Callback that vitest's `afterAll` should invoke to remove the staged tempdir. */
  cleanup: () => void;
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function stageParityFixture(sessionId: string): ParityFixtureStaging {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(
      `stageParityFixture: invalid sessionId "${sessionId}" (must match UUID v4 shape)`
    );
  }
  const fixturePath = join(__dirname, "..", "fixtures", `${sessionId}.redacted.jsonl`);
  // The fixture is committed to the repo. A missing fixture is a tooling
  // failure (stale checkout, accidental delete, failed LFS pull), not a
  // legitimate environmental absence — so we throw loudly instead of
  // returning `{ available: false }` and letting the parity suite skip
  // silently. Silent-skip is the failure mode #5 was created to eliminate.
  try {
    statSync(fixturePath);
  } catch (err) {
    const reason = (err as Error).message;
    const msg = `stageParityFixture: committed fixture missing at ${fixturePath} — tooling failure, not a legitimate skip. Underlying: ${reason}`;
    throw new Error(msg);
  }
  const projectsRootForPy = mkdtempSync(join(tmpdir(), "trail-parity-projects-"));
  let staged = false;
  try {
    // py-reference iterates every dir under `<projects-root>/` and matches by
    // `<session_id>.jsonl`. Any non-empty inner dirname works.
    const sessionDir = join(projectsRootForPy, "-fixture");
    mkdirSync(sessionDir, { recursive: true });
    copyFileSync(fixturePath, join(sessionDir, `${sessionId}.jsonl`));
    staged = true;
  } finally {
    if (!staged) {
      // Stage failed mid-way. Release the tempdir we just minted so the
      // worktree doesn't accumulate orphans on repeat-failed runs.
      rmSync(projectsRootForPy, { recursive: true, force: true });
    }
  }
  const cleanup = () => rmSync(projectsRootForPy, { recursive: true, force: true });
  return { fixturePath, projectsRootForPy, cleanup };
}
