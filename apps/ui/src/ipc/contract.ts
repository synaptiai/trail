/**
 * Tauri IPC contract — single source of truth for Phase 2.
 *
 * Mirrors B5 §6.1:
 *   12 frontend → backend commands (B5 §6.1 baseline)
 *   + validate_capture_cli_path (Sprint 4 — settings probe)
 *   + decide_on_pr (Sprint 5 / gh#12 — M4 reviewer flow)
 *   6 backend → frontend events
 *
 * Total: 14 IPC commands handled in `apps/ui/src-tauri/src/main.rs`'s
 * `tauri::generate_handler!` registration.
 *
 * NO CODEGEN: this file is the SOLE TypeScript declaration of the IPC
 * surface. Trail does NOT use ts-rs or tauri-specta — adding either
 * would tie the Rust build into the JS toolchain. An earlier docblock
 * in this file referenced a `generated.ts` produced by a non-existent
 * codegen step; that text was wishful and has been corrected.
 *
 * Drift safety net (cycle-2 C9 — PR #21): the safety net is a TWO-WAY
 * pin between Rust and TypeScript:
 *
 *   1. `apps/ui/tests/unit/ipc-contract.test.ts:21-36` asserts
 *      Object.keys(IPC_COMMAND_SCHEMAS) matches a literal
 *      [...]-of-14 list. If a TS handler is added or removed without
 *      updating the literal, the test fails.
 *   2. `apps/ui/src-tauri/src/main.rs::ipc_handler_registration_pinned`
 *      asserts the Rust generate_handler! list against the same literal
 *      14-name vec. If a Rust handler is added without TS counterpart,
 *      `cargo test --locked` fails.
 *
 * Both gates run in CI; either failing blocks merge. This file documents
 * allowed values, error variants, and invariants the cross-language
 * pin cannot express by itself.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid ULID');
// `.datetime({ offset: true })` accepts both `Z` and explicit offset suffixes
// (`+00:00`, `-05:00`, etc.). Without `offset: true` Zod's default REJECTS
// any offset other than `Z`, and `saga-client.nowIso()` emits `+00:00` —
// the schema/capture parity contract mandates the explicit offset form,
// matching apps/capture/src/post/posted-to-pr.ts::nowIso character-for-
// character (PR #7 cycle-4 F25). Without `{ offset: true }`, every
// save_decision / override_risk IPC failed Zod arg validation at the
// React boundary; the catch block in ClaimsTab silently logged the
// failure and the durable persistence marker never set. Surfaced by the
// Sprint 6 perf gate E2E in the gh#2 land cycle (2026-05-18).
export const isoDateTimeSchema = z.string().datetime({ offset: true });
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export type RiskLevel = 'low' | 'med' | 'high' | 'crit';
export const riskLevelSchema = z.enum(['low', 'med', 'high', 'crit']);

export type Persona = 'creator' | 'reviewer' | 'auditor';
export const personaSchema = z.enum(['creator', 'reviewer', 'auditor']);

export type DecisionKind = 'accept' | 'changes' | 'block' | 'reject';
export const decisionKindSchema = z.enum(['accept', 'changes', 'block', 'reject']);

/**
 * Kebab-case discriminant prefix the Rust handler synthesises on stderr
 * for packet-op IPC errors. Shape: `[kebab-kind] <message>` (see
 * `apps/ui/src-tauri/src/ipc.rs::packet_op_to_ipc_error`).
 *
 * Extracted as a shared regex constant per Sprint 6 (gh#13 AC-4 F9
 * fold) so both the matcher and the prefix-stripper draw from the same
 * pattern.
 *
 * Cycle-1.5 F6 (PR #21) docblock precision: there are TWO related but
 * DISTINCT kebab-shape invariants in this codebase, each pinned by its
 * own assertion — they are NOT a shared regex. Naming them explicitly
 * here so future maintainers don't think editing one regex affects the
 * other:
 *
 *   1. **Stderr-prefix shape** `[kebab-kind] message` (this constant) —
 *      pinned by the Rust-side stderr emitter in
 *      `packet_op_to_ipc_error` and consumed by `classifyGhError` in
 *      `gh-post.ts`.
 *   2. **Shell command name shape** `gh-<kebab>` (e.g. `gh-pr-list`) —
 *      pinned by the runtime capability JSON's `shell:allow-execute`
 *      list and asserted by
 *      `apps/ui/src-tauri/src/capabilities_negative.rs::shell_allow_execute_names_are_kebab_prefixed`
 *      (regex `^gh-[a-z][a-z0-9-]*$`).
 *
 * Both invariants happen to use kebab-case, but they enforce DIFFERENT
 * shapes for DIFFERENT surfaces (stderr emit vs subprocess allowlist) —
 * editing one does not propagate to the other.
 *
 * Use with:
 *   - `KEBAB_KIND_PREFIX_PATTERN.exec(stderr)` to capture the kind.
 *   - `stderr.replace(KEBAB_KIND_STRIP_PATTERN, '')` to strip the
 *     prefix (with trailing whitespace) before keyword-sniffing.
 */
