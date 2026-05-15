// `trail packet post` orchestrator. Spec: docs/specs/phase-2-ui-flows.md §3.4 P3
// + docs/specs/phase-2-screen-specs.md §7.4 (M4).
//
// Flow:
//   1. Validate args (CLI layer does this; we trust input).
//   2. gh auth status → exit 3 on fail.
//   3. Resolve PR number: --pr <N> if given, else gh pr view --json number.
//   4. Resolve destination owner/name (gh repo view) for B6 destination
//      confirmation. Print "Posting to <owner>/<name>#<N>". --yes skips
//      interactive confirm.
//   5. Read existing PR body (gh api repos/.../pulls/N).
//   6. Render packet markdown via Phase 1 renderer.
//   7. updateFence(body, packetMd) → final body.
//   8. Write final body to a temp file → gh pr edit --body-file.
//   9. Append entry to packet.posted_to_pr[].

import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_AUTH,
  EXIT_GENERIC,
  EXIT_GH_MISSING,
  EXIT_INVALID_ARGS,
  EXIT_NETWORK,
  EXIT_OK,
  EXIT_PACKET_NOT_FOUND,
  EXIT_PR_NOT_FOUND,
  EXIT_RATE_LIMIT,
  EXIT_WRITE,
} from "../exit-codes.js";
import { signalCleanupHandle } from "../io/signals.js";
import type { Packet, PostedToPrEntry } from "../packet/types.js";
import { loadYaml } from "../packet/yaml.js";
import { renderMarkdown } from "../render/markdown.js";
import { updateFence } from "./fence.js";
import {
  GhError,
  type GhRunner,
  ghAuthStatus,
  ghPrEditBody,
  ghPrView,
  ghReadPrBody,
  ghRepoView,
  realGhRunner,
  splitOwnerRepo,
} from "./gh-shell.js";
import { appendPostedToPr, computeBodyHash, nowIso } from "./posted-to-pr.js";

export interface PostOptions {
  packetPath: string;
  prNumber?: number;
  yes: boolean;
  postedBy: string;
  // Confirm prompt: returns true if user confirms. Default: read y/N from stdin.
  confirm?: (msg: string) => Promise<boolean>;
  ghRunner?: GhRunner;
  now?: Date;
  // For tests: write temp body file under this dir instead of os.tmpdir().
  tmpDirOverride?: string;
  // Stderr write target (tests can capture).
  stderr?: NodeJS.WriteStream | { write: (s: string) => void };
}

export interface PostResult {
  exitCode: number;
  prNumber?: number;
  prUrl?: string;
  bodyHash?: string;
}

function writeStderr(opts: PostOptions, msg: string): void {
  const w = opts.stderr ?? process.stderr;
  w.write(msg);
}

function ghErrorToExitCode(err: GhError): number {
  switch (err.kind) {
    case "auth":
      return EXIT_AUTH;
    case "notInstalled":
      return EXIT_GH_MISSING;
    case "notFound":
      return EXIT_PR_NOT_FOUND;
    case "rateLimit":
      return EXIT_RATE_LIMIT;
    case "network":
      return EXIT_NETWORK;
    case "argInvalid":
      return EXIT_INVALID_ARGS;
    default:
      return EXIT_GENERIC;
  }
}

