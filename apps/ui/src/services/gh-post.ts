/**
 * GitHub-post service — typed wrappers around the `post_to_pr` and
 * `decide_on_pr` IPC commands (Sprint 5 / gh#12).
 *
 * The Rust handler shells out to Phase 3b's `trail packet post` /
 * `trail packet decide` via the cli_bridge subprocess primitive. This
 * client adds:
 *   - `by` / `posted_by` defaulting from settings (falls back to "you").
 *   - typed result destructuring so the M2/M4 modal callers don't have
 *     to re-parse the IPC contract.
 *   - a structured `GhEdgeFlowKind` that Banner UIs switch on; mirrors
 *     the Rust `PacketOpErrorKind` 1:1 plus the synthesised `gh-auth-
 *     fail` (E3) variant the M2 modal triggers.
 */
import { invoke, IpcInvocationError } from '@/ipc/client';
import {
  KEBAB_KIND_PREFIX_PATTERN,
  KEBAB_KIND_STRIP_PATTERN,
  type DecisionKind,
  type IpcError,
  type Persona,
} from '@/ipc/contract';

export interface PostToPrInput {
  packet_id: string;
  pr_number?: number;
  /**
   * Cycle-2 C15 (PR #21): persona threading — the Rust handler
   * rejects auditor with `IpcError::PersonaForbidden`. Callers MUST
   * pass the active persona; the React UI sources it from
   * `App.tsx::readPersonaFromUrl` so client + server enforcement
   * match. This is defence-in-depth on top of the UI gating that
   * already prevents auditor from seeing the M4 post button.
   */
  persona: Persona;
}

export interface PostToPrOutcome {
  pr_url?: string;
  destination?: string;
  body_hash_prefix?: string;
}

export async function postToPr(input: PostToPrInput): Promise<PostToPrOutcome> {
  const args: Record<string, unknown> = {
    packet_id: input.packet_id,
    persona: input.persona,
  };
  if (input.pr_number !== undefined) args.pr_number = input.pr_number;
  const r = await invoke<{
    ok: boolean;
    pr_url?: string;
    destination?: string;
    body_hash_prefix?: string;
  }>('post_to_pr', args);
  // exactOptionalPropertyTypes: only include the field when the
  // backend returned a value, so the consumer's `if (outcome.pr_url)`
  // check works without coercion.
  const out: PostToPrOutcome = {};
  if (r.pr_url !== undefined) out.pr_url = r.pr_url;
  if (r.destination !== undefined) out.destination = r.destination;
  if (r.body_hash_prefix !== undefined) out.body_hash_prefix = r.body_hash_prefix;
  return out;
}

export interface DecideOnPrInput {
  packet_id: string;
  claim_id: string;
  decision: DecisionKind;
  reason?: string;
  by?: string;
  pr_number?: number;
  /** Cycle-2 C15 (PR #21): persona threading — see PostToPrInput. */
  persona: Persona;
}

export interface DecideOnPrOutcome {
  pr_url?: string;
  claim_id: string;
  decision: DecisionKind;
}

/**
 * Cycle-3 F4 (PR #21): `decideOnPr` is the typed wrapper for the J9
 * reviewer-side block-with-reason loop closure (gh#12 AC-4). The Rust
 * IPC handler is wired and pinned by the contract drift gate, but the
 * UI surface that calls it (a M1-style modal that captures a per-claim
 * decision and reason in reviewer mode, then posts to the PR via the
 * gh CLI) lands in v0.2 / Sprint 7 — see gh#28 for the wiring task.
 * Until then this export is reachable only from unit tests and the
 * future reviewer-flow caller. The decide_on_pr IPC handler stays in
 * production code so the contract stays honest; the UI surface is the
 * sprint-7 deliverable.
 */
export async function decideOnPr(input: DecideOnPrInput): Promise<DecideOnPrOutcome> {
  const args: Record<string, unknown> = {
    packet_id: input.packet_id,
    claim_id: input.claim_id,
    decision: input.decision,
    by: input.by ?? 'you',
    persona: input.persona,
  };
  if (input.reason !== undefined) args.reason = input.reason;
  if (input.pr_number !== undefined) args.pr_number = input.pr_number;
  const r = await invoke<{
    ok: boolean;
    pr_url?: string;
    claim_id: string;
    decision: DecisionKind;
  }>('decide_on_pr', args);
  const out: DecideOnPrOutcome = {
    claim_id: r.claim_id,
    decision: r.decision,
  };
  if (r.pr_url !== undefined) out.pr_url = r.pr_url;
  return out;
}