export const KEBAB_KIND_PREFIX_PATTERN = /^\[([a-z-]+)\] /;
export const KEBAB_KIND_STRIP_PATTERN = /^\[[a-z-]+\]\s*/;

// ---------------------------------------------------------------------------
// Trail filter (used by query_trail)
// ---------------------------------------------------------------------------

export const trailFilterSchema = z.object({
  risk_levels: z.array(riskLevelSchema).optional(),
  /** Inclusive ISO timestamps. */
  captured_after: isoDateTimeSchema.optional(),
  captured_before: isoDateTimeSchema.optional(),
  /** When true, include only packets with redactions. */
  has_redactions: z.boolean().optional(),
  /** Free-text search on packet name / claim text (server-side). */
  search: z.string().min(1).max(120).optional(),
});

export type TrailFilter = z.infer<typeof trailFilterSchema>;

// ---------------------------------------------------------------------------
// Settings shape (validated on read AND write per B5 §6.6)
// ---------------------------------------------------------------------------

/**
 * Pinned session — the persistent backing for the "Your recent sessions"
 * pin (B4 §3.4 / gh#8 criterion 2). Sprint 2 addition.
 */
export const pinnedSessionSchema = z.object({
  session_id: z.string().min(1),
  pinned_at: z.string().min(1),
});
export type PinnedSession = z.infer<typeof pinnedSessionSchema>;

export const settingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).default('system'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  /** When true, J12 banner is suppressed. Off by default. */
  disable_tamper_warnings: z.boolean().default(false),
  /** Heavy-redaction threshold for E5. Default 15 per B3 OQ-B3-6. */
  heavy_redaction_threshold: z.number().int().min(1).max(500).default(15),
  /**
   * Path to the capture CLI binary. Default is `trail` — the binary name
   * installed by `npm install -g @synapti/trail-capture` (per the package's
   * `bin` field). v0.1.0–v0.1.2 defaulted to the npm package name, which
   * spawn() then tried to exec literally; `read_settings` in the Rust layer
   * migrates that wrong value forward to `trail`.
   */
  capture_cli_path: z.string().default('trail'),
  /**
   * "Your recent sessions" pin list (Sprint 2; gh#8 criterion 2). Up to 5
   * entries, LRU-ordered (most-recent first). Defaults to empty.
   */
  pinned_sessions: z.array(pinnedSessionSchema).max(5).default([]),
  /** HMAC of the settings file (per B5 §6.6); ignored on write. */
  hmac: z.string().optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

// ---------------------------------------------------------------------------
// IPC error variants
// ---------------------------------------------------------------------------

/**
 * Mismatch type for tamper-detected errors and packet-changed-externally
 * events. Closed enum (per PR #6 cycle-1 review F17): the previous
 * `mismatch_type: string` open type allowed the Rust + TS to drift; this
 * union now matches the event payload declared below at line ~190.
 */
export type MismatchType = 'hash-mismatch' | 'missing' | 'parse-error';

export type IpcError =
  | { kind: 'not-found'; message: string }
  // Cycle-1.5 F4 (gh#12 AC-7): split previous `not-found` collapse for
  // gh CLI exit signals. `pr-not-found` is gh exit 9 (branch has no
  // associated PR / specified PR doesn't exist); `packet-not-found` is
  // gh exit 2 (local packet YAML missing on disk). The generic
  // `not-found` remains for libSQL row-missing surfaces (unrelated to gh).
  | { kind: 'pr-not-found'; message: string }
  | { kind: 'packet-not-found'; message: string }
  | { kind: 'permission-denied'; message: string }
  | { kind: 'yaml-parse-rejected'; reason: 'size-cap' | 'timeout' | 'anchor-count' | 'syntax'; message: string }
  | { kind: 'tamper-detected'; packet_id: string; mismatch_type: MismatchType; message: string }
  | { kind: 'gh-cli-error'; stderr: string; exit_code: number; message: string }
  | { kind: 'gh-not-authenticated'; message: string }
  | { kind: 'invalid-arguments'; field: string; message: string }
  /**
   * Cycle-3 C1 (PR #21): the Rust handler emits this variant when the
   * auditor persona attempts a write IPC (post_to_pr / decide_on_pr /
   * save_decision / override_risk). The frontend Banner / M4 modal can
   * switch on `kind=persona-forbidden` to surface "Auditor mode is
   * read-only" copy. Defence-in-depth alongside the React UI gating;
   * see PostToPrArgs / DecideOnPrArgs / SaveDecisionArgs / OverrideRiskArgs
   * for the wire-side contract.
   */
  | { kind: 'persona-forbidden'; persona: string; command: string }
  | { kind: 'internal'; message: string };

/**
 * Runtime zod schema mirroring the IpcError union (cycle-2 N27 fix).
 * Used by the IPC client's error path to validate that a Rust handler's
 * error payload matches the closed enum at runtime, not just at compile
 * time. A backend that mistakenly serializes an unknown `kind` is now
 * rejected with `IpcError.internal` rather than silently consumed.
 */
export const ipcErrorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-found'), message: z.string() }),
  // Cycle-1.5 F4: see IpcError type comment above.
  z.object({ kind: z.literal('pr-not-found'), message: z.string() }),
  z.object({ kind: z.literal('packet-not-found'), message: z.string() }),
  z.object({ kind: z.literal('permission-denied'), message: z.string() }),
  z.object({
    kind: z.literal('yaml-parse-rejected'),
    reason: z.enum(['size-cap', 'timeout', 'anchor-count', 'syntax']),
    message: z.string(),
  }),
  z.object({
    kind: z.literal('tamper-detected'),
    packet_id: z.string(),
    mismatch_type: z.enum(['hash-mismatch', 'missing', 'parse-error']),
    message: z.string(),
  }),
  z.object({
    kind: z.literal('gh-cli-error'),
    stderr: z.string(),
    exit_code: z.number().int(),
    message: z.string(),
  }),
  z.object({ kind: z.literal('gh-not-authenticated'), message: z.string() }),
  z.object({
    kind: z.literal('invalid-arguments'),
    field: z.string(),
    message: z.string(),
  }),
  // Cycle-3 C1 (PR #21): mirrors the Rust IpcError::PersonaForbidden
  // serde discriminator (`#[serde(tag = "kind", rename_all = "kebab-case")]`
  // emits `kind: "persona-forbidden"`). Without this entry the runtime
  // schema-validation in `client.ts::asIpcError` coerces a legitimate
  // persona rejection to `IpcError.internal` and the Banner shows a
  // generic error instead of the typed "Auditor mode is read-only" copy.
  z.object({
    kind: z.literal('persona-forbidden'),
    persona: z.string(),
    command: z.string(),
  }),
  z.object({ kind: z.literal('internal'), message: z.string() }),
]);

