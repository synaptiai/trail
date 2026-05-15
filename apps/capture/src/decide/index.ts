// `trail packet decide` orchestrator. Spec: docs/specs/phase-2-ui-flows.md
// §4.4 J9 step 7 (reviewer-side block-with-reason loop closure).
//
// Flow:
//   1. Validate decision enum + reason length + claim ID format.
//   2. gh auth status → exit 3 on fail.
//   3. Resolve PR via gh pr view.
//   4. Cross-reference: claim ID must resolve to a claim in the packet
//      (by id OR stable_id) per schema $defs/approval_trail_entry.
//   5. Append entry to packet.approval_trail[] (atomic write).
//   6. Render decision-comment markdown; post via gh pr comment --body-file.
//   7. Re-render packet markdown (now containing the new approval_trail
//      entry) and update the PR-body fenced section so the public surface
//      reflects the latest decision state. AC-6.
//
// EH-2 (cycle-1 P2) — mid-flow failure recovery procedure:
//
// The 7 steps are not transactional across system boundaries (local YAML
// + remote PR comment + remote PR body). Each failure mode has a distinct
// recovery path:
//
//   (a) auth/PR-resolution fails BEFORE step 5: nothing was written;
//       safe to re-run as-is after fixing the underlying issue.
//
//   (b) approval_trail append (step 5) fails: atomic-write rolled back
//       via tmp+rename — no partial state. Retry as-is.
//
//   (c) gh pr comment (step 6) fails AFTER approval_trail wrote: local
//       packet has the entry; PR has no comment; PR body fence is stale.
//       The error message instructs the reviewer to re-run `trail packet
//       post` to sync the body (the renderer will surface the recorded
//       approval_trail entry on the next post). The comment can be
//       posted manually if desired. Re-running `trail packet decide`
//       with the same args is also safe but will append a DUPLICATE
//       approval_trail entry — the schema permits multiple entries per
//       (claim_id, decision) pair (events, not state). The dup is
//       semantically correct (each call IS a new event) but reviewers
//       who want exactly-once semantics should prefer `trail packet post`
//       after a step-6 failure, NOT a re-decide.
//
//   (d) body refresh (step 7 / gh pr edit) fails AFTER comment posted:
//       approval_trail has the entry; comment is on the PR; body is
//       stale. Re-run `trail packet post` to refresh the body — it will
//       re-render with the recorded approval_trail entry and push.
//
//   (e) posted_to_pr ledger append (step 7 tail) fails AFTER body landed:
//       The command emits a `warning:` and exits 0 — the durable
//       surfaces (comment + body) succeeded; the ledger drift is
//       accepted (re-running `trail packet post` will append a fresh
//       posted_to_pr entry on the next sync).

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
import type { ApprovalTrailEntry, Packet, PostedToPrEntry } from "../packet/types.js";
import { loadYaml } from "../packet/yaml.js";
import { updateFence } from "../post/fence.js";
import {
  GhError,
  type GhRunner,
  ghAuthStatus,
  ghPrComment,
  ghPrEditBody,
  ghPrView,
  ghReadPrBody,
  ghRepoView,
  realGhRunner,
  splitOwnerRepo,
} from "../post/gh-shell.js";
import {
  appendApprovalTrail,
  appendPostedToPr,
  computeBodyHash,
  nowIso,
  readPacketClaimIds,
} from "../post/posted-to-pr.js";
import { renderMarkdown } from "../render/markdown.js";

export type Decision = "accept" | "changes" | "block" | "reject";

const DECISION_VALUES: readonly Decision[] = ["accept", "changes", "block", "reject"];

export interface DecideOptions {
  packetPath: string;
  prNumber?: number;
  claim: string; // CLAIM-NNN or 16-hex stable_id
  decision: Decision;
  reason: string | null;
  by: string;
  ghRunner?: GhRunner;
  now?: Date;
  tmpDirOverride?: string;
  stderr?: NodeJS.WriteStream | { write: (s: string) => void };
}

export interface DecideResult {
  exitCode: number;
  prNumber?: number;
  prUrl?: string;
}