/**
 * Edge-flow kinds for E1-E7 Banner switching. The label is what the
 * Banner shows; the recovery action is documented in B2 §6.
 *
 *   E1 — corrupt packet           → packet-not-found / validation
 *   E2 — schema-version mismatch  → not posted from M4 (read-only banner
 *                                    handled by the schema-mismatch flow)
 *   E3 — gh auth fail             → gh-not-authenticated (M2 retry)
 *   E4 — gh CLI absent            → gh-cli-error with kind=gh-missing
 *   E5 — gh auth expired (heavy)  → IpcError gh-not-authenticated
 *   E6 — network failure          → gh-cli-error kind=network-or-rate-limit
 *   E7 — concurrent edit / write  → gh-cli-error kind=write or tamper-detected
 */
export type GhEdgeFlowKind =
  | 'corrupt-packet' // E1
  | 'schema-mismatch' // E2 (not gh-post specific; passes through)
  | 'gh-auth-fail' // E3
  | 'gh-missing' // E4
  | 'gh-auth-expired' // E5
  | 'network-failure' // E6
  | 'concurrent-edit' // E7
  | 'pr-not-found' // gh exit 9 — branch has no associated PR
  | 'packet-not-found' // gh exit 2 — local packet YAML missing (cycle-1.5 F4)
  | 'persona-forbidden' // cycle-3 C1: auditor attempted a write IPC
  | 'rate-limit'
  | 'invalid-args'
  | 'unknown';

export interface ClassifiedEdgeFlow {
  kind: GhEdgeFlowKind;
  /** Human-readable Banner title. */
  title: string;
  /** Banner body — keep ≤2 sentences. */
  body: string;
  /** Recovery action label (e.g. "Retry", "Open settings"). */
  recovery: string;
  /** When true, the M2 modal should open in response. */
  triggersAuthModal: boolean;
  /** Original error for debugging. */
  cause: IpcError;
}

/**
 * Translate an IpcError (raised by postToPr / decideOnPr) into a
 * structured edge-flow descriptor the Banner UI consumes. Keeps the
 * E1-E7 switch in ONE place rather than scattered across modals.
 *
 * Returns null when the error is NOT one of the recognised gh-post
 * edge flows — caller falls through to a generic "post failed" Banner.
 */