export async function packetPost(opts: PostOptions): Promise<PostResult> {
  const runner = opts.ghRunner ?? realGhRunner();

  // Step 0: validate packet path.
  if (!existsSync(opts.packetPath)) {
    writeStderr(opts, `error: packet not found: ${opts.packetPath}\n`);
    return { exitCode: EXIT_PACKET_NOT_FOUND };
  }

  // Step 1: gh auth status.
  try {
    await ghAuthStatus(runner);
  } catch (err) {
    if (err instanceof GhError) {
      writeStderr(
        opts,
        `error: gh authentication check failed.\n       Run \`gh auth login\` and retry.\n       Detail: ${err.message}\n`
      );
      return { exitCode: ghErrorToExitCode(err) };
    }
    writeStderr(opts, `error: ${(err as Error).message}\n`);
    return { exitCode: EXIT_GENERIC };
  }

  // Step 2: resolve PR number (and URL/headRefName) via gh pr view.
  let prInfo: { number: number; url: string; headRefName: string };
  try {
    prInfo = await ghPrView(runner, opts.prNumber);
  } catch (err) {
    if (err instanceof GhError) {
      const exitCode = ghErrorToExitCode(err);
      if (err.kind === "notFound") {
        const detail =
          opts.prNumber !== undefined
            ? `error: PR #${opts.prNumber} not found in this repository.\n`
            : "error: no PR is associated with the current branch.\n" +
              "       Open a PR first (`gh pr create`) or pass --pr <N>.\n";
        writeStderr(opts, detail);
      } else if (err.kind === "rateLimit") {
        writeStderr(
          opts,
          `error: GitHub API rate-limited. Wait a few minutes and retry, or check 'gh api rate_limit'.\n       Detail: ${err.message}\n`
        );
      } else if (err.kind === "network") {
        writeStderr(
          opts,
          `error: network failure talking to GitHub. Check connectivity and retry.\n       Detail: ${err.message}\n`
        );
      } else {
        writeStderr(opts, `error: ${err.message}\n`);
      }
      return { exitCode };
    }
    writeStderr(opts, `error: ${(err as Error).message}\n`);
    return { exitCode: EXIT_GENERIC };
  }

  // Step 3: resolve destination owner/repo (B6 hardening).
  let owner: string;
  let repo: string;
  let nameWithOwner: string;
  try {
    const r = await ghRepoView(runner);
    nameWithOwner = r.nameWithOwner;
    const split = splitOwnerRepo(nameWithOwner);
    owner = split.owner;
    repo = split.repo;
  } catch (err) {
    if (err instanceof GhError) {
      writeStderr(opts, `error: gh repo view failed: ${err.message}\n`);
      return { exitCode: ghErrorToExitCode(err) };
    }
    writeStderr(opts, `error: ${(err as Error).message}\n`);
    return { exitCode: EXIT_GENERIC };
  }

  // Step 4: destination confirmation.
  const dest = `${nameWithOwner}#${prInfo.number}`;
  writeStderr(opts, `Posting to ${dest} (${prInfo.url})\n`);

  if (!opts.yes) {
    const confirm = opts.confirm ?? defaultConfirm;
    let ok = false;
    try {
      ok = await confirm(`Confirm post to ${dest}? [y/N] `);
    } catch (err) {
      writeStderr(opts, `error: confirmation aborted: ${(err as Error).message}\n`);
      return { exitCode: EXIT_GENERIC };
    }
    if (!ok) {
      writeStderr(opts, "aborted: post cancelled by user.\n");
      return { exitCode: EXIT_GENERIC };
    }
  }

  // Step 5: render packet markdown.
  let packet: Packet;
  try {
    const raw = readFileSync(opts.packetPath, "utf-8");
    const parsed = loadYaml(raw);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`packet at ${opts.packetPath} did not parse as a YAML mapping`);
    }
    packet = parsed as Packet;
  } catch (err) {
    writeStderr(opts, `error: failed to load packet: ${(err as Error).message}\n`);
    return { exitCode: EXIT_PACKET_NOT_FOUND };
  }

  let packetMarkdown: string;
  try {
    packetMarkdown = renderMarkdown(packet, { packetPath: opts.packetPath });
  } catch (err) {
    writeStderr(opts, `error: failed to render packet markdown: ${(err as Error).message}\n`);
    return { exitCode: EXIT_GENERIC };
  }

  // Step 6: read existing PR body.
  // SEC-2 (cycle-1 P3) known limitation: there is no body-hash check between
  // this read and the gh pr edit below. A concurrent edit by another user/
  // bot in the window between read and edit will be overwritten (last-write-
  // wins) for content OUTSIDE the fence. Content INSIDE the fence is always
  // overwritten by design (Trail owns it). Mitigation deferred to v0.2 (gh
  // api PATCH with If-Match ETag, or re-read + diff right before edit).
  // Acceptable for v0.1: shared-PR concurrent posts are rare and the lossy
  // surface is bounded to the small read→edit window.
  let existingBody: string;
  try {
    existingBody = await ghReadPrBody(runner, owner, repo, prInfo.number);
  } catch (err) {
    if (err instanceof GhError) {
      writeStderr(opts, `error: failed to read PR body: ${err.message}\n`);
      return { exitCode: ghErrorToExitCode(err) };
    }
    writeStderr(opts, `error: ${(err as Error).message}\n`);
    return { exitCode: EXIT_GENERIC };
  }

  // Step 7: update fenced section.
  const newBody = updateFence(existingBody, packetMarkdown);

  // Step 8: write to temp body-file → gh pr edit --body-file.
  // The temp file is in os.tmpdir() (or override). The BASENAME ("body.md")
  // matches the Tauri allowlist regex
  //   ^[A-Za-z0-9_-][A-Za-z0-9._-]{0,123}\.[A-Za-z0-9]{1,4}$
  // but the path passed to gh is the FULL ABSOLUTE path. That's safe here
  // because the CLI runs in user-space and does not traverse the Tauri
  // shell-allowlist (which only gates UI-via-Tauri-shell invocations).
  // See gh-shell.ts:ghPrEditBody docblock for the Sprint-5 convergence plan.
  const cleanup = signalCleanupHandle;
  const tmpRoot = opts.tmpDirOverride ?? tmpdir();
  const tmpDir = mkdtempSync(join(tmpRoot, "trail-post-"));
  const bodyFile = join(tmpDir, "body.md");
  let bodyHash: string;
  try {
    writeFileSync(bodyFile, newBody, { encoding: "utf-8" });
    cleanup.trackTmp(bodyFile);
    await ghPrEditBody(runner, prInfo.number, bodyFile);
    bodyHash = computeBodyHash(packetMarkdown);
  } catch (err) {
    if (err instanceof GhError) {
      writeStderr(opts, `error: gh pr edit failed: ${err.message}\n`);
      try {
        unlinkSync(bodyFile);
      } catch {
        // best-effort
      }
      cleanup.untrackTmp(bodyFile);
      return { exitCode: ghErrorToExitCode(err) };
    }
    writeStderr(opts, `error: ${(err as Error).message}\n`);
    return { exitCode: EXIT_GENERIC };
  } finally {
    try {
      unlinkSync(bodyFile);
    } catch {
      // best-effort: file may already be gone or never created.
    }
    cleanup.untrackTmp(bodyFile);
  }

  // Step 9: append posted_to_pr entry.
  const entry: PostedToPrEntry = {
    pr_url: prInfo.url,
    pr_number: prInfo.number,
    body_hash: bodyHash,
    posted_at: nowIso(opts.now),
    posted_by: opts.postedBy,
  };
  try {
    appendPostedToPr(opts.packetPath, entry, cleanup);
  } catch (err) {
    writeStderr(
      opts,
      `error: posted to PR successfully BUT failed to update packet's posted_to_pr[]: ${(err as Error).message}\n` +
        `       Packet at ${opts.packetPath} may be inconsistent with PR state.\n`
    );
    return { exitCode: EXIT_WRITE };
  }

  writeStderr(opts, `posted packet to ${prInfo.url} (body_hash ${bodyHash.slice(0, 16)}…)\n`);

  return {
    exitCode: EXIT_OK,
    prNumber: prInfo.number,
    prUrl: prInfo.url,
    bodyHash,
  };
}