function writeStderr(opts: DecideOptions, msg: string): void {
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

const CLAIM_ID_RE = /^CLAIM-\d{3,}$/;
const STABLE_ID_RE = /^[a-f0-9]{16}$/;

function validateClaimRef(s: string): boolean {
  return CLAIM_ID_RE.test(s) || STABLE_ID_RE.test(s);
}

/**
 * Render a markdown comment to be posted on the PR for this decision.
 * Format kept simple (one paragraph + monospace claim id) so it reads
 * cleanly in GitHub's comment surface.
 */
export function renderDecisionComment(entry: ApprovalTrailEntry): string {
  const decisionLabel: Record<Decision, string> = {
    accept: "✅ Accepted",
    changes: "🔁 Changes requested",
    block: "🛑 Blocked",
    reject: "❌ Rejected",
  };
  const lines: string[] = [];
  lines.push(`**Trail decision** — \`${entry.claim_id}\` ${decisionLabel[entry.decision]}`);
  lines.push("");
  lines.push(`*by ${entry.by} at ${entry.at}*`);
  if (entry.reason && entry.reason.trim() !== "") {
    lines.push("");
    lines.push(`> ${entry.reason.replace(/\n/g, "\n> ")}`);
  }
  lines.push("");
  lines.push("<sub>Posted by `trail packet decide` (Phase 3b).</sub>");
  return lines.join("\n");
}

export async function packetDecide(opts: DecideOptions): Promise<DecideResult> {
  const runner = opts.ghRunner ?? realGhRunner();

  // Step 0a: validate enum + reason + claim format (caller's CLI parser
  // also enforces these, but defence-in-depth).
  if (!DECISION_VALUES.includes(opts.decision)) {
    writeStderr(
      opts,
      `error: --decision must be one of ${DECISION_VALUES.join("|")}; got '${opts.decision}'\n`
    );
    return { exitCode: EXIT_INVALID_ARGS };
  }
  if (!validateClaimRef(opts.claim)) {
    writeStderr(
      opts,
      `error: --claim must be CLAIM-NNN or a 16-hex stable_id; got '${opts.claim}'\n`
    );
    return { exitCode: EXIT_INVALID_ARGS };
  }
  if (opts.reason !== null && opts.reason.length > 500) {
    writeStderr(
      opts,
      `error: --reason exceeds 500 chars (got ${opts.reason.length}); shorten or split.\n`
    );
    return { exitCode: EXIT_INVALID_ARGS };
  }
  if (
    (opts.decision === "changes" || opts.decision === "block" || opts.decision === "reject") &&
    (opts.reason === null || opts.reason.trim() === "")
  ) {
    writeStderr(
      opts,
      `error: --reason is required for decision '${opts.decision}' (per J9 step 2).\n`
    );
    return { exitCode: EXIT_INVALID_ARGS };
  }
  if (!opts.by || opts.by.trim() === "") {
    writeStderr(opts, "error: --by is required (decider identity, e.g., your email).\n");
    return { exitCode: EXIT_INVALID_ARGS };
  }

  // Step 0b: packet path exists.
  if (!existsSync(opts.packetPath)) {
    writeStderr(opts, `error: packet not found: ${opts.packetPath}\n`);
    return { exitCode: EXIT_PACKET_NOT_FOUND };
  }

  // Step 0c: claim ID resolves to a claim in this packet.
  let claimResolves = false;
  try {
    const { ids, stableIds } = readPacketClaimIds(opts.packetPath);
    claimResolves = ids.includes(opts.claim) || stableIds.includes(opts.claim);
  } catch (err) {
    writeStderr(
      opts,
      `error: failed to read packet for claim resolution: ${(err as Error).message}\n`
    );
    return { exitCode: EXIT_PACKET_NOT_FOUND };
  }
  if (!claimResolves) {
    writeStderr(
      opts,
      `error: --claim '${opts.claim}' does not resolve to any claim in this packet.\n       Run \`trail packet list\` and inspect the packet to find valid claim IDs.\n`
    );
    return { exitCode: EXIT_INVALID_ARGS };
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

  // Step 2: resolve PR.
  let prInfo: { number: number; url: string; headRefName: string };
  try {
    prInfo = await ghPrView(runner, opts.prNumber);
  } catch (err) {
    if (err instanceof GhError) {
      writeStderr(opts, `error: ${err.message}\n`);
      return { exitCode: ghErrorToExitCode(err) };
    }
    writeStderr(opts, `error: ${(err as Error).message}\n`);
    return { exitCode: EXIT_GENERIC };
  }

  // Step 3: append entry to approval_trail (atomic).
  const entry: ApprovalTrailEntry = {
    claim_id: opts.claim,
    decision: opts.decision,
    reason: opts.reason ?? null,
    by: opts.by,
    at: nowIso(opts.now),
  };
  const cleanup = signalCleanupHandle;
  try {
    appendApprovalTrail(opts.packetPath, entry, cleanup);
  } catch (err) {
    writeStderr(opts, `error: failed to append approval_trail entry: ${(err as Error).message}\n`);
    return { exitCode: EXIT_WRITE };
  }

  // Step 4: render decision-comment markdown + post via gh pr comment.
  const tmpRoot = opts.tmpDirOverride ?? tmpdir();
  const tmpDir = mkdtempSync(join(tmpRoot, "trail-decide-"));
  const commentFile = join(tmpDir, "comment.md");
  const commentMd = renderDecisionComment(entry);
  try {
    writeFileSync(commentFile, commentMd, { encoding: "utf-8" });
    cleanup.trackTmp(commentFile);
    await ghPrComment(runner, prInfo.number, commentFile);
  } catch (err) {
    if (err instanceof GhError) {
      writeStderr(
        opts,
        `error: approval_trail updated locally BUT gh pr comment failed: ${err.message}\n       Re-run \`trail packet post\` to sync the body, or post the comment manually.\n`
      );
      return { exitCode: ghErrorToExitCode(err) };
    }
    writeStderr(opts, `error: ${(err as Error).message}\n`);
    return { exitCode: EXIT_GENERIC };
  } finally {
    try {
      unlinkSync(commentFile);
    } catch {
      // best-effort
    }
    cleanup.untrackTmp(commentFile);
  }

  // Step 5: re-render packet markdown (now containing the new
  // approval_trail entry — though the renderer in v0.1 doesn't surface
  // approval_trail explicitly, it round-trips through the YAML so the
  // body_hash changes and the body is refreshed). Update the PR-body
  // fenced section to reflect this. AC-6.
  let packet: Packet;
  try {
    const raw = readFileSync(opts.packetPath, "utf-8");
    const parsed = loadYaml(raw);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`packet at ${opts.packetPath} did not parse as a YAML mapping`);
    }
    packet = parsed as Packet;
  } catch (err) {
    writeStderr(
      opts,
      `error: failed to re-load packet for fence refresh: ${(err as Error).message}\n`
    );
    return { exitCode: EXIT_GENERIC };
  }

  let owner: string;
  let repo: string;
  try {
    const r = await ghRepoView(runner);
    const split = splitOwnerRepo(r.nameWithOwner);
    owner = split.owner;
    repo = split.repo;
  } catch (err) {
    if (err instanceof GhError) {
      writeStderr(opts, `error: ${err.message}\n`);
      return { exitCode: ghErrorToExitCode(err) };
    }
    writeStderr(opts, `error: ${(err as Error).message}\n`);
    return { exitCode: EXIT_GENERIC };
  }

  let existingBody: string;
  try {
    existingBody = await ghReadPrBody(runner, owner, repo, prInfo.number);
  } catch (err) {
    if (err instanceof GhError) {
      writeStderr(opts, `error: ${err.message}\n`);
      return { exitCode: ghErrorToExitCode(err) };
    }
    writeStderr(opts, `error: ${(err as Error).message}\n`);
    return { exitCode: EXIT_GENERIC };
  }

  const packetMarkdown = renderMarkdown(packet, { packetPath: opts.packetPath });
  const newBody = updateFence(existingBody, packetMarkdown);

  const bodyFile = join(tmpDir, "body.md");
  try {
    writeFileSync(bodyFile, newBody, { encoding: "utf-8" });
    cleanup.trackTmp(bodyFile);
    await ghPrEditBody(runner, prInfo.number, bodyFile);
  } catch (err) {
    if (err instanceof GhError) {
      writeStderr(
        opts,
        `error: approval_trail + comment landed BUT body refresh failed: ${err.message}\n`
      );
      return { exitCode: ghErrorToExitCode(err) };
    }
    writeStderr(opts, `error: ${(err as Error).message}\n`);
    return { exitCode: EXIT_GENERIC };
  } finally {
    try {
      unlinkSync(bodyFile);
    } catch {
      // best-effort
    }
    cleanup.untrackTmp(bodyFile);
  }

  // Also append a posted_to_pr entry for this re-post (the body did get
  // updated; the trail of "what was posted, when, by whom" should reflect
  // the decide-driven re-post). Body hash is computed on the packet
  // markdown (same definition as packet post). CR-2 (cycle-1 P3):
  // computeBodyHash + appendPostedToPr are static top-level imports —
  // no import cycle exists with post/posted-to-pr.js.
  try {
    const bodyHash = computeBodyHash(packetMarkdown);
    const postEntry: PostedToPrEntry = {
      pr_url: prInfo.url,
      pr_number: prInfo.number,
      body_hash: bodyHash,
      posted_at: nowIso(opts.now),
      posted_by: opts.by,
    };
    appendPostedToPr(opts.packetPath, postEntry, cleanup);
  } catch (err) {
    writeStderr(
      opts,
      `warning: comment + body landed but posted_to_pr ledger update failed: ${(err as Error).message}\n`
    );
    // Don't fail the command — the durable surfaces (comment + body) succeeded.
  }

  writeStderr(
    opts,
    `decision recorded: ${entry.claim_id} ${entry.decision}; comment + body posted to ${prInfo.url}\n`
  );

  return { exitCode: EXIT_OK, prNumber: prInfo.number, prUrl: prInfo.url };
}