// ---------------------------------------------------------------------------
// Audit log event types (restricted enum per B5 §6.1)
// ---------------------------------------------------------------------------

export const uiAuditEventTypeSchema = z.enum([
  'tamper_dismissed',
  'tamper_re_verified',
  'settings_changed_via_ui',
]);

export type UiAuditEventType = z.infer<typeof uiAuditEventTypeSchema>;

/**
 * Backend-private event types — never reachable from the frontend. Documented
 * here for completeness. Backend logger writes them directly; no IPC path.
 */
export type BackendAuditEventType =
  | 'tamper_detected'
  | 'settings_validation_failed'
  | 'saga_recovered'
  | 'yaml_parse_rejected'
  /**
   * Cycle-1.5 F11: emitted when SagaDriver::run_decision_saga aborts due
   * to ClockError (system clock returns a pre-epoch timestamp). Best-
   * effort: chrono::Utc::now() also depends on the clock, so the audit
   * write may itself fail; the tracing log catches the event in that
   * case. Without this audit row a user who closes Trail before
   * retrying would leave no trace correlating "user closed Trail" with
   * "decision never landed".
   */
  | 'saga_aborted_clock_anomaly';

// ---------------------------------------------------------------------------
// Command argument + result schemas
// ---------------------------------------------------------------------------

export const ReadPacketArgs = z.object({ packet_id: ulidSchema });
export const SaveDecisionArgs = z.object({
  packet_id: ulidSchema,
  claim_id: z.string().min(1),
  decision: decisionKindSchema,
  reason: z.string().max(2_000).optional(),
  by: z.string().min(1),
  at: isoDateTimeSchema,
  /**
   * Cycle-3 C4 (PR #21): persona threading on save_decision. The auditor
   * cannot save decisions per B5 §6.5; the UI surface is gated already
   * but the IPC is now a second layer. Defaults intentionally absent —
   * callers MUST pass the active persona (sourced from
   * `App.tsx::readPersonaFromUrl` so client + server enforcement match).
   */
  persona: personaSchema,
});
export const OverrideRiskArgs = z.object({
  packet_id: ulidSchema,
  claim_id: z.string().min(1),
  layer: z.enum(['creator', 'reviewer']),
  new_level: riskLevelSchema,
  reason: z.string().min(3).max(2_000),
  by: z.string().min(1),
  at: isoDateTimeSchema,
  /** Cycle-3 C4 (PR #21): persona threading — see SaveDecisionArgs note. */
  persona: personaSchema,
});
export const PostToPrArgs = z.object({
  packet_id: ulidSchema,
  /** Validated as int32 > 0 in the Rust handler (B5 §6.1 hardening). */
  pr_number: z.number().int().min(1).max(2_147_483_647).optional(),
  /**
   * Cycle-2 C15 (PR #21): persona threading. The React UI gates the M4
   * post button at the App-level by persona (auditor cannot post per
   * B5 §6.5), but the Rust handler had no persona-aware guard — a
   * compromised renderer or a developer-tools `invoke('post_to_pr', ...)`
   * call from auditor mode would bypass the UI gate. Persona is now
   * threaded as an IPC argument and the Rust handler rejects auditor
   * with the typed `IpcError::PersonaForbidden` variant. The persona
   * value is sourced from `App.tsx::readPersonaFromUrl` (the same
   * source the UI gating uses) so client + server enforcement match.
   */
  persona: personaSchema,
});

