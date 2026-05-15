// gh CLI subprocess wrapper. Spec: docs/architecture.md §3.3 (gh CLI as the
// sole external network egress); docs/specs/phase-2-ui-flows.md §3.4 P3.
//
// All gh invocations use `child_process.spawn` with an explicit args array —
// NEVER `exec` or shell strings — so user-controlled inputs (PR numbers,
// reasons, etc.) cannot inject shell metacharacters. Inputs are additionally
// validated against tight regexes BEFORE spawn, defence-in-depth.
//
// Exit-code mapping (gh#4 AC-8):
//   gh auth failure         → GhErrorKind.Auth     → exit 3 (EXIT_GIT_STATE)
//   gh PR not found         → GhErrorKind.NotFound → exit 9 (EXIT_PR_NOT_FOUND)
//   gh rate-limit (403/429) → GhErrorKind.RateLimit → exit 7 (EXIT_RATE_LIMIT)
//   gh network error        → GhErrorKind.Network  → exit 7 (EXIT_NETWORK)
//   gh not installed (ENOENT) → GhErrorKind.NotInstalled → exit 4 (EXIT_GH_MISSING)
//   any other gh failure    → GhErrorKind.Other    → exit 1 (EXIT_GENERIC)
//
// Note: we treat exit 3 as "auth fail" to match the existing Trail exit code
// EXIT_GIT_STATE — auth failure is "cannot reach upstream identity," which
// fits the GIT_STATE umbrella conceptually. PR-not-found gets exit 9
// (EXIT_PR_NOT_FOUND, NEW). Rate-limit gets exit 7. These mappings align with
// gh#4 AC-8 explicit per-class exit codes.

import { spawn } from "node:child_process";

export type GhErrorKind =
  | "auth"
  | "notFound"
  | "rateLimit"
  | "network"
  | "notInstalled"
  | "argInvalid"
  | "other";

export class GhError extends Error {
  constructor(
    public readonly kind: GhErrorKind,
    message: string,
    public readonly stderr: string = "",
    public readonly exitCode: number | null = null
  ) {
    super(message);
    this.name = "GhError";
  }
}

export interface GhRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GhRunner {
  run(args: string[]): Promise<GhRunResult>;
}

// Default runner: spawns the real `gh` binary. Tests inject a fake runner.
export function realGhRunner(): GhRunner {
  return {
    run(args: string[]): Promise<GhRunResult> {
      return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let proc: ReturnType<typeof spawn>;
        try {
          proc = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
        } catch (err) {
          // Synchronous spawn failure (rare; usually ENOENT comes via 'error').
          reject(
            new GhError("notInstalled", `failed to spawn gh: ${(err as Error).message}`, "", null)
          );
          return;
        }
        proc.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf-8");
        });
        proc.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf-8");
        });
        proc.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") {
            reject(
              new GhError(
                "notInstalled",
                "gh CLI not found on PATH. Install from https://cli.github.com/ and re-run.",
                stderr,
                null
              )
            );
            return;
          }
          reject(new GhError("other", `gh spawn error: ${err.message}`, stderr, null));
        });
        proc.on("close", (code) => {
          resolve({ stdout, stderr, exitCode: code ?? -1 });
        });
      });
    },
  };
}

// PR number validator: 1..2^31-1 (positive integer, no leading zero).
const PR_NUMBER_RE = /^[1-9][0-9]{0,9}$/;

function ensureValidPrNumber(prNumber: number): void {
  if (!Number.isInteger(prNumber) || prNumber < 1 || prNumber > 2_147_483_647) {
    throw new GhError(
      "argInvalid",
      `PR number must be a positive integer; got ${String(prNumber)}`
    );
  }
  if (!PR_NUMBER_RE.test(String(prNumber))) {
    throw new GhError("argInvalid", `PR number out of allowed range: ${prNumber}`);
  }
}

