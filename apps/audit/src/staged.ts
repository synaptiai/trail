// Staged-file detection. Per gh#3 acceptance criterion 3:
//   --staged-only reads the set of files staged for commit via
//   `git diff --cached --name-only --diff-filter=AM` and filters to
//   `.trail/sessions/*/packet-*.{yml,md}` (the scan boundary defined
//   by criterion 2).
//
// Why simple-git: already a dep of @synapti/trail-capture (cross-platform, handles
// shell-escaping). Added as a direct dep of @synapti/trail-audit so we don't rely
// on an undeclared transitive (workspace dep coupling).

import { posix } from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";

export class GitStateError extends Error {
  readonly subShape: "not-a-repo" | "diff-failed";
  constructor(subShape: "not-a-repo" | "diff-failed", message: string) {
    super(message);
    this.name = "GitStateError";
    this.subShape = subShape;
  }
}

// Scan boundary: `.trail/sessions/<session-id>/packet-<N>.{yml,md}`.
// `<session-id>` is a UUID-shape directory (Claude Code's session id format)
// but we don't constrain the shape — the boundary is the directory layout,
// not the directory naming. `<N>` is the recapture index (1, 2, ...).
//
// Posix-style separators: git always emits forward slashes regardless of
// host OS, so the regex matches the git output directly without
// path.normalize() acrobatics. The relative paths we receive are anchored
// at repo root (per `git diff --cached --name-only`).
//
// [F25 lesson — port semantics from py-reference, not hand-derive]:
// py-reference scans EVERY file under .trail/ recursively (rglob("*")),
// not specifically packet-*.{yml,md}. The issue body's acceptance criterion
// 2 narrows to "packet-*.yml, packet-*.md" — this is the canonical scan
// boundary for the TS port. The TS scanner is intentionally narrower than
// the py-reference because:
//   (a) The patterns are calibrated for packet-shape content;
//   (b) Other .trail/ artefacts (sqlite db, lockfiles) are binary/structured
//       and not meant to be regex-scanned;
//   (c) A stricter boundary reduces the false-positive rate for the
//       pre-commit hook, which is the primary user-facing impact of Layer 3.
const PACKET_PATH_RE = /^\.trail\/sessions\/[^/]+\/packet-[^/]+\.(yml|md)$/;

export function isPacketPath(relPath: string): boolean {
  // Normalize Windows backslashes that may appear if a caller pre-processed
  // git output. Git itself always emits forward slashes.
  const normalized = relPath.replace(/\\/g, "/");
  return PACKET_PATH_RE.test(normalized);
}

export interface StagedFilesOptions {
  cwd: string;
  /** Optional injection seam for tests. Defaults to a real simpleGit. */
  git?: SimpleGit;
}

/**
 * Returns the absolute paths of staged files matching the packet boundary.
 *
 * Throws GitStateError("not-a-repo") if cwd is not inside a git work tree.
 * Throws GitStateError("diff-failed") if the underlying git invocation fails
 * for any other reason (corrupt index, permissions, etc.).
 *
 * --diff-filter=AM: include only Added (A) and Modified (M) files. Deleted
 * files have nothing to scan; copied/renamed files appear as Added under
 * their new path. This matches py-reference's "scan whatever is in the
 * tree right now" semantics for the staged subset.
 */
export async function listStagedPackets(options: StagedFilesOptions): Promise<string[]> {
  const git = options.git ?? simpleGit({ baseDir: options.cwd });
  // Probe repo presence first so we get a clean GitStateError, not a
  // generic simple-git error wrapper.
  let isRepo: boolean;
  try {
    isRepo = await git.checkIsRepo();
  } catch (err) {
    throw new GitStateError(
      "not-a-repo",
      `not a git repository: ${options.cwd} (${(err as Error).message})`
    );
  }
  if (!isRepo) {
    throw new GitStateError("not-a-repo", `not a git repository: ${options.cwd}`);
  }
  // `raw` to avoid simple-git's diff-summary parsing — we just want
  // newline-separated relative paths.
  let raw: string;
  try {
    raw = await git.raw(["diff", "--cached", "--name-only", "--diff-filter=AM"]);
  } catch (err) {
    throw new GitStateError("diff-failed", `git diff --cached failed: ${(err as Error).message}`);
  }
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => isPacketPath(l));
  // Convert to absolute paths anchored at cwd. simple-git's baseDir is the
  // git repo root; if the user invoked `trail audit precommit` from a
  // subdirectory, cwd != repo root. We use posix.join then re-anchor on
  // path.resolve at the call site for cross-platform absolute paths.
  return lines.map((l) => posix.join(options.cwd.replace(/\\/g, "/"), l));
}