/**
 * `decide_on_pr` (Sprint 5 — gh#12 AC-4): J9 reviewer-side block-
 * with-reason loop closure. Wires the UI to Phase 3b's `trail packet
 * decide` so a per-claim decision (accept|changes|block|reject) lands
 * a PR comment + body refresh in one IPC.
 *
 * Reason is required for changes|block|reject (J9 step 2); the Rust
 * handler defends-in-depth.
 *
 * Cycle-2 C14 (PR #21): Zod tightened to mirror the Rust
 * `is_argv_safe` predicate at apps/ui/src-tauri/src/ipc.rs:773-778:
 *   - no leading `-` (would shadow as a flag in argv)
 *   - no control characters (mirrors Rust `c.is_control()`)
 *   - identifier-like fields capped at 256 chars
 *
 * Cycle-3 C5 (PR #21): the 500-char `reason` cap is the product-UX
 * limit (the J9 reason field shouldn't exceed a paragraph). The Rust
 * `ARGV_CAP_REASON` of 2000 is the security ceiling for argv-injection
 * protection — a separate concern. Cycle-2 had aligned Zod up to 2000
 * which weakened the user-facing limit; cycle-3 reverts to 500 to
 * match the Rust `decide_on_pr` validator at ipc.rs:600-606. The two
 * caps compose (smaller wins): Zod 500 < Rust 2000 < OS argv envelope.
 *
 * Cycle-3 C6 (PR #21): control-character refine added to mirror
 * `is_argv_safe`'s `c.is_control()` semantics. Without it, a stderr-
 * carrying NUL or embedded `\n` could slip past Zod and only fail at
 * the Rust boundary — losing the typed-validation-at-React-boundary
 * benefit C14 set up.
 *
 * Cycle-3 SEC-5 (PR #21): the leading-dash check is ASCII-only — it
 * compares against U+002D (HYPHEN-MINUS, '-'). Unicode lookalikes
 * (U+2010 HYPHEN, U+2212 MINUS SIGN, U+2013 EN DASH, etc.) are NOT
 * checked because commander.js (Phase 3b's argv parser) does NOT
 * treat them as flag prefixes — only literal '-' / '--' starts a
 * flag. A claim_id beginning with '‐foo' is passed through as a
 * positional argv value verbatim. Future Phase 3b refactors that
 * widen flag detection (e.g., adopting yargs which has Unicode
 * tolerance) would require adding a startsWith check for the
 * lookalikes here.
 *
 * The previous schema relied solely on `min(1)` + Rust defence-in-depth.
 * Tightening at the Zod boundary turns "command rejected by Rust" into
 * "command rejected at the React boundary with a typed validation
 * error" — better UX, fewer surprises in the saga.
 */
// Cycle-2 C14 (PR #21): shared bounds for identifier-like fields,
// mirroring apps/ui/src-tauri/src/ipc.rs::ARGV_CAP_IDENT (256).
// Cycle-3 C5 (PR #21): reason cap is the product-UX 500-char limit
// (matches Rust decide_on_pr validator); the larger ARGV_CAP_REASON
// (2000) on the Rust side is the security ceiling, not the UX limit.
const idLikeMaxLen = 256;
const reasonMaxLen = 500;

// Cycle-3 C6 (PR #21): control-char predicate mirroring Rust's
// `c.is_control()` (Unicode control class — C0 0x00-0x1F + DEL 0x7F).
// Used by the argv-safe refines on claim_id, by, reason. The control
// chars in the regex are deliberate; the eslint disable below is the
// intent-preserving annotation per ESLint guidance for security-
// scanning regexes.
// eslint-disable-next-line no-control-regex
const HAS_CONTROL_CHAR = /[\x00-\x1F\x7F]/;