export function classifyGhError(err: unknown): ClassifiedEdgeFlow | null {
  if (!(err instanceof IpcInvocationError)) return null;
  const ipc = err.inner;
  switch (ipc.kind) {
    case 'gh-not-authenticated':
      return {
        kind: 'gh-auth-fail',
        title: 'GitHub authentication required',
        body: 'Trail uses the gh CLI to post. Run `gh auth login` in your terminal, then retry.',
        recovery: 'Open auth modal',
        triggersAuthModal: true,
        cause: ipc,
      };
    case 'gh-cli-error': {
      const stderr = (ipc as { stderr?: string }).stderr ?? '';
      // The Rust handler prefixes stderr with the kebab-case kind string
      // (see ipc::packet_op_to_ipc_error); parse it back out using the
      // shared contract constant (Sprint 6 F9 fold).
      const m = stderr.match(KEBAB_KIND_PREFIX_PATTERN);
      const kind = m?.[1] ?? 'unknown';
      switch (kind) {
        case 'gh-missing':
          return {
            kind: 'gh-missing',
            title: 'GitHub CLI not installed',
            body: 'Install the gh CLI from https://cli.github.com/ and retry. The Trail desktop uses gh as its sole network egress.',
            recovery: 'Open install instructions',
            triggersAuthModal: false,
            cause: ipc,
          };
        case 'network-or-rate-limit': {
          // Heuristic: rate-limit phrasing in the MESSAGE portion (after
          // the [kebab-kind] prefix the Rust handler synthesises). The
          // prefix itself contains "rate-limit" so we must strip it
          // before keyword-matching to avoid false positives.
          const messageOnly = stderr.replace(KEBAB_KIND_STRIP_PATTERN, '');
          const lower = messageOnly.toLowerCase();
          if (
            lower.includes('rate limit') ||
            lower.includes('rate-limit') ||
            /\b429\b/.test(lower) ||
            /\b403\b/.test(lower)
          ) {
            return {
              kind: 'rate-limit',
              title: 'GitHub API rate-limited',
              body: 'Wait a few minutes and retry, or check `gh api rate_limit` for your remaining budget.',
              recovery: 'Retry',
              triggersAuthModal: false,
              cause: ipc,
            };
          }
          return {
            kind: 'network-failure',
            title: 'Network failure mid-post',
            body: 'Could not reach GitHub. Check connectivity and retry; the packet was not modified.',
            recovery: 'Retry',
            triggersAuthModal: false,
            cause: ipc,
          };
        }
        case 'write':
          return {
            kind: 'concurrent-edit',
            title: 'Local write failed after PR landed',
            body: 'The PR was updated but the local packet record could not be saved. Re-open and re-run `trail packet post` to reconcile.',
            recovery: 'Reload packet',
            triggersAuthModal: false,
            cause: ipc,
          };
        case 'spawn':
          return {
            kind: 'gh-missing',
            title: 'Capture CLI not found',
            body: 'The capture binary could not be spawned. Check Settings → Capture for the correct path.',
            recovery: 'Open settings',
            triggersAuthModal: false,
            cause: ipc,
          };
        case 'timeout':
          return {
            kind: 'network-failure',
            title: 'Post timed out',
            body: 'The post operation did not complete within 5 minutes. Check connectivity and retry.',
            recovery: 'Retry',
            triggersAuthModal: false,
            cause: ipc,
          };
        default:
          return {
            kind: 'unknown',
            title: 'Post failed',
            body: stderr || (ipc as { message?: string }).message || 'Unknown gh CLI error.',
            recovery: 'Retry',
            triggersAuthModal: false,
            cause: ipc,
          };
      }
    }
    // Cycle-1.5 F4 (gh#12 AC-7): pr-not-found and packet-not-found are
    // distinct IPC variants now — DO NOT collapse. The legacy `not-found`
    // case is retained as a fallback for any non-gh-post call site that
    // surfaces a generic missing-row error.
    case 'pr-not-found':
      return {
        kind: 'pr-not-found',
        title: 'Pull request not found',
        body: 'No PR was detected for the current branch, or the specified PR number does not exist in this repository.',
        recovery: 'Specify PR number',
        triggersAuthModal: false,
        cause: ipc,
      };
    case 'packet-not-found':
      return {
        kind: 'packet-not-found',
        title: 'Packet not found on disk',
        body: 'The local packet YAML could not be located. Reload to re-scan, or re-capture the session.',
        recovery: 'Reload',
        triggersAuthModal: false,
        cause: ipc,
      };
    case 'not-found':
      return {
        kind: 'pr-not-found',
        title: 'PR not found',
        body: 'No PR was detected for the current branch, or the specified PR number does not exist in this repository.',
        recovery: 'Specify PR number',
        triggersAuthModal: false,
        cause: ipc,
      };
    case 'yaml-parse-rejected':
      return {
        kind: 'corrupt-packet',
        title: 'Packet failed schema validation',
        body: 'The packet YAML did not validate. Re-capture the session or open the YAML in your editor to inspect.',
        recovery: 'Re-capture',
        triggersAuthModal: false,
        cause: ipc,
      };
    case 'invalid-arguments':
      return {
        kind: 'invalid-args',
        title: 'Invalid arguments',
        body: (ipc as { message?: string }).message ?? 'IPC arguments did not validate.',
        recovery: 'Dismiss',
        triggersAuthModal: false,
        cause: ipc,
      };
    // Cycle-3 C1 (PR #21): the Rust handler emits persona-forbidden when
    // an auditor attempts a write IPC (post / decide / save / override).
    // Without this case, asIpcError validation succeeds (the schema now
    // includes the variant — see contract.ts ipcErrorSchema) but
    // classifyGhError falls through to `null` and the M4 modal shows a
    // generic "post failed" with no actionable recovery. Surface a
    // typed Banner with the auditor-mode-is-read-only copy.
    case 'persona-forbidden':
      return {
        kind: 'persona-forbidden',
        title: 'Auditor mode is read-only',
        body: 'Auditors cannot post packets or PR decisions. Switch to creator or reviewer mode to continue.',
        recovery: 'Switch persona',
        triggersAuthModal: false,
        cause: ipc,
      };
    // Cycle-4.5 W14 (PR #21): when Tauri's command macro fails to
    // deserialize args (e.g., unknown persona string, malformed
    // payload), the framework returns a string `InvokeError` which
    // asIpcError coerces to `{kind:'internal'}`. The previous
    // behaviour fell through to `null`, leaving M4 to surface the raw
    // Error.message text — usually serde diagnostic noise like
    // 'invalid value: string "admin", expected variant of enum
    // Persona at line 1 column 47'. That is a contract bug surface,
    // not a network/auth bug, so the user gets a misleading Retry
    // button. Surface as `unknown` kind with copy that explains the
    // contract-mismatch nature without dumping the raw serde text.
    case 'internal':
      return {
        kind: 'unknown',
        title: 'IPC contract error',
        body: 'The desktop received an IPC payload it did not recognise. Reload the packet; if it persists, file an issue at https://github.com/synaptiai/trail/issues.',
        recovery: 'Reload',
        triggersAuthModal: false,
        cause: ipc,
      };
    default:
      return null;
  }
}