// Default y/N confirm prompt — reads one line from stdin.
// EH-4 (cycle-1 P3): on non-TTY stdin (e.g. CI without --yes, or stdin
// closed), reading would hang forever (no EOF handler). Detect non-TTY
// up front and throw a descriptive error so the caller can surface a
// "use --yes in non-interactive contexts" hint cleanly. Also handle
// the 'end' event so an early stdin close (not just non-TTY) resolves
// the promise rather than hanging.
async function defaultConfirm(msg: string): Promise<boolean> {
  if (process.stdin.isTTY === false) {
    throw new Error(
      "stdin is not a TTY; cannot prompt for confirmation. Re-run with --yes to skip the prompt in non-interactive contexts."
    );
  }
  process.stderr.write(msg);
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.pause();
      fn();
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const nlIdx = buf.indexOf("\n");
      if (nlIdx !== -1) {
        const answer = buf.slice(0, nlIdx).trim().toLowerCase();
        settle(() => resolve(answer === "y" || answer === "yes"));
      }
    };
    const onEnd = () => {
      // stdin closed without a complete line: treat as a "no" rather than
      // hanging. Prevents the documented CI-pipe hang failure mode.
      settle(() => {
        if (buf.trim() === "") {
          reject(
            new Error(
              "stdin closed without input; cannot prompt for confirmation. Re-run with --yes to skip the prompt."
            )
          );
        } else {
          const answer = buf.trim().toLowerCase();
          resolve(answer === "y" || answer === "yes");
        }
      });
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}