// Map a non-zero gh exit + stderr text to a structured GhError. The mapping
// is heuristic on stderr — gh's documented exit codes are limited (1, 4, 8).
// Exit 4 = HTTP 404 / not found (since gh 2.40); for older gh versions we
// also fall back to stderr keyword matching.
//
// References:
//   gh CLI source: https://github.com/cli/cli/blob/trunk/pkg/cmd/factory/default.go
//   gh exit semantics: https://cli.github.com/manual/gh_help_environment
function classifyGhFailure(exitCode: number, stderr: string): GhError {
  const lower = stderr.toLowerCase();
  // Auth: gh prints "you are not logged into..." or "authentication required"
  if (lower.includes("not logged") || lower.includes("authentication required")) {
    return new GhError("auth", `gh authentication failed: ${stderr.trim()}`, stderr, exitCode);
  }
  // 404 / not found
  if (
    exitCode === 4 ||
    lower.includes("could not resolve") ||
    lower.includes("not found") ||
    lower.includes("no pull requests found") ||
    lower.includes("no pr found")
  ) {
    return new GhError("notFound", `gh: resource not found: ${stderr.trim()}`, stderr, exitCode);
  }
  // Rate limit. SEC-4 (cycle-1 P3): use canonical gh phrases or HTTP-status
  // tokens with word-boundary matching — substring matches against bare
  // "403" / "429" can mis-classify legitimate stderr (e.g. SHAs, paths,
  // user-supplied strings echoed back) as rate-limit.
  if (
    lower.includes("rate limit") ||
    lower.includes("api rate limit") ||
    /\bhttp\s+403\b/.test(lower) ||
    /\bhttp\s+429\b/.test(lower) ||
    /\b403\s+forbidden\b/.test(lower) ||
    /\b429\b/.test(lower) // standalone 429 is far more rate-limit-specific than 403
  ) {
    return new GhError(
      "rateLimit",
      `gh: rate-limited by GitHub API. Wait a few minutes or check 'gh api rate_limit'. Original: ${stderr.trim()}`,
      stderr,
      exitCode
    );
  }
  // Network. SEC-4 (cycle-1 P3): "eof" is too short for a substring match
  // (could appear inside path/identifier/user-string echoes). Use canonical
  // network-error phrases gh actually emits, including word-boundary "eof"
  // and the "tcp:" prefix (TCP-stack errors).
  if (
    lower.includes("dial tcp") ||
    lower.includes("network is unreachable") ||
    lower.includes("no such host") ||
    lower.includes("connection refused") ||
    lower.includes("connection reset") ||
    lower.includes("i/o timeout") ||
    lower.includes("request timeout") ||
    /\beof\b/.test(lower) ||
    /\btcp:/.test(lower)
  ) {
    return new GhError(
      "network",
      `gh: network failure (check connectivity, then retry): ${stderr.trim()}`,
      stderr,
      exitCode
    );
  }
  return new GhError(
    "other",
    `gh exited ${exitCode}: ${stderr.trim() || "(no stderr)"}`,
    stderr,
    exitCode
  );
}

export async function ghAuthStatus(runner: GhRunner): Promise<void> {
  const r = await runner.run(["auth", "status"]);
  if (r.exitCode === 0) return;
  // gh prints to stderr on auth-status failure; classify and re-throw.
  throw classifyGhFailure(r.exitCode, r.stderr || r.stdout);
}

export interface PrViewResult {
  number: number;
  url: string;
  headRefName: string;
}

export async function ghPrView(runner: GhRunner, prNumber?: number): Promise<PrViewResult> {
  const args = ["pr", "view"];
  if (prNumber !== undefined) {
    ensureValidPrNumber(prNumber);
    args.push(String(prNumber));
  }
  args.push("--json", "number,url,headRefName");
  const r = await runner.run(args);
  if (r.exitCode !== 0) {
    throw classifyGhFailure(r.exitCode, r.stderr || r.stdout);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    throw new GhError(
      "other",
      `gh pr view returned non-JSON output: ${(err as Error).message}`,
      r.stdout,
      r.exitCode
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { number?: unknown }).number !== "number" ||
    typeof (parsed as { url?: unknown }).url !== "string" ||
    typeof (parsed as { headRefName?: unknown }).headRefName !== "string"
  ) {
    throw new GhError(
      "other",
      `gh pr view JSON missing expected fields: ${r.stdout.slice(0, 200)}`,
      r.stdout,
      r.exitCode
    );
  }
  const p = parsed as { number: number; url: string; headRefName: string };
  return { number: p.number, url: p.url, headRefName: p.headRefName };
}

export interface RepoViewResult {
  nameWithOwner: string;
}

/**
 * Split a `nameWithOwner` string ("owner/repo") into its components.
 * CR-3 (cycle-1 P3): hoisted from post/index.ts + decide/index.ts where
 * it was duplicated verbatim. Throws GhError("other") on malformed input.
 */