export const DecideOnPrArgs = z.object({
  packet_id: ulidSchema,
  claim_id: z
    .string()
    .min(1)
    .max(idLikeMaxLen)
    .refine((v) => !v.startsWith('-'), {
      message: 'claim_id must not start with `-` (argv-flag injection guard)',
    })
    .refine((v) => !HAS_CONTROL_CHAR.test(v), {
      message: 'claim_id must not contain control characters (argv-injection guard)',
    }),
  decision: decisionKindSchema,
  reason: z
    .string()
    .max(reasonMaxLen)
    .refine((v) => !v.startsWith('-'), {
      message: 'reason must not start with `-` (argv-flag injection guard)',
    })
    .refine((v) => !HAS_CONTROL_CHAR.test(v), {
      message: 'reason must not contain control characters (argv-injection guard)',
    })
    .optional(),
  by: z
    .string()
    .min(1)
    .max(idLikeMaxLen)
    .refine((v) => !v.startsWith('-'), {
      message: 'by must not start with `-` (argv-flag injection guard)',
    })
    .refine((v) => !HAS_CONTROL_CHAR.test(v), {
      message: 'by must not contain control characters (argv-injection guard)',
    }),
  pr_number: z.number().int().min(1).max(2_147_483_647).optional(),
  /**
   * Cycle-2 C15 (PR #21): persona threading — see PostToPrArgs note.
   * Auditor cannot decide on a PR per B5 §6.5; the Rust handler
   * rejects with `IpcError::PersonaForbidden`.
   */
  persona: personaSchema,
});
export const QueryTrailArgs = z.object({
  filter: trailFilterSchema,
  limit: z.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
});
export const QueryRecentSessionsArgs = z.object({
  /** Backend caps at 50. */
  limit: z.number().int().min(1).max(50).default(5),
});
export const PreviewRedactedArgs = z.object({
  packet_id: ulidSchema,
  redaction_id: z.string().min(1),
});
export const AuditLogAppendArgs = z.object({
  event_type: uiAuditEventTypeSchema,
  packet_id: ulidSchema.optional(),
  details: z.record(z.string(), z.unknown()),
  /**
   * Cycle-4.5 W2 (PR #21): persona threading. The Rust handler rejects
   * auditor with `IpcError::PersonaForbidden`; without this field the
   * auditor could append arbitrary rows to the audit chain via DevTools.
   * The persona is sourced from `App.tsx::readPersonaFromUrl` so client
   * + server enforcement match.
   */
  persona: personaSchema,
});

/**
 * `validate_capture_cli_path` (gh#11 criterion 11 — Sprint 4 cycle-1.5
 * F3 fix). The M6 Capture panel calls this to probe the user-entered
 * binary path before persisting it; the Rust handler invokes
 * `cli_bridge::validate_capture_cli_path` which spawns the binary with a
 * `--version` argv and a 30s timeout.
 *
 * Validation here mirrors the Rust handler's hardening: non-empty, soft
 * length cap. The Rust handler re-validates (defense in depth).
 *
 * gh#17 AC#3: the Rust handler routes through
 * `probe_capture_version_with_augmented_path` so Verify uses the same
 * PATH-augmented spawn as Detect. A path that Verifies must also Detect
 * and vice versa.
 */
export const ValidateCaptureCliPathArgs = z.object({
  path: z.string().min(1).max(4096),
});

/**
 * `detect_capture_cli` (gh#17). No arguments — the Rust handler invokes
 * `cli_bridge::detect_capture_cli` which probes for the `trail` binary
 * via login-shell, candidate paths, and marker file in order. The
 * frontend calls this from the M6 Settings → Capture "Detect" button
 * and from the FirstRun screen on first launch.
 */
export const DetectCaptureCliArgs = z.object({});

// ---------------------------------------------------------------------------
// Command surface — serializable signature index
// ---------------------------------------------------------------------------

export const IPC_COMMAND_SCHEMAS = {
  read_packet: ReadPacketArgs,
  save_decision: SaveDecisionArgs,
  override_risk: OverrideRiskArgs,
  post_to_pr: PostToPrArgs,
  decide_on_pr: DecideOnPrArgs,
  query_trail: QueryTrailArgs,
  query_recent_sessions: QueryRecentSessionsArgs,
  read_settings: z.object({}),
  write_settings: z.object({
    partial: settingsSchema.partial(),
    /**
     * Cycle-4.5 W1 (PR #21): persona threading on `write_settings`. The
     * Rust handler rejects auditor with `IpcError::PersonaForbidden` —
     * without this field, an auditor could call `write_settings` from
     * DevTools and silence J12 tamper warnings. The UI surface is gated
     * (settings modal only opens for creator/reviewer in practice) but
     * the IPC layer must enforce the same boundary as defence-in-depth.
     * The persona is sourced from `App.tsx::readPersonaFromUrl` so client
     * + server enforcement match.
     */
    persona: personaSchema,
  }),
  preview_redacted: PreviewRedactedArgs,
  audit_log_append: AuditLogAppendArgs,
  subscribe_fs_watch: z.object({}),
  subscribe_settings_change: z.object({}),
  validate_capture_cli_path: ValidateCaptureCliPathArgs,
  detect_capture_cli: DetectCaptureCliArgs,
  list_claude_sessions: z.object({}),
  spawn_packet_generate: z.object({
    session_id: z.string().min(1).max(64),
    // SEC-1: persona threading required so the Rust handler can
    // reject_auditor at the IPC boundary. Mirrors save_decision /
    // override_risk / post_to_pr / decide_on_pr / write_settings.
    persona: personaSchema,
  }),
  cancel_packet_generate: z.object({
    spawn_id: z.string().min(1),
    persona: personaSchema,
  }),
} as const;

export type IpcCommandName = keyof typeof IPC_COMMAND_SCHEMAS;

// ---------------------------------------------------------------------------
// Response schemas (per PR #6 cycle-1 review F19 — defense-in-depth)
// ---------------------------------------------------------------------------

