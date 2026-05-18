// Stage the committed redacted transcript fixture for py-reference. We
// expose a tempdir via the `TRAIL_CLAUDE_PROJECTS_ROOT` env var (honored by
// py-reference's `CLAUDE_PROJECTS_ROOT` resolution) so the parity tests do
// NOT need to override HOME — overriding HOME detaches Python from the
// user's pyyaml install at `~/Library/Python/3.x/lib/python/site-packages`.
//
// Closes synaptiai/trail#5: the pre-#5 parity tests skipped on every
// contributor checkout and CI run because the live transcript path was
// absent.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ParityFixtureStaging {
  /** Absolute path to the committed redacted fixture. The TS port reads from this directly. */
  fixturePath: string;
  /** Value to set as `TRAIL_CLAUDE_PROJECTS_ROOT` on the py-reference subprocess env. Empty when unavailable. */
  projectsRootForPy: string;
  /** False only if the fixture is missing from the worktree (e.g., a stale checkout). */
  available: boolean;
}

export function stageParityFixture(sessionId: string): ParityFixtureStaging {
  const fixturePath = join(
    __dirname,
    "..",
    "fixtures",
    `${sessionId}.redacted.jsonl`,
  );
  if (!existsSync(fixturePath)) {
    return { fixturePath, projectsRootForPy: "", available: false };
  }
  // py-reference iterates every dir under `<projects-root>/` and matches by
  // `<session_id>.jsonl`. Any non-empty inner dirname works.
  const projectsRootForPy = mkdtempSync(join(tmpdir(), "trail-parity-projects-"));
  const sessionDir = join(projectsRootForPy, "-fixture");
  mkdirSync(sessionDir, { recursive: true });
  copyFileSync(fixturePath, join(sessionDir, `${sessionId}.jsonl`));
  return { fixturePath, projectsRootForPy, available: true };
}