export function splitOwnerRepo(nameWithOwner: string): { owner: string; repo: string } {
  const parts = nameWithOwner.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GhError("other", `gh repo view returned malformed nameWithOwner: '${nameWithOwner}'`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export async function ghRepoView(runner: GhRunner): Promise<RepoViewResult> {
  const r = await runner.run(["repo", "view", "--json", "nameWithOwner"]);
  if (r.exitCode !== 0) {
    throw classifyGhFailure(r.exitCode, r.stderr || r.stdout);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    throw new GhError(
      "other",
      `gh repo view returned non-JSON output: ${(err as Error).message}`,
      r.stdout,
      r.exitCode
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { nameWithOwner?: unknown }).nameWithOwner !== "string"
  ) {
    throw new GhError(
      "other",
      `gh repo view JSON missing nameWithOwner: ${r.stdout.slice(0, 200)}`,
      r.stdout,
      r.exitCode
    );
  }
  return { nameWithOwner: (parsed as { nameWithOwner: string }).nameWithOwner };
}

/**
 * Update PR body. Uses --body-file (path to a temp file) rather than --body
 * (inline) for two reasons:
 *   1. PR bodies can exceed shell ARG_MAX on Linux (~256KiB) — packets often do.
 *   2. The Tauri shell-allowlist (apps/ui/src-tauri/capabilities/default.json)
 *      whitelists `gh pr edit ... --body-file` as the shape Trail will ship to
 *      the UI in Sprint 5 (M4). Matching the FLAG shape keeps capture/CLI and
 *      UI/Tauri spawn surfaces uniform on the verb side.
 *
 * NOTE on path shape: the Tauri allowlist regex for the `--body-file`
 * positional argument is basename-only (`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,123}\.[A-Za-z0-9]{1,4}$`,
 * no `/`). The CLI here passes a FULL ABSOLUTE path (e.g.,
 * `/tmp/trail-post-XXXXXX/body.md`) — that's intentional and SAFE in the CLI
 * context: the CLI runs in user-space and bypasses the Tauri shell-allowlist
 * entirely (the allowlist applies only to UI-shell-via-Tauri invocations).
 * When Sprint 5 wires the M4 modal flow through Tauri shell, that code path
 * will need to either (a) emit a basename + chdir into tmpDir for the spawn,
 * or (b) extend the allowlist regex to permit absolute paths under tmpdir.
 * Tracked in v0.1 follow-up.
 */
export async function ghPrEditBody(
  runner: GhRunner,
  prNumber: number,
  bodyFilePath: string
): Promise<void> {
  ensureValidPrNumber(prNumber);
  const r = await runner.run(["pr", "edit", String(prNumber), "--body-file", bodyFilePath]);
  if (r.exitCode !== 0) {
    throw classifyGhFailure(r.exitCode, r.stderr || r.stdout);
  }
}

export async function ghPrComment(
  runner: GhRunner,
  prNumber: number,
  bodyFilePath: string
): Promise<void> {
  ensureValidPrNumber(prNumber);
  const r = await runner.run(["pr", "comment", String(prNumber), "--body-file", bodyFilePath]);
  if (r.exitCode !== 0) {
    throw classifyGhFailure(r.exitCode, r.stderr || r.stdout);
  }
}

/**
 * Read PR body via `gh api repos/{owner}/{repo}/pulls/{N}` (returns the
 * `body` field). We use `gh api` rather than `gh pr view --json body` because
 * the `--json body` field has occasional encoding edge cases with embedded
 * code fences in older gh versions; the raw API response is more reliable.
 */
export async function ghReadPrBody(
  runner: GhRunner,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  ensureValidPrNumber(prNumber);
  // Validate owner/repo against the same regex used in the Tauri allowlist.
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,38}$/.test(owner)) {
    throw new GhError("argInvalid", `invalid owner segment: ${owner}`);
  }
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(repo)) {
    throw new GhError("argInvalid", `invalid repo segment: ${repo}`);
  }
  const r = await runner.run(["api", `repos/${owner}/${repo}/pulls/${prNumber}`]);
  if (r.exitCode !== 0) {
    throw classifyGhFailure(r.exitCode, r.stderr || r.stdout);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    throw new GhError(
      "other",
      `gh api returned non-JSON output: ${(err as Error).message}`,
      r.stdout,
      r.exitCode
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new GhError("other", `gh api: not an object: ${r.stdout.slice(0, 200)}`, r.stdout);
  }
  const body = (parsed as { body?: unknown }).body;
  // GitHub returns body=null for empty bodies; normalise to "".
  if (body === null || body === undefined) return "";
  if (typeof body !== "string") {
    throw new GhError("other", `gh api: body field not a string: ${typeof body}`, r.stdout);
  }
  return body;
}