/**
 * Optional response schemas the IPC client validates after invoke. Commands
 * with declared response shapes get post-invoke validation for free; if the
 * Rust handler accidentally returns a malformed payload, the frontend
 * surfaces an `IpcError.internal` rather than silently consuming the wrong
 * type. Commands without a response schema (e.g., `subscribe_*` whose
 * payload is just an OkResponse) are allowed to skip the check.
 */
export const okResponseSchema = z.object({ ok: z.literal(true) });

/**
 * `read_packet` response — Sprint 3a (gh#9 criterion 7).
 *
 * The Rust handler queries libSQL `packets.yaml_path` for the given
 * packet_id, reads the YAML text from disk, and returns it verbatim. The
 * TS-side packet-loader then runs js-yaml + Ajv validation. The schema is
 * intentionally permissive here on `yaml_path` (no path validation beyond
 * non-empty); the Rust handler is the canonical authority on path safety
 * (workspace-relative + no-traversal checks).
 */
export const packetResponseSchema = z.object({
  packet_id: ulidSchema,
  schema_version: z.string(),
  yaml_text: z.string().min(1),
  yaml_path: z.string().min(1),
});

/**
 * Anchored GitHub PR URL pattern (v0.1.1 B1: XSS hardening).
 *
 * Mirrors `github_pr_url_regex()` in `apps/ui/src-tauri/src/cli_bridge.rs`.
 * The Rust side parses `pr_url` from a subprocess's stderr; if the binary
 * is compromised or PATH-hijacked, it could emit `javascript:fetch(...)`
 * and the React toast at `PacketView.tsx` would render it as a clickable
 * `<a href>` (the CSP at `tauri.conf.json` does NOT block `javascript:`
 * hrefs in same-origin webviews). Both the Rust parser and this Zod
 * schema must agree; one without the other is incomplete defense.
 */
const githubPrUrlRegex =
  /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*(?:\/|\?[^\s]*)?$/;

/**
 * `post_to_pr` response (Sprint 5 — gh#12 AC-3, AC-5): the Rust
 * handler returns the parsed PR URL, body_hash prefix (first 16 hex
 * chars of the sha256 over posted markdown — sufficient for tamper
 * detection per AC-5 + the M4 confirmation toast), and the destination
 * "owner/name#PR" string (already shown pre-post in the M4 modal per
 * B6 P1 hardening; surfaced again post-success as confirmation).
 */
/**
 * v0.1.3 bug-1 hardening: every optional response field below is
 * `.nullable().optional()`. The Rust struct (`ipc.rs::PostToPrResponse`)
 * uses `#[serde(skip_serializing_if = "Option::is_none")]` so the
 * canonical wire shape for `None` is "key absent" (which `.optional()`
 * accepts). `.nullable()` is the belt-and-braces: a future regression
 * that drops the `skip_serializing_if` would still survive Zod parse
 * instead of red-bannering the renderer.
 */
export const postToPrResponseSchema = z.object({
  ok: z.boolean(),
  pr_url: z.string().regex(githubPrUrlRegex).nullable().optional(),
  destination: z.string().nullable().optional(),
  body_hash_prefix: z
    .string()
    .regex(/^[0-9a-f]{1,64}$/)
    .nullable()
    .optional(),
});

/**
 * `decide_on_pr` response (Sprint 5 — gh#12 AC-4): J9 loop-closure
 * outcome. Carries the PR URL + claim + decision so the UI can show
 * "Posted decision: <claim> blocked → <pr_url>" inline.
 */
export const decideOnPrResponseSchema = z.object({
  ok: z.boolean(),
  // v0.1.3 bug-1: see postToPrResponseSchema rationale.
  pr_url: z.string().regex(githubPrUrlRegex).nullable().optional(),
  claim_id: z.string().min(1),
  decision: decisionKindSchema,
});

/**
 * Sidebar row schema (Sprint 2 — tightened from the placeholder z.unknown).
 * Shape MUST match the Rust `SidebarRow` struct in
 * `apps/ui/src-tauri/src/db.rs`. The N28 lesson applies: a column rename in
 * either layer must surface in this schema's failure to validate, not in
 * silent UI corruption.
 */
export const sidebarRowSchema = z.object({
  packet_id: z.string(),
  session_id: z.string(),
  display_name: z.string(),
  captured_at: z.string(),
  low_count: z.number().int().nonnegative(),
  med_count: z.number().int().nonnegative(),
  high_count: z.number().int().nonnegative(),
  crit_count: z.number().int().nonnegative(),
  redaction_count: z.number().int().nonnegative(),
  posted_to_pr_count: z.number().int().nonnegative(),
});
export type SidebarRow = z.infer<typeof sidebarRowSchema>;

export const queryTrailResponseSchema = z.object({
  packets: z.array(sidebarRowSchema),
  // v0.1.3 bug-1 ship-blocker: this is the field that bricked the
  // desktop sidebar in v0.1.0–v0.1.2. The Rust handler returns
  // `Option<String>` and serde was serialising `None` as JSON `null`.
  // Plain `.optional()` accepts `undefined` (missing key) but NOT
  // `null`, so every fresh install hit
  // "Expected string, received null at next_cursor" on first paint.
  // Rust side now uses `skip_serializing_if = "Option::is_none"`
  // (omits the key), AND we accept `null` here as belt-and-braces.
  next_cursor: z.string().nullable().optional(),
});

export const previewRedactedResponseSchema = z.object({
  // v0.1.3 bug-1: same nullable-optional pattern as next_cursor.
  original: z.string().nullable().optional(),
});

/**
 * `validate_capture_cli_path` response — Sprint 4 cycle-1.5 F3 fix. The
 * Rust handler returns a discriminated union: success carries the
 * captured `--version` string; failure carries a stable kebab-case
 * `kind` matching `cli_bridge::BridgeError::kind()` plus a human
 * message. Reserving the IPC error channel for true system errors keeps
 * a "binary not found" surface as a routine settings-form result rather
 * than a toast-level failure.
 */
export const validateCaptureCliPathResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal('true'), version: z.string().min(1) }),
  z.object({
    ok: z.literal('false'),
    kind: z.enum(['spawn', 'timeout', 'non-zero-exit', 'invalid-stdout']),
    message: z.string(),
  }),
]);

export type ValidateCaptureCliPathResponse = z.infer<
  typeof validateCaptureCliPathResponseSchema
>;

/**
 * `detect_capture_cli` response — gh#17. Discriminated on `kind`:
 *
 *  - `detected` carries the resolved absolute path, the parsed `--version`
 *    string, and which probe strategy found it. The UI's Settings →
 *    Capture pane auto-fills the path on this branch; FirstRun emits a
 *    success toast.
 *
 *  - `failed` carries a classified `failure_kind` discriminant the UI's
 *    failure card switches on plus user-actionable copy (`message`,
 *    `suggested_fix`). Reserving the IPC error channel for true system
 *    errors keeps "no trail found" a routine result, not a toast-level
 *    failure.
 */
export const detectCaptureCliResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('detected'),
    path: z.string().min(1),
    version: z.string().min(1),
    source: z.enum(['login-shell', 'candidate', 'marker-file']),
  }),
  z.object({
    kind: z.literal('failed'),
    failure_kind: z.enum([
      'binary-not-installed',
      'node-missing',
      'probe-timed-out',
      'probe-error',
    ]),
    message: z.string(),
    suggested_fix: z.string(),
  }),
]);

export type DetectCaptureCliResponse = z.infer<typeof detectCaptureCliResponseSchema>;

/**
 * gh#18 AC#3 — list_claude_sessions response.
 *
 * Discriminated `kind` union: `ok` carries the session list, `failed` carries
 * a classified failure surface so the Capture surface can render an
 * explanation card instead of a toast.
 */
export const claudeSessionSchema = z.object({
  session_id: z.string().min(1),
  project_path: z.string().min(1),
  started_at: z.string().nullable(),
  message_count: z.number().int().nonnegative(),
  packet_id: z.string().nullable(),
});

export const listClaudeSessionsResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    sessions: z.array(claudeSessionSchema),
  }),
  z.object({
    kind: z.literal('failed'),
    failure_kind: z.enum([
      'projects-dir-not-found',
      'projects-dir-unreadable',
      'enumeration-error',
    ]),
    message: z.string(),
  }),
]);

export type ClaudeSession = z.infer<typeof claudeSessionSchema>;
export type ListClaudeSessionsResponse = z.infer<typeof listClaudeSessionsResponseSchema>;

/**
 * gh#18 AC#5/6 — spawn_packet_generate response.
 *
 * `spawned` carries an opaque spawn_id used both to correlate progress
 * events and to cancel the spawn via `cancel_packet_generate`. The
 * `failed` branch carries a classifier so the row can render the right
 * affordance (CLI not found → suggest Re-detect; spawn-error → "try
 * again"; invalid-session-id → "this should not happen, please file").
 */
export const spawnPacketGenerateResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('spawned'),
    spawn_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('failed'),
    failure_kind: z.enum([
      'cli-not-found',
      'spawn-error',
      'invalid-session-id',
    ]),
    message: z.string(),
  }),
]);

/**
 * gh#18 AC#5/6 — cancel_packet_generate response. Always succeeds at the
 * wire level; the `cancelled` field reports whether a matching spawn was
 * actually found in the registry.
 */
export const cancelPacketGenerateResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    cancelled: z.boolean(),
  }),
]);

export type SpawnPacketGenerateResponse = z.infer<typeof spawnPacketGenerateResponseSchema>;
export type CancelPacketGenerateResponse = z.infer<typeof cancelPacketGenerateResponseSchema>;

/**
 * Map command-name → response schema (zod). Commands not in the map skip
 * post-invoke validation; this is honest about the Sprint 1 state where
 * many handlers return placeholder errors.
 */
export const IPC_RESPONSE_SCHEMAS: Partial<Record<IpcCommandName, z.ZodTypeAny>> = {
  read_packet: packetResponseSchema,
  save_decision: okResponseSchema,
  override_risk: okResponseSchema,
  post_to_pr: postToPrResponseSchema,
  decide_on_pr: decideOnPrResponseSchema,
  query_trail: queryTrailResponseSchema,
  // Sprint 2 (gh#8): tightened to z.array(recentSessionSchema). The Sprint-1
  // placeholder `z.array(z.unknown())` was a documented honest gap; the
  // Rust handler now returns RecentSession rows so we validate the shape.
  query_recent_sessions: z.array(
    z.object({
      session_id: z.string().min(1),
      latest_packet_id: z.string().min(1),
      packet_count: z.number().int().positive(),
      latest_captured_at: z.string().min(1),
    }),
  ),
  read_settings: settingsSchema,
  write_settings: okResponseSchema,
  preview_redacted: previewRedactedResponseSchema,
  audit_log_append: okResponseSchema,
  subscribe_fs_watch: okResponseSchema,
  subscribe_settings_change: okResponseSchema,
  validate_capture_cli_path: validateCaptureCliPathResponseSchema,
  detect_capture_cli: detectCaptureCliResponseSchema,
  list_claude_sessions: listClaudeSessionsResponseSchema,
  spawn_packet_generate: spawnPacketGenerateResponseSchema,
  cancel_packet_generate: cancelPacketGenerateResponseSchema,
};

// ---------------------------------------------------------------------------
// Event surface — backend → frontend
// ---------------------------------------------------------------------------

export type IpcEventName =
  | 'packet-changed'
  | 'packet-changed-externally'
  | 'trail-needs-refresh'
  | 'decision-saved'
  | 'decision-failed'
  | 'post-progress'
  /**
   * Cycle-1.5 F12 fix: emitted when the notify backend reports an
   * error (e.g., inotify_add_watch ENOSPC, fsevents drop). Cycle-1
   * silently logged at warn level, leaving AC-3 / AC-4 unenforceable
   * while the desktop continued to run. The UI listens for this and
   * surfaces a banner so the operator knows the watcher is offline.
   */
  | 'watcher-degraded'
  /**
   * gh#18 A2 — emitted by the `~/.claude/projects/` watcher when any
   * debounced filesystem event fires. The Rust side coalesces the
   * batch into a single empty-payload event; the React layer refetches
   * `list_claude_sessions` on each.
   */
  | 'claude-session-changed'
  /**
   * gh#18 A3 — per-line streaming progress for `trail packet generate`
   * subprocess. Emitted by `spawn::run_packet_generate`. Terminal
   * variants `done` / `error` are followed by no further events for that
   * spawn_id.
   */
  | 'packet-generate-progress';

export type IpcEvent =
  | { name: 'packet-changed'; payload: { packet_id: string } }
  | {
      name: 'packet-changed-externally';
      /**
       * `packet_id` is nullable on the wire as of v0.1.1 B6: when the
       * watcher receives a non-NotFound read error (EACCES, EIO) or a
       * parse-error / missing event for a path libSQL has not yet
       * ingested (fresh capture not yet INSERTed), the Rust side reverse-
       * looks-up via `db::select_packet_id_by_path` and emits `null` on
       * failure. Frontend MUST tolerate `null` and route those events to
       * a global "watcher saw an unparseable file" banner (not the
       * per-packet J12 filter, which keys on `packet_id === packetId`
       * and correctly drops null/empty mismatches).
       */
      payload: {
        packet_id: string | null;
        mismatch_type: 'hash-mismatch' | 'missing' | 'parse-error';
        message?: string;
      };
    }
  | { name: 'trail-needs-refresh'; payload: Record<string, never> }
  | { name: 'decision-saved'; payload: { packet_id: string; claim_id: string } }
  | { name: 'decision-failed'; payload: { packet_id: string; claim_id: string; error: IpcError } }
  | {
      name: 'post-progress';
      payload: { stage: 'auth-check' | 'destination-confirm' | 'posting' | 'done' | 'failed'; packet_id: string };
    }
  | { name: 'watcher-degraded'; payload: { messages: string[] } }
  | { name: 'claude-session-changed'; payload: Record<string, never> }
  | {
      name: 'packet-generate-progress';
      payload: {
        spawn_id: string;
        session_id: string;
        kind: 'stderr' | 'done' | 'error';
        chunk?: string;
        exit_code?: number;
        error_detail?: string;
      };
    };

/** gh#18 A2 — payload shape for `claude-session-changed`. Empty by design;
 * the React layer refetches `list_claude_sessions` on each event. */
export type ClaudeSessionChangedPayload = Record<string, never>;

/** gh#18 A3 — payload shape for `packet-generate-progress`. */
export interface PacketGenerateProgressPayload {
  spawn_id: string;
  session_id: string;
  kind: 'stderr' | 'done' | 'error';
  chunk?: string;
  exit_code?: number;
  error_detail?: string;
}
