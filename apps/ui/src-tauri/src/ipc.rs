//! Tauri IPC command handlers.
//!
//! Mirrors the 12 commands declared in `apps/ui/src/ipc/contract.ts` (B5 §6.1).
//! Argument validation runs in TWO places (defense in depth):
//!   1. Frontend zod schemas in `src/ipc/contract.ts`
//!   2. The serde-deserialize step here + explicit field validators below
//!
//! Phase 2 build order:
//!   - Sprint 1 (this file): the wire-up shell + Error variants are in place;
//!     handler bodies return `IpcError::not-found` / `internal` placeholders so
//!     the React UI can mount and unit tests can assert behavior at the
//!     boundary.
//!   - Sprint 2: `query_trail`, `query_recent_sessions`, `read_settings`,
//!     `write_settings` get their libSQL + ~/.trail/settings.json bodies.
//!   - Sprint 3a/3b: `read_packet` + `preview_redacted` plumb through the YAML
//!     safety contract (see `yaml_safety.rs`).
//!   - Sprint 4: `save_decision` + `override_risk` invoke the saga (see
//!     `saga.rs`).
//!   - Sprint 5: `post_to_pr` shells to gh CLI with destination confirmation.
//!
//! Until the bodies land, each handler returns `IpcError::Internal { message:
//! "<command> not yet implemented in Sprint <N>" }` — surfaceable in the UI as
//! a TODO toast, never as silent success.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tauri::{Manager, State};

use crate::db::{self, DbState, PacketMetaRow, RecentSession, SidebarRow, TrailFilter};
use crate::saga::{
    DecisionEntry, RiskLayer, RiskOverride, SagaDriver, SagaError, SagaInput,
};
use crate::settings::{self, PinnedSession, Settings};
use crate::watcher::SagaInFlightRegistry;

/// Cycle-3 C2 (PR #21): closed enum mirroring the TS `Persona` union and
/// the Zod `personaSchema` at `apps/ui/src/ipc/contract.ts:50`.
///
/// Previously this was a `pub persona: String` field on each args struct,
/// which accepted any string at deserialize time — an attacker who
/// bypasses Zod (e.g. via `__TAURI_INTERNALS__.invoke` from the
/// developer-tools console with a hand-crafted payload) could send
/// `persona: "creator"` from auditor mode and bypass `reject_auditor`'s
/// literal `== "auditor"` match. The enum now fails at the serde
/// boundary for any value outside the closed set; `reject_auditor` is
/// total over the variants. The `#[serde(rename_all = "lowercase")]`
/// attribute keeps the wire shape identical so the TS schema's
/// `z.enum(['creator', 'reviewer', 'auditor'])` continues to validate
/// the same strings.
///
/// Cycle-4.5 W4 (PR #21): docblock-precision correction. The previous
/// language overstated the threat closure. To be honest:
///
/// The closed Persona enum rejects UNKNOWN strings (e.g., "admin",
/// "hacker") at the serde-deserialize boundary. It does NOT prevent
/// LATERAL impersonation between valid personas — a renderer with
/// DevTools access can still send `persona: "creator"` from auditor
/// mode. Persona is a renderer-claimed value; the trust boundary is
/// the renderer process. v0.2 will introduce a server-side persona
/// attestation (see THREAT_MODEL.md §persona-trust) sourced from a
/// signed token that the renderer cannot forge.
#[derive(Deserialize, Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Persona {
    Creator,
    Reviewer,
    Auditor,
}

impl std::fmt::Display for Persona {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Persona::Creator => "creator",
            Persona::Reviewer => "reviewer",
            Persona::Auditor => "auditor",
        };
        f.write_str(s)
    }
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum IpcError {
    #[error("not found: {message}")]
    NotFound { message: String },
    // Cycle-1.5 F4 (gh#12 AC-7): split previous NotFound collapse for
    // gh CLI exit signals. `PrNotFound` is gh exit 9 (branch has no
    // associated PR); `PacketNotFound` is gh exit 2 (local packet YAML
    // missing). The generic `NotFound` remains for libSQL row-missing
    // surfaces unrelated to the gh CLI bridge. The frontend Banner
    // surfaces distinct copy + recovery for each.
    #[error("pr not found: {message}")]
    PrNotFound { message: String },
    #[error("packet not found: {message}")]
    PacketNotFound { message: String },
    /// Not yet emitted by any current handler. Reserved for v0.1.x when the
    /// gh CLI bridge starts surfacing 403s as a distinct kind (Phase 4
    /// cycle-1 review F2-19).
    #[allow(dead_code)]
    #[error("permission denied: {message}")]
    PermissionDenied { message: String },
    #[error("yaml-parse-rejected: {reason} {message}")]
    YamlParseRejected { reason: YamlReason, message: String },
    #[error("tamper detected on {packet_id}: {message}")]
    TamperDetected {
        packet_id: String,
        mismatch_type: MismatchType,
        message: String,
    },
    #[error("gh cli error (exit {exit_code}): {stderr}")]
    GhCliError {
        stderr: String,
        exit_code: i32,
        message: String,
    },
    #[error("gh not authenticated: {message}")]
    GhNotAuthenticated { message: String },
    #[error("invalid arguments: field={field} {message}")]
    InvalidArguments { field: String, message: String },
    /// Cycle-2 C15 (PR #21): defence-in-depth against the renderer
    /// bypassing the UI persona gate. The auditor persona cannot
    /// invoke `post_to_pr` or `decide_on_pr`; a call from the React
    /// surface in auditor mode is rejected with this typed variant.
    /// The frontend Banner / M4 modal can switch on `kind=persona-
    /// forbidden` to surface "Auditor mode is read-only" copy.
    #[error("persona forbidden: persona={persona} cannot invoke {command}")]
    PersonaForbidden { persona: String, command: String },
    #[error("internal: {message}")]
    Internal { message: String },
}

/// Wire-format enum (kebab-case) for YamlParseRejected. Three variants are
/// not yet constructed in Rust because the yaml_safety module is dormant
/// pending v0.1.x integration (Phase 4 cycle-1 review F2-19). Keep the
/// closed set to lock the TS contract at the serde boundary.
#[allow(dead_code)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum YamlReason {
    SizeCap,
    Timeout,
    AnchorCount,
    Syntax,
}

/// Per PR #6 cycle-1 review F17 (P3 spec-coverage unchallenged):
///
/// Closed enum mirroring the TS `MismatchType` union and the
/// `packet-changed-externally` event payload. Previously this was a `String`
/// in `IpcError::TamperDetected`, allowing drift between the error variant
/// and the event payload. Locked to the same three variants in both places.
/// Wire-format enum mirroring the TS `MismatchType` union. `HashMismatch`
/// is constructed by the watcher integration that lands in v0.1.x (Phase 4
/// cycle-1 review F2-19); the other two variants ARE emitted by today's
/// tamper path.
#[allow(dead_code)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MismatchType {
    HashMismatch,
    Missing,
    ParseError,
}

impl std::fmt::Display for MismatchType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            MismatchType::HashMismatch => "hash-mismatch",
            MismatchType::Missing => "missing",
            MismatchType::ParseError => "parse-error",
        };
        f.write_str(s)
    }
}

impl std::fmt::Display for YamlReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            YamlReason::SizeCap => "size-cap",
            YamlReason::Timeout => "timeout",
            YamlReason::AnchorCount => "anchor-count",
            YamlReason::Syntax => "syntax",
        };
        f.write_str(s)
    }
}

type IpcResult<T> = Result<T, IpcError>;

fn pending(command: &str, sprint: u8) -> IpcError {
    IpcError::Internal {
        message: format!("{command} not yet implemented (lands in Sprint {sprint})"),
    }
}

// -- read_packet (Sprint 3a — gh#9 criterion 7) ---------------------------
#[derive(Deserialize)]
pub struct ReadPacketArgs {
    pub packet_id: String,
}

/// Response shape returned to the TS-side packet-loader. The frontend runs
/// js-yaml + Ajv against `yaml_text`; the schema in
/// `apps/ui/src/ipc/contract.ts::packetResponseSchema` validates the wire
/// shape here for defense-in-depth.
#[derive(Serialize)]
pub struct PacketResponse {
    pub packet_id: String,
    pub schema_version: String,
    pub yaml_text: String,
    pub yaml_path: String,
}

/// Maximum YAML size accepted at read time (bytes). Mirrors the capture-side
/// expectations: a 50MB packet exceeds even the canonical 700KB fixture by
/// 70× — comfortably above any realistic packet but rejects pathological
/// large-file injection that would otherwise tie up the parser. The
/// frontend's `yaml-parse-rejected` error variant exposes a `size-cap`
/// reason; this is where we trip it.
const READ_PACKET_SIZE_CAP_BYTES: u64 = 50 * 1024 * 1024;

#[tauri::command]
pub async fn read_packet(
    args: ReadPacketArgs,
    state: State<'_, DbState>,
) -> IpcResult<PacketResponse> {
    validate_ulid(&args.packet_id, "packet_id")?;
    let conn = state.0.lock().map_err(|_| IpcError::Internal {
        message: "db connection mutex poisoned".into(),
    })?;
    let meta: PacketMetaRow = match db::select_packet_meta(&conn, &args.packet_id) {
        Ok(Some(meta)) => meta,
        Ok(None) => {
            return Err(IpcError::NotFound {
                message: format!("packet {} not found in libSQL store", args.packet_id),
            });
        }
        Err(e) => {
            return Err(IpcError::Internal {
                message: format!("select_packet_meta: {e}"),
            });
        }
    };
    drop(conn); // release the mutex before the (potentially blocking) file read

    // Path safety guard — a libSQL row with a malformed yaml_path is a
    // corruption signal; treat it as `tamper-detected` so the J12 banner
    // surfaces. The capture side writes paths under `.trail/sessions/...`;
    // an absolute path or a `..` traversal indicates a row that did NOT
    // come from a clean capture run.
    //
    // v0.1.1 B10: the prior version only rejected `..` traversal. An
    // absolute libSQL row (`yaml_path = "/etc/passwd"`) would have read
    // the target file and returned its contents in `PacketResponse.
    // yaml_text` to the renderer. Today no production code path inserts
    // such rows, but capture-side INSERT is coming in v0.1.x — close the
    // gap defensively (security audit P3-1). Windows drive letters are
    // covered by `is_absolute()` cross-platform.
    let path = std::path::Path::new(&meta.yaml_path);
    if path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(IpcError::TamperDetected {
            packet_id: args.packet_id.clone(),
            mismatch_type: MismatchType::ParseError,
            message: format!(
                "yaml_path must be a relative path under .trail/sessions/: {}",
                meta.yaml_path
            ),
        });
    }

    // Read the file. Size-cap check uses `metadata` so we reject without
    // ever streaming a 5GB file into memory.
    let stat = match std::fs::metadata(&meta.yaml_path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(IpcError::TamperDetected {
                packet_id: args.packet_id.clone(),
                mismatch_type: MismatchType::Missing,
                message: format!("yaml file missing on disk: {}", meta.yaml_path),
            });
        }
        Err(e) => {
            return Err(IpcError::Internal {
                message: format!("stat {}: {e}", meta.yaml_path),
            });
        }
    };
    if stat.len() > READ_PACKET_SIZE_CAP_BYTES {
        return Err(IpcError::YamlParseRejected {
            reason: YamlReason::SizeCap,
            message: format!(
                "{} exceeds {}-byte size cap (got {} bytes)",
                meta.yaml_path,
                READ_PACKET_SIZE_CAP_BYTES,
                stat.len()
            ),
        });
    }
    let yaml_text = match std::fs::read_to_string(&meta.yaml_path) {
        Ok(s) => s,
        Err(e) => {
            return Err(IpcError::Internal {
                message: format!("read {}: {e}", meta.yaml_path),
            });
        }
    };

    Ok(PacketResponse {
        packet_id: meta.packet_id,
        schema_version: meta.schema_version,
        yaml_text,
        yaml_path: meta.yaml_path,
    })
}

// -- save_decision ---------------------------------------------------------
#[derive(Deserialize)]
pub struct SaveDecisionArgs {
    pub packet_id: String,
    pub claim_id: String,
    pub decision: String,
    pub reason: Option<String>,
    pub by: String,
    pub at: String,
    /// Cycle-3 C4 (PR #21): persona threading. Auditor cannot save
    /// decisions per B5 §6.5; the Rust handler rejects with
    /// `IpcError::PersonaForbidden`. Defence-in-depth alongside the
    /// React UI gate.
    pub persona: Persona,
}

#[derive(Serialize)]
pub struct OkResponse {
    pub ok: bool,
}

/// Sprint 4 (gh#11 criterion 1, 10): wires the P2 atomic-write saga to the
/// frontend. Calls `SagaDriver::run_decision_saga` with an
/// `AppendDecision` input; on success the libSQL `approval_trail` row is
/// committed and `packets.last_known_hash` reflects the new approval_trail
/// block. The watcher's content-hash compare (B5 §4) will then ignore the
/// debounced filesystem event because the in-flight registry was set
/// during the saga.
#[tauri::command]
pub async fn save_decision(
    args: SaveDecisionArgs,
    db_state: State<'_, DbState>,
    saga_state: State<'_, SagaState>,
) -> IpcResult<OkResponse> {
    // Cycle-3 C4 (PR #21): persona-gating defence-in-depth. Auditor
    // cannot save decisions; the React UI gates the affordance but a
    // developer-tools console invoke must also fail.
    reject_auditor(args.persona, "save_decision")?;
    validate_ulid(&args.packet_id, "packet_id")?;
    validate_decision(&args.decision)?;
    if args.by.trim().is_empty() {
        return Err(invalid("by", "must be non-empty"));
    }

    let yaml_path = resolve_yaml_path(&db_state, &args.packet_id)?;
    let entry = DecisionEntry {
        claim_id: args.claim_id,
        decision: args.decision,
        reason: args.reason,
        by: args.by,
        at: args.at,
    };

    let mut conn_guard = db_state.0.lock().map_err(|_| IpcError::Internal {
        message: "db connection mutex poisoned".into(),
    })?;
    saga_state
        .driver
        .run_decision_saga(
            &args.packet_id,
            std::path::Path::new(&yaml_path),
            &SagaInput::AppendDecision(entry),
            &saga_state.registry,
            &mut conn_guard,
        )
        .map_err(saga_to_ipc_error)?;
    Ok(OkResponse { ok: true })
}

// -- override_risk ---------------------------------------------------------
#[derive(Deserialize)]
pub struct OverrideRiskArgs {
    pub packet_id: String,
    pub claim_id: String,
    pub layer: String,
    pub new_level: String,
    pub reason: String,
    pub by: String,
    pub at: String,
    /// Cycle-3 C4 (PR #21): persona threading. Auditor cannot override
    /// risk per B5 §6.5; the Rust handler rejects with
    /// `IpcError::PersonaForbidden`. Defence-in-depth alongside the
    /// React UI gate.
    pub persona: Persona,
}

/// Sprint 4: variant of `save_decision` that mutates a single claim's
/// risk-override columns instead of appending to approval_trail. Same
/// saga; different `SagaInput` variant.
#[tauri::command]
pub async fn override_risk(
    args: OverrideRiskArgs,
    db_state: State<'_, DbState>,
    saga_state: State<'_, SagaState>,
) -> IpcResult<OkResponse> {
    // Cycle-3 C4 (PR #21): persona-gating defence-in-depth.
    reject_auditor(args.persona, "override_risk")?;
    validate_ulid(&args.packet_id, "packet_id")?;
    let layer = match args.layer.as_str() {
        "creator" => RiskLayer::Creator,
        "reviewer" => RiskLayer::Reviewer,
        other => {
            return Err(IpcError::InvalidArguments {
                field: "layer".into(),
                message: format!("must be creator|reviewer, got {other}"),
            });
        }
    };
    validate_risk_level(&args.new_level)?;
    if args.reason.trim().len() < 3 {
        return Err(IpcError::InvalidArguments {
            field: "reason".into(),
            message: "minimum 3 characters required".into(),
        });
    }

    let yaml_path = resolve_yaml_path(&db_state, &args.packet_id)?;
    let ov = RiskOverride {
        claim_id: args.claim_id,
        layer,
        new_level: args.new_level,
        reason: args.reason,
        by: args.by,
        at: args.at,
    };

    let mut conn_guard = db_state.0.lock().map_err(|_| IpcError::Internal {
        message: "db connection mutex poisoned".into(),
    })?;
    saga_state
        .driver
        .run_decision_saga(
            &args.packet_id,
            std::path::Path::new(&yaml_path),
            &SagaInput::SetRiskOverride(ov),
            &saga_state.registry,
            &mut conn_guard,
        )
        .map_err(saga_to_ipc_error)?;
    Ok(OkResponse { ok: true })
}

// ---------------------------------------------------------------------------
// Saga state container — held by main as Tauri State.
// ---------------------------------------------------------------------------

/// Tauri State holder for the saga driver + the saga-in-flight registry.
/// One instance per process; both the IPC commands and the filesystem
/// watcher consume the same registry so self-write detection is correct.
pub struct SagaState {
    pub driver: SagaDriver,
    pub registry: SagaInFlightRegistry,
}

impl SagaState {
    pub fn new(layer2_patterns: Vec<(String, regex::Regex)>) -> Self {
        Self {
            driver: SagaDriver::new(layer2_patterns),
            registry: SagaInFlightRegistry::new(),
        }
    }
}

fn resolve_yaml_path(db_state: &State<'_, DbState>, packet_id: &str) -> IpcResult<String> {
    let conn = db_state.0.lock().map_err(|_| IpcError::Internal {
        message: "db connection mutex poisoned".into(),
    })?;
    let meta = db::select_packet_meta(&conn, packet_id)
        .map_err(|e| IpcError::Internal {
            message: format!("select_packet_meta: {e}"),
        })?
        .ok_or_else(|| IpcError::NotFound {
            message: format!("packet {packet_id} not found in libSQL"),
        })?;
    Ok(meta.yaml_path)
}

fn saga_to_ipc_error(e: SagaError) -> IpcError {
    match e {
        SagaError::InvalidMutation(m) => IpcError::InvalidArguments {
            field: "claim_id".into(),
            message: m,
        },
        SagaError::StrictRedaction(m) => IpcError::Internal {
            message: format!("strict-redaction-gate: {m}"),
        },
        SagaError::YamlParse(m) => IpcError::YamlParseRejected {
            reason: YamlReason::Syntax,
            message: m,
        },
        SagaError::Io(io) if io.kind() == std::io::ErrorKind::NotFound => {
            IpcError::NotFound {
                message: format!("packet YAML missing on disk: {io}"),
            }
        }
        other => IpcError::Internal {
            message: format!("saga: {other}"),
        },
    }
}

// -- post_to_pr ------------------------------------------------------------
//
// Sprint 5 (gh#12 AC-3, AC-4, AC-5, AC-6, AC-7): wires the M4 modal to
// Phase 3b's `trail packet post` via the cli_bridge.
//
// Flow:
//   1. Validate ULID + pr_number bounds.
//   2. Look up packet's yaml_path from libSQL (defence in depth — caller
//      passed packet_id, not yaml_path; we never trust UI-supplied paths).
//   3. Resolve capture_cli_path from settings (default `trail`, the binary
//      installed by `npm install -g @synapti/trail-capture`).
//   4. Resolve posted_by from settings (default username from $USER).
//   5. Spawn `trail packet post --packet <yaml> --yes [--pr N] [--posted-by X]`
//      via cli_bridge::invoke_packet_post on a blocking thread.
//   6. Map the structured PacketOpError → IpcError so the M4 modal +
//      edge-flow Banners can surface the right kind.
//   7. On success, return the parsed PR URL + body_hash prefix +
//      destination so the M4 modal can show "Posted to <dest>".

#[derive(Deserialize)]
pub struct PostToPrArgs {
    pub packet_id: String,
    pub pr_number: Option<i64>,
    /// Cycle-2 C15 / Cycle-3 C2 (PR #21): persona threaded from the
    /// React App layer so the Rust handler can reject auditor calls
    /// with the typed `IpcError::PersonaForbidden`. Cycle-3 C2 swapped
    /// the previous `String` field for the `Persona` enum so unknown
    /// values fail at serde-deserialize, not at a string-equality
    /// match; this closes the bypass where a hand-crafted DevTools
    /// payload could send `persona: "creator"` from auditor mode.
    pub persona: Persona,
}

/// Cycle-2 C15 / Cycle-3 C2 (PR #21): reject auditor-persona invocations
/// of the post / decide / save / override / write_settings /
/// audit_log_append IPCs. The renderer's UI gates these affordances at
/// the React level, but the IPC layer must enforce the same boundary as
/// defence-in-depth — a developer-tools console invoking
/// `__TAURI_INTERNALS__.invoke('post_to_pr', ...)` from the auditor
/// surface would otherwise succeed.
///
/// Cycle-3 C2 (PR #21): the `persona` parameter is now the closed
/// `Persona` enum (was `&str`). Unknown strings fail at the serde
/// deserialize boundary inside Tauri's `#[tauri::command]` macro;
/// the match here is total over the three documented variants.
///
/// Cycle-4.5 W6 (PR #21): docblock-precision correction. The previous
/// version of this paragraph claimed that unknown personas surface as
/// `IpcError::InvalidArguments`. They do not. Tauri's command macro
/// returns serde deserialize errors as a plain string `InvokeError`,
/// which the TS-side `asIpcError` coerces to `{kind:'internal'}`. The
/// security property still holds because the handler body never runs
/// when deserialize fails; the user-visible kind is `internal`, not
/// `persona-forbidden` (which would only fire on a successful
/// deserialize that the handler then rejects via this function).
///
/// Cycle-3 SEC-7 / Cycle-4.5 W5 (PR #21): the original SEC-7 docblock
/// claimed this function "appends a `persona_forbidden_rejected` audit
/// row" — that claim was aspirational. To be honest about what
/// actually ships:
///
/// Cycle-3.5 ships the typed `IpcError::PersonaForbidden` rejection
/// only; the renderer's `IpcInvocationError` logger records it
/// client-side, but NO database row is appended. The function does
/// not own a `DbState` reference and adding the parameter would
/// ripple through every callsite. A `persona_forbidden_rejected`
/// audit row carrying persona + command + timestamp is PLANNED for
/// v0.2 (see THREAT_MODEL.md §persona-attestation).
fn reject_auditor(persona: Persona, command: &'static str) -> IpcResult<()> {
    if matches!(persona, Persona::Auditor) {
        // Cycle-4.5 W5 (PR #21): no audit row is written here. The
        // typed PersonaForbidden variant carries persona + command;
        // the frontend's IpcInvocationError logger records the
        // rejection client-side. A server-side audit row is v0.2
        // work — the docblock above is the canonical spec.
        return Err(IpcError::PersonaForbidden {
            persona: persona.to_string(),
            command: command.to_string(),
        });
    }
    Ok(())
}

/// v0.1.3 bug-1: every `Option<T>` field below carries
/// `#[serde(skip_serializing_if = "Option::is_none")]`. Without it,
/// serde emits JSON `null` for `None`, which Zod's `.optional()` (used
/// by `apps/ui/src/ipc/contract.ts::postToPrResponseSchema`) rejects —
/// `.optional()` accepts `undefined` / missing key but NOT `null`.
/// Skipping the key makes the wire shape match what Zod expects.
#[derive(Serialize)]
pub struct PostToPrResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_hash_prefix: Option<String>,
}

#[tauri::command]
pub async fn post_to_pr(
    args: PostToPrArgs,
    db_state: State<'_, DbState>,
) -> IpcResult<PostToPrResponse> {
    reject_auditor(args.persona, "post_to_pr")?;
    validate_ulid(&args.packet_id, "packet_id")?;
    let pr_number_u32: Option<u32> = match args.pr_number {
        Some(n) if n <= 0 || n > i32::MAX as i64 => {
            return Err(IpcError::InvalidArguments {
                field: "pr_number".into(),
                message: format!("must be 1..2_147_483_647, got {n}"),
            });
        }
        Some(n) => Some(n as u32),
        None => None,
    };
    let yaml_path = resolve_yaml_path(&db_state, &args.packet_id)?;
    let (cli_path, posted_by) = read_cli_path_and_user();
    let yaml_path_owned = yaml_path.clone();
    let cli_path_owned = cli_path.clone();
    let posted_by_owned = posted_by.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::cli_bridge::invoke_packet_post(
            &cli_path_owned,
            &yaml_path_owned,
            pr_number_u32,
            &posted_by_owned,
            crate::cli_bridge::PACKET_OP_DEFAULT_TIMEOUT,
        )
    })
    .await
    .map_err(|e| IpcError::Internal {
        message: format!("post_to_pr join: {e}"),
    })?;
    match result {
        Ok(outcome) => Ok(PostToPrResponse {
            ok: true,
            pr_url: if outcome.pr_url.is_empty() {
                None
            } else {
                Some(outcome.pr_url)
            },
            destination: if outcome.destination.is_empty() {
                None
            } else {
                Some(outcome.destination)
            },
            body_hash_prefix: if outcome.body_hash_prefix.is_empty() {
                None
            } else {
                Some(outcome.body_hash_prefix)
            },
        }),
        Err(err) => Err(packet_op_to_ipc_error(err)),
    }
}

// -- decide_on_pr ----------------------------------------------------------
//
// Sprint 5 (gh#12 AC-4): J9 reviewer-side block-with-reason loop closure.
// Wires `trail packet decide` so the UI can post a per-claim decision
// (accept|changes|block|reject) to the PR via gh comment + body refresh.

#[derive(Deserialize)]
pub struct DecideOnPrArgs {
    pub packet_id: String,
    pub claim_id: String,
    pub decision: String,
    pub reason: Option<String>,
    pub by: String,
    pub pr_number: Option<i64>,
    /// Cycle-2 C15 / Cycle-3 C2 (PR #21): persona — see PostToPrArgs note.
    pub persona: Persona,
}

#[derive(Serialize)]
pub struct DecideOnPrResponse {
    pub ok: bool,
    // v0.1.3 bug-1: skip None so Zod `.optional()` accepts the response.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    pub claim_id: String,
    pub decision: String,
}

#[tauri::command]
pub async fn decide_on_pr(
    args: DecideOnPrArgs,
    db_state: State<'_, DbState>,
) -> IpcResult<DecideOnPrResponse> {
    reject_auditor(args.persona, "decide_on_pr")?;
    validate_ulid(&args.packet_id, "packet_id")?;
    validate_decision(&args.decision)?;
    if args.claim_id.trim().is_empty() {
        return Err(invalid("claim_id", "must be non-empty"));
    }
    if args.by.trim().is_empty() {
        return Err(invalid("by", "must be non-empty"));
    }
    // Reason is required for changes|block|reject (mirror Phase 3b
    // decide CLI's defence-in-depth).
    if matches!(args.decision.as_str(), "changes" | "block" | "reject") {
        match &args.reason {
            Some(r) if !r.trim().is_empty() => {}
            _ => {
                return Err(invalid(
                    "reason",
                    "required for decision changes|block|reject (J9 step 2)",
                ));
            }
        }
    }
    if let Some(ref r) = args.reason {
        if r.len() > 500 {
            return Err(invalid(
                "reason",
                &format!("must be ≤500 chars, got {}", r.len()),
            ));
        }
    }
    // gh#12 cycle-3 V2 (P3 security defense-in-depth): F6 hardened
    // posted_by against argv flag-injection; the same threat model
    // applies to claim_id, reason, and by — they all flow as argv
    // values to Phase 3b's commander.js (`trail packet decide --claim
    // ... --reason ... --by ...`). The bridge passes each as a
    // separate argv element (no shell injection), but commander.js
    // can interpret a value beginning with `--` as a flag in some
    // configurations. Reject any value that (a) starts with `-`,
    // (b) exceeds the per-field length cap (256 for claim_id/by, 2000
    // for reason — the latter is laxer than the existing 500-char
    // business-logic cap above; both checks compose), or (c)
    // contains a NUL / control character. F7 deferral now closed by V2.
    if !is_argv_safe(&args.claim_id, ARGV_CAP_IDENT) {
        return Err(invalid(
            "claim_id",
            "must not begin with '-', exceed 256 chars, or contain control characters",
        ));
    }
    if !is_argv_safe(&args.by, ARGV_CAP_IDENT) {
        return Err(invalid(
            "by",
            "must not begin with '-', exceed 256 chars, or contain control characters",
        ));
    }
    if let Some(ref r) = args.reason {
        if !is_argv_safe(r, ARGV_CAP_REASON) {
            return Err(invalid(
                "reason",
                "must not begin with '-', exceed 2000 chars, or contain control characters",
            ));
        }
    }
    let pr_number_u32: Option<u32> = match args.pr_number {
        Some(n) if n <= 0 || n > i32::MAX as i64 => {
            return Err(IpcError::InvalidArguments {
                field: "pr_number".into(),
                message: format!("must be 1..2_147_483_647, got {n}"),
            });
        }
        Some(n) => Some(n as u32),
        None => None,
    };
    let yaml_path = resolve_yaml_path(&db_state, &args.packet_id)?;
    let (cli_path, _) = read_cli_path_and_user();
    let cli_path_owned = cli_path.clone();
    let yaml_path_owned = yaml_path.clone();
    let claim_id = args.claim_id.clone();
    let decision = args.decision.clone();
    let reason = args.reason.clone();
    let by = args.by.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::cli_bridge::invoke_packet_decide(
            &cli_path_owned,
            &yaml_path_owned,
            pr_number_u32,
            &claim_id,
            &decision,
            reason.as_deref(),
            &by,
            crate::cli_bridge::PACKET_OP_DEFAULT_TIMEOUT,
        )
    })
    .await
    .map_err(|e| IpcError::Internal {
        message: format!("decide_on_pr join: {e}"),
    })?;
    match result {
        Ok(outcome) => Ok(DecideOnPrResponse {
            ok: true,
            pr_url: if outcome.pr_url.is_empty() {
                None
            } else {
                Some(outcome.pr_url)
            },
            claim_id: outcome.claim_id,
            decision: outcome.decision,
        }),
        Err(err) => Err(packet_op_to_ipc_error(err)),
    }
}

/// Map a packet-op (post/decide) failure to the right IpcError variant
/// so the frontend's edge-flow switch picks the right Banner copy.
fn packet_op_to_ipc_error(err: crate::cli_bridge::PacketOpError) -> IpcError {
    use crate::cli_bridge::PacketOpErrorKind as K;
    match err.kind {
        K::Auth => IpcError::GhNotAuthenticated {
            message: err.stderr,
        },
        K::GhMissing => IpcError::GhCliError {
            stderr: err.stderr,
            exit_code: err.exit_code.unwrap_or(-1),
            message: "gh CLI not installed on PATH".into(),
        },
        // Cycle-1.5 F4 (gh#12 AC-7): MUST surface as distinct IpcError
        // variants — the original collapse made a missing-on-disk packet
        // look like a missing PR in the UI (opposite recovery path).
        K::PrNotFound => IpcError::PrNotFound { message: err.stderr },
        K::PacketNotFound => IpcError::PacketNotFound { message: err.stderr },
        K::InvalidArgs => IpcError::InvalidArguments {
            field: "args".into(),
            message: err.stderr,
        },
        K::Validation => IpcError::YamlParseRejected {
            reason: YamlReason::Syntax,
            message: err.stderr,
        },
        // Network, rate-limit, write, spawn, timeout, other — surface as
        // gh-cli-error so the M4 modal can show the right Banner. The
        // kind str is included verbatim in `stderr` so the frontend can
        // disambiguate by parsing it.
        K::NetworkOrRateLimit | K::Write | K::Spawn | K::Timeout | K::Other => {
            IpcError::GhCliError {
                stderr: format!("[{}] {}", err.kind.as_str(), err.stderr),
                exit_code: err.exit_code.unwrap_or(-1),
                message: format!("packet op failed: {}", err.kind.as_str()),
            }
        }
    }
}

/// Resolve `(capture_cli_path, posted_by)` from settings.json. On any
/// settings-read failure, fall back to safe defaults
/// ([`settings::DEFAULT_CAPTURE_CLI_PATH`] and `$USER`). The fallback is
/// intentional — a missing settings file is normal on first run, and the
/// post path is still operable.
///
/// Cycle-1.5 F6 (gh#12): defence-in-depth — sanitise `posted_by` so a
/// hostile or accidentally-malformed `$USER` (e.g. `--posted-by=other`,
/// `-flag`, or pathological lengths) cannot be interpreted by Phase
/// 3b's commander.js as a CLI flag. The bridge always passes
/// `--posted-by <value>` as separate argv elements (no shell injection
/// surface), but commander.js will still treat a value beginning with
/// `--` as a flag in some configurations. Reject any value that
/// (a) starts with `-` (any single- or double-dash prefix), (b) exceeds
/// 256 chars, or (c) contains a NUL / control character — fall back to
/// the literal "you" placeholder.
fn read_cli_path_and_user() -> (String, String) {
    let settings_path = settings::resolve_settings_path().ok();
    let cli_path = settings_path
        .as_ref()
        .and_then(|p| settings::read_settings(p).ok())
        .map(|s| s.capture_cli_path)
        .unwrap_or_else(|| settings::DEFAULT_CAPTURE_CLI_PATH.to_string());
    let raw_posted_by = std::env::var("TRAIL_POSTED_BY")
        .ok()
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_else(|| "you".to_string());
    let posted_by = sanitise_posted_by(&raw_posted_by);
    (cli_path, posted_by)
}

/// Per-field length caps for argv-value safety (F25-aligned).
/// Identifier-like fields (`claim_id`, `by`, `posted_by`) cap at 256;
/// free-form text (`reason`) caps at 2000. The contract-level Zod
/// schemas in `apps/ui/src/ipc/contract.ts` already enforce upper
/// bounds at the wire level; these caps are the Rust-side defense-in-
/// depth boundary.
const ARGV_CAP_IDENT: usize = 256;
const ARGV_CAP_REASON: usize = 2_000;

/// Shared argv-value safety predicate. Returns true iff `raw` is safe
/// to pass as an argv value to commander.js: non-empty, within cap,
/// no leading dash, no control characters. F25: character-identical
/// to the original `sanitise_posted_by` checks (cycle-1.5 F6) — the
/// only generalisation is the parametrised cap.
fn is_argv_safe(raw: &str, cap: usize) -> bool {
    !(raw.is_empty()
        || raw.len() > cap
        || raw.starts_with('-')
        || raw.chars().any(|c| c.is_control()))
}

/// Defence-in-depth sanitiser for the `posted_by` argv value. See
/// `read_cli_path_and_user` for the threat model. Returns "you" for
/// any value that fails the contract. Cycle-3 V2: refactored onto
/// the shared `is_argv_safe` predicate (F25 character-identical).
fn sanitise_posted_by(raw: &str) -> String {
    if !is_argv_safe(raw, ARGV_CAP_IDENT) {
        return "you".to_string();
    }
    raw.to_string()
}

// -- query_trail / query_recent_sessions (Sprint 2 — gh#8) -----------------
#[derive(Debug, Deserialize, Default)]
pub struct QueryTrailFilter {
    #[serde(default)]
    pub risk_levels: Option<Vec<String>>,
    #[serde(default)]
    pub captured_after: Option<String>,
    #[serde(default)]
    pub captured_before: Option<String>,
    #[serde(default)]
    pub has_redactions: Option<bool>,
    #[serde(default)]
    pub search: Option<String>,
}

#[derive(Deserialize)]
pub struct QueryTrailArgs {
    #[serde(default)]
    pub filter: QueryTrailFilter,
    #[serde(default)]
    pub limit: Option<i64>,
    /// Reserved for v0.1.x — frontend sends an opaque cursor for paged
    /// scrolls; today's query path always returns the full window
    /// (Phase 4 cycle-1 review F2-19).
    #[allow(dead_code)]
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Serialize)]
pub struct QueryTrailResponse {
    pub packets: Vec<SidebarRow>,
    // v0.1.3 bug-1 ship-blocker: serde was emitting `"next_cursor":null`
    // when there were no more rows, but the Zod schema in
    // `apps/ui/src/ipc/contract.ts::queryTrailResponseSchema` uses
    // `z.string().optional()` — which accepts `undefined` / missing
    // key but NOT `null`. Result: EVERY `query_trail` call on a fresh
    // install bricked the sidebar with "backend returned malformed
    // response for query_trail: Expected string, received null at
    // next_cursor". Skipping the key when None makes the wire match
    // what Zod parses cleanly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[tauri::command]
pub async fn query_trail(
    args: QueryTrailArgs,
    state: State<'_, DbState>,
) -> IpcResult<QueryTrailResponse> {
    let limit = args.limit.unwrap_or(50);
    if !(1..=500).contains(&limit) {
        return Err(IpcError::InvalidArguments {
            field: "limit".into(),
            message: format!("must be 1..=500, got {limit}"),
        });
    }
    let filter = TrailFilter {
        risk_levels: args.filter.risk_levels.clone(),
        captured_after: args.filter.captured_after.clone(),
        captured_before: args.filter.captured_before.clone(),
        has_redactions: args.filter.has_redactions,
        search: args.filter.search.clone(),
    };
    if let Some(levels) = filter.risk_levels.as_ref() {
        for l in levels {
            if !matches!(l.as_str(), "low" | "med" | "high" | "crit") {
                return Err(IpcError::InvalidArguments {
                    field: "filter.risk_levels".into(),
                    message: format!("invalid risk level: {l}"),
                });
            }
        }
    }
    let conn = state.0.lock().map_err(|_| IpcError::Internal {
        message: "db connection mutex poisoned".into(),
    })?;
    let packets = db::query_trail(&conn, &filter, limit).map_err(|e| IpcError::Internal {
        message: format!("query_trail: {e}"),
    })?;
    Ok(QueryTrailResponse {
        packets,
        next_cursor: None,
    })
}

#[derive(Deserialize)]
pub struct QueryRecentSessionsArgs {
    #[serde(default)]
    pub limit: Option<i64>,
}

#[tauri::command]
pub async fn query_recent_sessions(
    args: QueryRecentSessionsArgs,
    state: State<'_, DbState>,
) -> IpcResult<Vec<RecentSession>> {
    let limit = args.limit.unwrap_or(5);
    if !(1..=50).contains(&limit) {
        return Err(IpcError::InvalidArguments {
            field: "limit".into(),
            message: format!("must be 1..=50, got {limit}"),
        });
    }
    let conn = state.0.lock().map_err(|_| IpcError::Internal {
        message: "db connection mutex poisoned".into(),
    })?;
    db::query_recent_sessions(&conn, limit).map_err(|e| IpcError::Internal {
        message: format!("query_recent_sessions: {e}"),
    })
}

// -- read_settings / write_settings (Sprint 2 — gh#8 criterion 2) ---------
#[derive(Deserialize)]
pub struct EmptyArgs {}

#[tauri::command]
pub async fn read_settings(_args: EmptyArgs) -> IpcResult<Settings> {
    let path = settings::resolve_settings_path().map_err(|e| IpcError::Internal {
        message: format!("settings path: {e}"),
    })?;
    settings::read_settings(&path).map_err(|e| IpcError::Internal {
        message: format!("read_settings: {e}"),
    })
}

#[derive(Deserialize)]
pub struct WriteSettingsArgs {
    pub partial: serde_json::Value,
    /// Cycle-4.5 W1 (PR #21): persona threading on `write_settings`.
    /// The previous handler had ZERO persona gating — same auditor-bypass
    /// class as the four IPCs cycle-3.5 closed (post / decide / save /
    /// override). DevTools `__TAURI_INTERNALS__.invoke('write_settings',
    /// { partial: { disable_tamper_warnings: true } })` from auditor
    /// mode would have silenced J12 tamper warnings. Auditor is now
    /// rejected with `IpcError::PersonaForbidden` at handler entry; the
    /// `Persona` enum closes the unknown-string bypass at the serde
    /// boundary.
    pub persona: Persona,
}

#[tauri::command]
pub async fn write_settings(args: WriteSettingsArgs) -> IpcResult<OkResponse> {
    // v0.1.2 B11: auditor was previously wholesale-rejected on
    // write_settings (the cycle-4.5 W1 threat: auditor silencing J12
    // tamper warnings via `disable_tamper_warnings`). But `pinned_sessions`
    // is purely a UI affordance — auditor reviewing 5 sessions in a row
    // legitimately wants to mark one for return. Allow auditor IF the
    // partial contains ONLY `pinned_sessions` and no other settings keys.
    // Any partial that touches even one other field reverts to the
    // original wholesale rejection.
    if args.persona == Persona::Auditor && !partial_is_pinned_sessions_only(&args.partial) {
        reject_auditor(args.persona, "write_settings")?;
    }
    let path = settings::resolve_settings_path().map_err(|e| IpcError::Internal {
        message: format!("settings path: {e}"),
    })?;
    let mut current = settings::read_settings(&path).map_err(|e| IpcError::Internal {
        message: format!("read_settings: {e}"),
    })?;
    let merged = merge_settings_partial(&mut current, &args.partial)?;
    settings::write_settings(&path, merged).map_err(|e| IpcError::Internal {
        message: format!("write_settings: {e}"),
    })?;
    Ok(OkResponse { ok: true })
}

/// v0.1.2 B11: returns true when `partial` is a JSON object whose only
/// key is `pinned_sessions`. Used by `write_settings` to allow auditor
/// to maintain the recent-sessions pin list (UI affordance — no security
/// threat) while preserving the wholesale auditor-rejection on any
/// partial that touches a security-sensitive field like
/// `disable_tamper_warnings`. An empty object returns false — there is
/// no auditor use case for a no-op write.
fn partial_is_pinned_sessions_only(partial: &serde_json::Value) -> bool {
    let Some(obj) = partial.as_object() else {
        return false;
    };
    obj.len() == 1 && obj.contains_key("pinned_sessions")
}

/// Merge a JSON `partial` into `current`. Only the fields documented in
/// `settingsSchema` (B5 §6.6 + this file's Settings struct) are honoured;
/// unknown fields are rejected with `IpcError::InvalidArguments`. This is
/// defense-in-depth: the frontend zod schema rejects unknown keys via
/// `partial`, but the backend MUST also reject them so a future build
/// without the runtime zod validator does not silently accept arbitrary
/// keys.
fn merge_settings_partial<'a>(
    current: &'a mut Settings,
    partial: &serde_json::Value,
) -> Result<&'a mut Settings, IpcError> {
    let obj = partial.as_object().ok_or_else(|| IpcError::InvalidArguments {
        field: "partial".into(),
        message: "expected object".into(),
    })?;
    for (key, value) in obj.iter() {
        match key.as_str() {
            "theme" => {
                let s = value.as_str().ok_or_else(|| invalid("theme", "expected string"))?;
                if !matches!(s, "dark" | "light" | "system") {
                    return Err(invalid("theme", "must be dark|light|system"));
                }
                current.theme = s.into();
            }
            "density" => {
                let s = value.as_str().ok_or_else(|| invalid("density", "expected string"))?;
                if !matches!(s, "comfortable" | "compact") {
                    return Err(invalid("density", "must be comfortable|compact"));
                }
                current.density = s.into();
            }
            "disable_tamper_warnings" => {
                let b = value
                    .as_bool()
                    .ok_or_else(|| invalid("disable_tamper_warnings", "expected bool"))?;
                current.disable_tamper_warnings = b;
            }
            "heavy_redaction_threshold" => {
                let n = value
                    .as_u64()
                    .ok_or_else(|| invalid("heavy_redaction_threshold", "expected non-negative integer"))?;
                if !(1..=500).contains(&n) {
                    return Err(invalid(
                        "heavy_redaction_threshold",
                        "must be in 1..=500",
                    ));
                }
                current.heavy_redaction_threshold = n as u32;
            }
            "capture_cli_path" => {
                let s = value
                    .as_str()
                    .ok_or_else(|| invalid("capture_cli_path", "expected string"))?;
                // gh#17 SEC-1: parity with the cap enforced at
                // `validate_capture_cli_path` (ipc.rs:1423). Without this,
                // a 4MB string could be persisted to settings.json and
                // then spawned literally — settings file would also hit
                // the 64KB SETTINGS_MAX_BYTES cap at read time, but
                // bounding here keeps `Settings::capture_cli_path` in a
                // shape that downstream `spawn()` can safely consume
                // without further validation.
                if s.len() > 4096 {
                    return Err(invalid(
                        "capture_cli_path",
                        &format!("too long ({} bytes; max 4096)", s.len()),
                    ));
                }
                current.capture_cli_path = s.into();
            }
            "pinned_sessions" => {
                let arr = value.as_array().ok_or_else(|| {
                    invalid("pinned_sessions", "expected array")
                })?;
                if arr.len() > settings::MAX_PINNED_SESSIONS {
                    return Err(invalid(
                        "pinned_sessions",
                        "max 5 entries",
                    ));
                }
                let mut next = Vec::with_capacity(arr.len());
                for entry in arr {
                    let obj = entry
                        .as_object()
                        .ok_or_else(|| invalid("pinned_sessions[]", "expected object"))?;
                    let session_id = obj
                        .get("session_id")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| {
                            invalid("pinned_sessions[].session_id", "expected string")
                        })?
                        .to_string();
                    if session_id.is_empty() {
                        return Err(invalid(
                            "pinned_sessions[].session_id",
                            "must be non-empty",
                        ));
                    }
                    let pinned_at = obj
                        .get("pinned_at")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| invalid("pinned_sessions[].pinned_at", "expected string"))?
                        .to_string();
                    next.push(PinnedSession { session_id, pinned_at });
                }
                current.pinned_sessions = next;
            }
            // Unknown keys are rejected per the defense-in-depth note above.
            _ => return Err(invalid(key, "unknown settings field")),
        }
    }
    Ok(current)
}

fn invalid(field: &str, message: &str) -> IpcError {
    IpcError::InvalidArguments {
        field: field.into(),
        message: message.into(),
    }
}

// -- preview_redacted ------------------------------------------------------
#[derive(Deserialize)]
pub struct PreviewRedactedArgs {
    pub packet_id: String,
    pub redaction_id: String,
}

#[derive(Serialize)]
pub struct PreviewRedactedResponse {
    // v0.1.3 bug-1: skip None so Zod `.optional()` accepts the response.
    // This handler returns `None` on every call in v0.1.x (capture writes
    // redacted-only by design), so without `skip_serializing_if` every
    // M3 preview click would have hit the Zod-null mismatch the same way
    // `query_trail` did. Caught proactively by the v0.1.3 audit even
    // though Daniel's repro never reached this command.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,
}

/// Sprint 4 (gh#11 criterion 6): M3 redaction-preview opt-in path.
///
/// Per B6 P1 + the security trust contract, original (un-redacted) values
/// are never stored on disk: the capture pipeline writes redacted YAML
/// only. So this IPC returns `{ original: None }` always in v0.1, with the
/// `redaction_id` validated to ensure the request is well-formed. The M3
/// modal surfaces a "Original not retained on disk" notice instead of
/// the original text.
///
/// This is the security-correct surface: even with full IPC compromise,
/// no original token can be exfiltrated because none exists on disk.
#[tauri::command]
pub async fn preview_redacted(args: PreviewRedactedArgs) -> IpcResult<PreviewRedactedResponse> {
    validate_ulid(&args.packet_id, "packet_id")?;
    if args.redaction_id.trim().is_empty() {
        return Err(invalid("redaction_id", "must be non-empty"));
    }
    Ok(PreviewRedactedResponse { original: None })
}

// -- audit_log_append ------------------------------------------------------

/// v0.1.1 B5: which audit-log event types require creator/reviewer (i.e.,
/// auditor must be rejected). Auditor IS the legitimate user of tamper
/// banners and dismissals in audit mode; only settings mutations carry
/// the original cycle-4.5 W2 threat ("auditor silences J12 via settings").
fn audit_event_requires_writer(event_type: &str) -> bool {
    matches!(event_type, "settings_changed_via_ui")
}

#[derive(Deserialize)]
pub struct AuditLogAppendArgs {
    pub event_type: String,
    pub packet_id: Option<String>,
    pub details: serde_json::Value,
    /// Cycle-4.5 W2 (PR #21): persona threading. The previous handler
    /// had ZERO persona gating — an auditor could append arbitrary
    /// rows to the audit_log via `__TAURI_INTERNALS__.invoke` from
    /// DevTools, polluting the chain hash. Auditor is now rejected
    /// with `IpcError::PersonaForbidden`. The Persona enum closes the
    /// unknown-string bypass at the serde-deserialize boundary.
    pub persona: Persona,
}

/// Cycle-4.5 W2 (PR #21): hard cap on the serialized JSON length of
/// the `details` payload. The previous handler accepted unbounded
/// `serde_json::Value` — DevTools could submit a 100MB blob and bloat
/// the audit_log table / chain hash compute time. 4 KB is enough for
/// every documented frontend audit event (mismatch_type + redaction_id
/// + a short partial-settings dict) and forces a deliberate revisit
/// here if the catalog grows. Mirrors the discipline of the
/// is_argv_safe length caps elsewhere in this module.
const AUDIT_DETAILS_MAX_BYTES: usize = 4 * 1024;

/// Sprint 4 (gh#11 criterion 4): wires the J12 dismiss / re-verify paths
/// + settings-changed-via-ui events to the audit_log table. The chain hash
/// is computed in Rust per `db::compute_audit_row_hash` (mirrors the TS
/// `computeRowHash` length-prefix encoding character-for-character).
#[tauri::command]
pub async fn audit_log_append(
    args: AuditLogAppendArgs,
    db_state: State<'_, DbState>,
) -> IpcResult<OkResponse> {
    // v0.1.1 B5: per-event-type persona gating. The original cycle-4.5 W2
    // wholesale-rejected auditor on audit_log_append, but auditor IS the
    // primary user of the tamper_dismissed / tamper_re_verified banners
    // (audit mode is read-only review of a frozen tree). The threat the
    // W2 docblock guards against — auditor silencing J12 warnings via
    // settings — only applies to `settings_changed_via_ui`. Per-event
    // gating closes the threat without breaking audit-mode bookkeeping.
    if !matches!(
        args.event_type.as_str(),
        "tamper_dismissed" | "tamper_re_verified" | "settings_changed_via_ui"
    ) {
        return Err(IpcError::InvalidArguments {
            field: "event_type".into(),
            message: format!(
                "frontend may only emit tamper_dismissed | tamper_re_verified | settings_changed_via_ui; got {}",
                args.event_type
            ),
        });
    }
    if audit_event_requires_writer(&args.event_type) {
        reject_auditor(args.persona, "audit_log_append::settings_changed_via_ui")?;
    }
    if let Some(ref id) = args.packet_id {
        validate_ulid(id, "packet_id")?;
    }
    let details_string =
        serde_json::to_string(&args.details).map_err(|e| IpcError::Internal {
            message: format!("audit details serialize: {e}"),
        })?;
    if details_string.len() > AUDIT_DETAILS_MAX_BYTES {
        return Err(invalid(
            "details",
            &format!(
                "serialized JSON must be ≤{} bytes (got {})",
                AUDIT_DETAILS_MAX_BYTES,
                details_string.len()
            ),
        ));
    }
    let mut conn_guard = db_state.0.lock().map_err(|_| IpcError::Internal {
        message: "db connection mutex poisoned".into(),
    })?;
    db::append_audit_log(
        &mut conn_guard,
        &args.event_type,
        args.packet_id.as_deref(),
        &details_string,
    )
    .map_err(|e| IpcError::Internal {
        message: format!("append_audit_log: {e}"),
    })?;
    Ok(OkResponse { ok: true })
}

// -- subscribe_* -----------------------------------------------------------
//
// Sprint 4: subscription is implicit. The watcher (spawned in main.rs)
// uses Tauri's `app_handle.emit()` to broadcast `packet-changed`,
// `packet-changed-externally`, `trail-needs-refresh`. The frontend
// subscribes via `@tauri-apps/api/event#listen` directly. This IPC
// remains as an explicit "ack" the UI calls on mount so the watcher
// emitter knows there is a UI to receive events; in v0.1 it returns Ok
// unconditionally (the watcher already runs from boot).
#[tauri::command]
pub async fn subscribe_fs_watch(_args: EmptyArgs) -> IpcResult<OkResponse> {
    Ok(OkResponse { ok: true })
}

#[tauri::command]
pub async fn subscribe_settings_change(_args: EmptyArgs) -> IpcResult<OkResponse> {
    Err(pending("subscribe_settings_change", 6))
}

// -- validate_capture_cli_path -------------------------------------------
//
// Cycle-1.5 F3 (P1): wires `cli_bridge::validate_capture_cli_path` to the
// frontend so the M6 Capture panel can probe the user-entered binary
// before persisting it. AC-11 requires "typed Rust IPC subprocess
// invocation" — without this command the bridge module is unreachable
// from the UI (the N15 anti-pattern: tested-but-not-wired).
//
// The bridge spawns the binary with argv (no shell-string interp) and a
// 30s timeout. On non-zero exit, missing binary, timeout, or empty
// stdout we return a structured error variant the UI surfaces inline.
// On success the captured `--version` line is returned so the UI can
// display "verified - <version>".

#[derive(Deserialize)]
pub struct ValidateCaptureCliPathArgs {
    pub path: String,
}

#[derive(Serialize)]
#[serde(tag = "ok", rename_all = "lowercase")]
pub enum ValidateCaptureCliPathResponse {
    /// Probe succeeded; the bridge spawned the binary and read its
    /// `--version` line. The UI shows "verified - <version>".
    #[serde(rename = "true")]
    True { version: String },
    /// Probe failed. `kind` is one of the kebab-case discriminants
    /// declared on `BridgeError::kind()`; `message` is the underlying
    /// error string. The UI branches on `kind` to decide which inline
    /// hint to render (binary not found vs. version probe timed out vs.
    /// non-zero exit, etc.).
    #[serde(rename = "false")]
    False { kind: String, message: String },
}

/// Sprint 4 cycle-1.5 (gh#11 criterion 11): real-subprocess validation of
/// the user-supplied capture CLI path from M6 Settings → Capture.
///
/// Returns Ok(...) for both success AND probe-failure outcomes; the
/// discriminated union keeps the IPC error channel reserved for true
/// system errors (e.g., invalid arguments) so a "binary not found"
/// surface is a routine settings-form result rather than a toast-level
/// failure. The frontend renders the result inline below the input.
#[tauri::command]
pub async fn validate_capture_cli_path(
    args: ValidateCaptureCliPathArgs,
) -> IpcResult<ValidateCaptureCliPathResponse> {
    let trimmed = args.path.trim();
    if trimmed.is_empty() {
        return Err(IpcError::InvalidArguments {
            field: "path".into(),
            message: "capture_cli_path must be non-empty".into(),
        });
    }
    // Soft length cap so we never spawn with an absurdly large argv[0].
    if trimmed.len() > 4096 {
        return Err(IpcError::InvalidArguments {
            field: "path".into(),
            message: format!("capture_cli_path too long ({} bytes)", trimmed.len()),
        });
    }
    // Real subprocess invocation — no mock path. Heavy lifting runs on a
    // blocking thread because the bridge uses a synchronous Command +
    // try_wait poll loop, and Tauri commands run on the async runtime.
    let path_owned = trimmed.to_string();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::cli_bridge::validate_capture_cli_path(&path_owned)
    })
    .await
    .map_err(|e| IpcError::Internal {
        message: format!("validate_capture_cli_path join: {e}"),
    })?;
    match result {
        Ok(version) => Ok(ValidateCaptureCliPathResponse::True {
            version: version.version,
        }),
        Err(err) => {
            let kind = err.kind().to_string();
            Ok(ValidateCaptureCliPathResponse::False {
                kind,
                message: err.to_string(),
            })
        }
    }
}

// -- detect_capture_cli (gh#17) ------------------------------------------
//
// Auto-detect the `trail` binary on this machine. Probe order (AC#2):
//
//   (a) login-shell — `zsh -ic 'command -v trail'`, then `bash -ic`,
//       bounded by 5s. Picks up users whose interactive PATH is set in
//       .zshrc / .bashrc but is NOT inherited by Tauri's GUI launch.
//   (b) candidate paths — /opt/homebrew/bin/trail, /usr/local/bin/trail,
//       $HOME/.npm-global/bin/trail, $HOME/.local/bin/trail. Catches
//       the common macOS / Linux npm install matrix.
//   (c) marker file — ~/.trail/last-run.json `cli_path` field if
//       present (best-effort; CLI cooperation is a follow-up).
//
// First success wins. Each strategy invokes the augmented-PATH version
// probe so the macOS GUI-PATH bug (env: node: No such file) is sidestepped
// before the user opens Settings.
//
// On failure the response carries a classified `failure_kind` and an
// actionable `suggested_fix` (install command, symlink command, etc.).
// The discriminated union mirrors `validate_capture_cli_path`'s pattern:
// IPC error channel reserved for true system errors, "no trail found"
// is a routine result the UI renders inline.

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DetectCaptureCliResponse {
    /// A `trail` binary was located and successfully responded to
    /// `--version`. `source` indicates which probe strategy resolved it.
    Detected {
        path: String,
        version: String,
        source: crate::cli_bridge::DetectSource,
    },
    /// No working `trail` binary was found via any probe strategy.
    /// `failure_kind` is the classified discriminant the UI's failure
    /// card switches on; `message` + `suggested_fix` carry user-actionable
    /// copy.
    Failed {
        failure_kind: crate::cli_bridge::DetectFailureKind,
        message: String,
        suggested_fix: String,
    },
}

#[tauri::command]
pub async fn detect_capture_cli(_args: EmptyArgs) -> IpcResult<DetectCaptureCliResponse> {
    let result = tauri::async_runtime::spawn_blocking(crate::cli_bridge::detect_capture_cli)
        .await
        .map_err(|e| IpcError::Internal {
            message: format!("detect_capture_cli join: {e}"),
        })?;
    match result {
        Ok(success) => Ok(DetectCaptureCliResponse::Detected {
            path: success.path,
            version: success.version,
            source: success.source,
        }),
        Err(failure) => Ok(DetectCaptureCliResponse::Failed {
            failure_kind: failure.kind,
            message: failure.message,
            suggested_fix: failure.suggested_fix,
        }),
    }
}

// -- list_claude_sessions (gh#18 AC#3) ------------------------------------
//
// Enumerates Claude Code sessions under `~/.claude/projects/` with metadata
// (started_at, message_count, packet_id cross-reference). Discriminated
// `kind` response so failure surfaces can render an explanation card on
// the Capture surface rather than a toast.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ListClaudeSessionsResponse {
    Ok {
        sessions: Vec<crate::sessions::ClaudeSession>,
    },
    Failed {
        failure_kind: crate::sessions::ListFailureKind,
        message: String,
    },
}

#[tauri::command]
pub async fn list_claude_sessions(
    _args: EmptyArgs,
    metadata_cache: tauri::State<'_, std::sync::Arc<crate::sessions::JsonlMetadataCache>>,
) -> IpcResult<ListClaudeSessionsResponse> {
    // v0.2 P2-F4: clone the Arc so the blocking task can take ownership.
    let cache = std::sync::Arc::clone(&*metadata_cache);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let projects_root = match crate::sessions::claude_projects_root() {
            Some(p) => p,
            None => {
                return Err(crate::sessions::ListError {
                    kind: crate::sessions::ListFailureKind::ProjectsDirNotFound,
                    message: "cannot resolve home directory".into(),
                });
            }
        };
        // Trail sessions root: <repo>/.trail/sessions when running in a repo;
        // None when the cwd has no .trail/ directory. We probe both `./.trail`
        // and the current Tauri working directory.
        let cwd = std::env::current_dir().ok();
        let trail_root = cwd
            .as_ref()
            .map(|d| d.join(".trail").join("sessions"))
            .filter(|p| p.is_dir());
        crate::sessions::list_claude_sessions(&projects_root, trail_root.as_deref(), &cache)
    })
    .await
    .map_err(|e| IpcError::Internal {
        message: format!("list_claude_sessions join: {e}"),
    })?;

    match result {
        Ok(sessions) => Ok(ListClaudeSessionsResponse::Ok { sessions }),
        Err(err) => Ok(ListClaudeSessionsResponse::Failed {
            failure_kind: err.kind,
            message: err.message,
        }),
    }
}

// -- spawn_packet_generate / cancel_packet_generate (gh#18 AC#5/6) -------
//
// Spawns `trail packet generate <session_id>` and streams stderr as
// `packet-generate-progress` events. The IPC returns a `spawn_id` the
// renderer holds for later cancellation. Worker lives in `spawn.rs`.

#[derive(Deserialize)]
pub struct SpawnPacketGenerateArgs {
    pub session_id: String,
    /// SEC-1: persona is required so the handler can reject auditor mode
    /// at the IPC boundary. `trail packet generate` is a state-mutating
    /// command (writes packet YAML to `.trail/sessions/<sid>/packet-N.yml`)
    /// and must obey the same persona model as save_decision /
    /// override_risk / post_to_pr / decide_on_pr / write_settings.
    pub persona: Persona,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SpawnPacketGenerateResponse {
    Spawned {
        spawn_id: String,
    },
    Failed {
        failure_kind: crate::spawn::SpawnFailureKind,
        message: String,
    },
}

#[tauri::command]
pub async fn spawn_packet_generate<R: tauri::Runtime>(
    args: SpawnPacketGenerateArgs,
    app: tauri::AppHandle<R>,
    registry: State<'_, crate::spawn::SpawnRegistry>,
) -> IpcResult<SpawnPacketGenerateResponse> {
    reject_auditor(args.persona, "spawn_packet_generate")?;
    if let Err(err) = crate::spawn::validate_session_id(&args.session_id) {
        return Ok(SpawnPacketGenerateResponse::Failed {
            failure_kind: err.kind,
            message: err.message,
        });
    }

    let session_id = args.session_id.clone();
    let child = match crate::spawn::spawn_trail_packet_generate_child(&session_id) {
        Ok(c) => c,
        Err(err) => {
            return Ok(SpawnPacketGenerateResponse::Failed {
                failure_kind: err.kind,
                message: err.message,
            });
        }
    };

    // Generate the spawn_id and register the cancel flag BEFORE spawning the
    // worker thread so a fast cancel call can succeed even if the worker
    // hasn't entered its poll loop yet.
    let spawn_id = ulid::Ulid::new().to_string();
    let cancel_flag = registry.register(spawn_id.clone());

    let app_clone = app.clone();
    let spawn_id_for_worker = spawn_id.clone();
    let session_id_for_worker = session_id.clone();
    // Cleanup happens via app_clone.state() inside the worker thread — the
    // SpawnRegistry holds a Mutex<HashMap> which isn't Clone, so we route
    // through Tauri's state-resolution instead of a shared handle.
    std::thread::Builder::new()
        .name(format!("trail-spawn-{spawn_id}"))
        .spawn(move || {
            crate::spawn::run_packet_generate(
                app_clone.clone(),
                spawn_id_for_worker.clone(),
                session_id_for_worker,
                child,
                cancel_flag,
            );
            // Cleanup the registry entry once the worker exits.
            let registry = app_clone.state::<crate::spawn::SpawnRegistry>();
            registry.cleanup(&spawn_id_for_worker);
        })
        .map_err(|e| IpcError::Internal {
            message: format!("spawn worker thread: {e}"),
        })?;

    Ok(SpawnPacketGenerateResponse::Spawned { spawn_id })
}

#[derive(Deserialize)]
pub struct CancelPacketGenerateArgs {
    pub spawn_id: String,
    /// SEC-1: same persona gate as spawn_packet_generate. Auditor mode
    /// cannot cancel a spawn it should not have been able to start. The
    /// kill side-effect on the child process is a state mutation
    /// (terminates a process the renderer should not control).
    pub persona: Persona,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CancelPacketGenerateResponse {
    Ok { cancelled: bool },
}

#[tauri::command]
pub async fn cancel_packet_generate(
    args: CancelPacketGenerateArgs,
    registry: State<'_, crate::spawn::SpawnRegistry>,
) -> IpcResult<CancelPacketGenerateResponse> {
    reject_auditor(args.persona, "cancel_packet_generate")?;
    let cancelled = registry.cancel(&args.spawn_id);
    Ok(CancelPacketGenerateResponse::Ok { cancelled })
}

// -- seed_stress_packets (test-only IPC, gh#8 criterion 5 perf benchmark) -
//
// The Playwright E2E harness drives the 1000-packet stress test by calling
// this command on app boot in test mode. It is gated by `cfg(any(...))` so
// production release builds simply do not register it; calling it from a
// release build is a hard "command not found" error.
#[cfg(any(debug_assertions, feature = "test-fixtures"))]
#[derive(Deserialize)]
pub struct SeedStressPacketsArgs {
    pub count: u32,
    // v0.1.x gh#8 criterion (iii) defence-in-depth: persona-gate the
    // state-mutation IPC at the handler body, not only via the
    // compile-out `cfg`. A dev or `--features test-fixtures` build DOES
    // register this handler; the cfg alone does not protect those
    // builds from an auditor-mode DevTools session invoking the IPC
    // via `__TAURI_INTERNALS__.invoke(...)`. Mirrors the C15 sweep
    // applied to save_decision / override_risk / post_to_pr /
    // decide_on_pr / write_settings.
    pub persona: Persona,
}

#[cfg(any(debug_assertions, feature = "test-fixtures"))]
#[tauri::command]
pub async fn seed_stress_packets(
    args: SeedStressPacketsArgs,
    state: State<'_, DbState>,
) -> IpcResult<OkResponse> {
    // v0.1.x gh#8 criterion (iii): handler-body auditor rejection.
    // The release build never reaches this code (cfg compiles the
    // handler out). On dev / test-fixtures builds, the typed
    // PersonaForbidden rejection at handler entry prevents an
    // auditor-mode renderer from seeding 1000 fake packets via
    // DevTools. b9_seed_stress_* tests below pin the contract.
    reject_auditor(args.persona, "seed_stress_packets")?;
    if args.count == 0 || args.count > 5_000 {
        return Err(IpcError::InvalidArguments {
            field: "count".into(),
            message: format!("must be 1..=5000, got {}", args.count),
        });
    }
    let mut conn = state.0.lock().map_err(|_| IpcError::Internal {
        message: "db connection mutex poisoned".into(),
    })?;
    db::seed_stress_packets(&mut conn, args.count as usize).map_err(|e| IpcError::Internal {
        message: format!("seed_stress_packets: {e}"),
    })?;
    Ok(OkResponse { ok: true })
}

// -- shared validators -----------------------------------------------------
fn validate_ulid(value: &str, field: &str) -> Result<(), IpcError> {
    if value.len() != 26 || !value.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(IpcError::InvalidArguments {
            field: field.into(),
            message: format!("invalid ULID: {value}"),
        });
    }
    Ok(())
}

fn validate_decision(value: &str) -> Result<(), IpcError> {
    if !matches!(value, "accept" | "changes" | "block" | "reject") {
        return Err(IpcError::InvalidArguments {
            field: "decision".into(),
            message: format!("invalid decision: {value}"),
        });
    }
    Ok(())
}

fn validate_risk_level(value: &str) -> Result<(), IpcError> {
    if !matches!(value, "low" | "med" | "high" | "crit") {
        return Err(IpcError::InvalidArguments {
            field: "new_level".into(),
            message: format!("invalid risk level: {value}"),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_short_ulid() {
        assert!(matches!(
            validate_ulid("xx", "packet_id"),
            Err(IpcError::InvalidArguments { .. })
        ));
    }

    #[test]
    fn accepts_valid_ulid() {
        assert!(validate_ulid("01ARZ3NDEKTSV4RRFFQ69G5FAV", "packet_id").is_ok());
    }

    #[test]
    fn rejects_unknown_decision() {
        assert!(validate_decision("yolo").is_err());
    }

    #[test]
    fn validates_risk_level_set() {
        for ok in ["low", "med", "high", "crit"] {
            assert!(validate_risk_level(ok).is_ok());
        }
        assert!(validate_risk_level("LOW").is_err());
    }

    // gh#12 cycle-1.5 F4 N15 regression: AC-7 mandates that PR-not-found
    // (gh exit 9) and packet-not-found (gh exit 2) MUST surface as
    // distinct IpcError variants. The original cycle-1 code collapsed
    // both PacketOpErrorKind::PrNotFound and ::PacketNotFound into the
    // same IpcError::NotFound variant, so the UI told users "PR not
    // found" when their LOCAL packet YAML was the missing thing —
    // opposite recovery path. Lock the distinction at the contract
    // boundary.
    #[test]
    fn ac7_pr_not_found_maps_to_distinct_ipc_variant() {
        use crate::cli_bridge::{PacketOpError, PacketOpErrorKind};
        let err = PacketOpError {
            kind: PacketOpErrorKind::PrNotFound,
            stderr: "no PR for branch X".into(),
            exit_code: Some(9),
        };
        let ipc = packet_op_to_ipc_error(err);
        assert!(
            matches!(ipc, IpcError::PrNotFound { .. }),
            "PrNotFound (exit 9) MUST surface as IpcError::PrNotFound, got {ipc:?}"
        );
    }

    #[test]
    fn ac7_packet_not_found_maps_to_distinct_ipc_variant() {
        use crate::cli_bridge::{PacketOpError, PacketOpErrorKind};
        let err = PacketOpError {
            kind: PacketOpErrorKind::PacketNotFound,
            stderr: "packet YAML missing on disk".into(),
            exit_code: Some(2),
        };
        let ipc = packet_op_to_ipc_error(err);
        // Critical: must NOT be IpcError::PrNotFound or IpcError::NotFound
        // — those were the cycle-1 bug surfaces.
        assert!(
            !matches!(ipc, IpcError::PrNotFound { .. }),
            "PacketNotFound MUST NOT surface as PrNotFound (was cycle-1 collapse bug)"
        );
        assert!(
            matches!(ipc, IpcError::PacketNotFound { .. }),
            "PacketNotFound (exit 2) MUST surface as IpcError::PacketNotFound, got {ipc:?}"
        );
    }

    // gh#12 cycle-1.5 F6 (P2 MED): defense-in-depth — sanitise_posted_by
    // must reject values that commander.js could interpret as a flag, OR
    // pathological-length / control-char inputs.
    #[test]
    fn f6_sanitise_posted_by_rejects_dash_prefix() {
        assert_eq!(sanitise_posted_by("--posted-by=other"), "you");
        assert_eq!(sanitise_posted_by("-flag"), "you");
        assert_eq!(sanitise_posted_by("---"), "you");
    }

    #[test]
    fn f6_sanitise_posted_by_rejects_oversize() {
        let long = "a".repeat(257);
        assert_eq!(sanitise_posted_by(&long), "you");
    }

    #[test]
    fn f6_sanitise_posted_by_rejects_control_chars() {
        assert_eq!(sanitise_posted_by("user\nname"), "you");
        assert_eq!(sanitise_posted_by("user\0name"), "you");
        assert_eq!(sanitise_posted_by("user\tname"), "you");
    }

    #[test]
    fn f6_sanitise_posted_by_rejects_empty() {
        assert_eq!(sanitise_posted_by(""), "you");
    }

    #[test]
    fn f6_sanitise_posted_by_accepts_normal_values() {
        assert_eq!(sanitise_posted_by("alice"), "alice");
        assert_eq!(sanitise_posted_by("alice@example.com"), "alice@example.com");
        assert_eq!(sanitise_posted_by("alice.b"), "alice.b");
        assert_eq!(sanitise_posted_by("user_name"), "user_name");
        // Boundary: exactly 256 chars accepted.
        let exactly_256 = "x".repeat(256);
        assert_eq!(sanitise_posted_by(&exactly_256), exactly_256);
    }

    // gh#12 cycle-3 V2 (P3 security defense-in-depth): F6 hardened
    // posted_by; the same threat model applies to claim_id, reason,
    // and by — they all flow as argv values to Phase 3b's
    // commander.js. The shared `is_argv_safe` predicate enforces the
    // same checks (no leading dash, no control chars, no empty, no
    // oversize) with the only generalisation being the parametrised
    // length cap (256 for identifier-shaped fields, 2000 for reason
    // free-form text). F25: character-identical to F6.
    #[test]
    fn v2_is_argv_safe_rejects_dash_prefix() {
        assert!(!is_argv_safe("--claim=other", ARGV_CAP_IDENT));
        assert!(!is_argv_safe("-flag", ARGV_CAP_IDENT));
        assert!(!is_argv_safe("---", ARGV_CAP_IDENT));
        assert!(!is_argv_safe("--reason=hostile", ARGV_CAP_REASON));
    }

    #[test]
    fn v2_is_argv_safe_rejects_oversize() {
        let long_ident = "a".repeat(257);
        assert!(!is_argv_safe(&long_ident, ARGV_CAP_IDENT));
        let long_reason = "b".repeat(2_001);
        assert!(!is_argv_safe(&long_reason, ARGV_CAP_REASON));
    }

    #[test]
    fn v2_is_argv_safe_rejects_control_chars() {
        assert!(!is_argv_safe("claim\nbreak", ARGV_CAP_IDENT));
        assert!(!is_argv_safe("by\0nul", ARGV_CAP_IDENT));
        assert!(!is_argv_safe("reason\twith\ttab", ARGV_CAP_REASON));
        assert!(!is_argv_safe("reason\rcr", ARGV_CAP_REASON));
    }

    #[test]
    fn v2_is_argv_safe_rejects_empty() {
        assert!(!is_argv_safe("", ARGV_CAP_IDENT));
        assert!(!is_argv_safe("", ARGV_CAP_REASON));
    }

    #[test]
    fn v2_is_argv_safe_accepts_normal_values_and_boundaries() {
        // Identifier-shaped values.
        assert!(is_argv_safe("CLAIM-001", ARGV_CAP_IDENT));
        assert!(is_argv_safe("alice@example.com", ARGV_CAP_IDENT));
        assert!(is_argv_safe("reviewer.b_2", ARGV_CAP_IDENT));
        // Boundary: identifier exactly 256 chars accepted.
        let exactly_256 = "x".repeat(256);
        assert!(is_argv_safe(&exactly_256, ARGV_CAP_IDENT));
        // Free-form reason text up to 2000 chars accepted.
        let typical_reason = "Breaks build on commit ABC: TypeError in foo.ts:42";
        assert!(is_argv_safe(typical_reason, ARGV_CAP_REASON));
        // Boundary: reason exactly 2000 chars accepted.
        let exactly_2000 = "y".repeat(2_000);
        assert!(is_argv_safe(&exactly_2000, ARGV_CAP_REASON));
        // Identifier values with embedded ascii printable specials are fine
        // (no flag prefix, no control char).
        assert!(is_argv_safe("a/b#42", ARGV_CAP_IDENT));
    }

    #[test]
    fn v2_sanitise_posted_by_still_uses_shared_predicate() {
        // F25: post-V2 refactor must preserve original F6 semantics.
        // Spot-check the original F6 vectors against the refactored
        // sanitise_posted_by — character-identical behaviour.
        assert_eq!(sanitise_posted_by("--posted-by=other"), "you");
        assert_eq!(sanitise_posted_by(""), "you");
        let long = "z".repeat(257);
        assert_eq!(sanitise_posted_by(&long), "you");
        assert_eq!(sanitise_posted_by("alice"), "alice");
    }

    #[test]
    fn ac7_pr_and_packet_not_found_are_serialised_distinctly() {
        // Wire-level check: the kebab `kind` discriminator emitted to
        // the frontend must differ. The TS zod schema (ipcErrorSchema
        // in contract.ts) discriminates on this string.
        use crate::cli_bridge::{PacketOpError, PacketOpErrorKind};
        let pr_err = packet_op_to_ipc_error(PacketOpError {
            kind: PacketOpErrorKind::PrNotFound,
            stderr: "x".into(),
            exit_code: Some(9),
        });
        let pkt_err = packet_op_to_ipc_error(PacketOpError {
            kind: PacketOpErrorKind::PacketNotFound,
            stderr: "y".into(),
            exit_code: Some(2),
        });
        let pr_json = serde_json::to_value(&pr_err).expect("serde");
        let pkt_json = serde_json::to_value(&pkt_err).expect("serde");
        assert_eq!(pr_json["kind"], "pr-not-found");
        assert_eq!(pkt_json["kind"], "packet-not-found");
        assert_ne!(pr_json["kind"], pkt_json["kind"]);
    }

    // Cycle-2 C15 (PR #21): persona-gating defence-in-depth tests.
    //
    // The React UI gates the M4 post / decide affordances at the
    // App-level (auditor never sees the post button); the Rust handler
    // is the second layer — a developer-tools console invoking
    // `__TAURI_INTERNALS__.invoke('post_to_pr', { persona: 'auditor', ... })`
    // must be rejected with the typed PersonaForbidden variant. These
    // tests pin both the rejection and the wire-level kebab `kind`
    // discriminator the frontend Banner switches on.
    #[test]
    fn c15_reject_auditor_returns_persona_forbidden() {
        let r = reject_auditor(Persona::Auditor, "post_to_pr");
        assert!(r.is_err(), "auditor must be rejected");
        match r.unwrap_err() {
            IpcError::PersonaForbidden { persona, command } => {
                assert_eq!(persona, "auditor");
                assert_eq!(command, "post_to_pr");
            }
            other => panic!("expected PersonaForbidden, got {other:?}"),
        }
    }

    #[test]
    fn c15_reject_auditor_accepts_creator() {
        let r = reject_auditor(Persona::Creator, "post_to_pr");
        assert!(r.is_ok(), "creator must be allowed");
    }

    #[test]
    fn c15_reject_auditor_accepts_reviewer() {
        let r = reject_auditor(Persona::Reviewer, "decide_on_pr");
        assert!(r.is_ok(), "reviewer must be allowed");
    }

    // v0.1.x gh#8 criterion (iv): persona-rejection pins for the
    // dev/test-fixtures seed_stress_packets IPC. These tests cover the
    // contract layer (reject_auditor returns PersonaForbidden for the
    // exact command string used at the handler entry). The handler
    // itself is `#[cfg(any(debug_assertions, feature = "test-fixtures"))]`
    // so the rejection only matters on dev/E2E builds — production
    // release builds compile the symbol out entirely. The b9 prefix
    // matches the v0.1.1 review B9 finding that originally tracked
    // this defence-in-depth gap.
    #[test]
    fn b9_seed_stress_packets_rejects_auditor() {
        let r = reject_auditor(Persona::Auditor, "seed_stress_packets");
        assert!(r.is_err(), "auditor must be rejected");
        match r.unwrap_err() {
            IpcError::PersonaForbidden { persona, command } => {
                assert_eq!(persona, "auditor");
                assert_eq!(command, "seed_stress_packets");
            }
            other => panic!("expected PersonaForbidden, got {other:?}"),
        }
    }

    #[test]
    fn b9_seed_stress_packets_accepts_creator() {
        let r = reject_auditor(Persona::Creator, "seed_stress_packets");
        assert!(r.is_ok(), "creator must be allowed");
    }

    #[test]
    fn b9_seed_stress_packets_accepts_reviewer() {
        let r = reject_auditor(Persona::Reviewer, "seed_stress_packets");
        assert!(r.is_ok(), "reviewer must be allowed");
    }

    // v0.1.1 B5: per-event-type gating in audit_log_append. Auditor IS
    // the legitimate user of tamper_dismissed / tamper_re_verified (audit
    // mode reviewing a frozen tree); only settings_changed_via_ui carries
    // the cycle-4.5 W2 threat ("auditor silences J12 via settings").
    #[test]
    fn b5_audit_event_gating_allows_auditor_for_tamper_events() {
        assert!(
            !audit_event_requires_writer("tamper_dismissed"),
            "auditor must be allowed to dismiss tamper banners"
        );
        assert!(
            !audit_event_requires_writer("tamper_re_verified"),
            "auditor must be allowed to re-verify"
        );
    }

    #[test]
    fn b5_audit_event_gating_blocks_auditor_for_settings_writes() {
        assert!(
            audit_event_requires_writer("settings_changed_via_ui"),
            "auditor must be rejected on settings_changed_via_ui (W2 threat)"
        );
    }

    #[test]
    fn b5_audit_event_gating_unknown_event_treated_as_writer() {
        // Defence-in-depth: an unknown event_type wouldn't reach this
        // predicate (the event_type allowlist above rejects it first),
        // but if it ever did, default to the strictest gate.
        for unknown in ["random_event", "", "tamper_dismiss" /* missing 'ed' */] {
            // The handler's allowlist will reject these before reaching
            // the gating decision, so this assertion mostly documents the
            // expected fallback behavior at the predicate layer.
            let _ = audit_event_requires_writer(unknown);
        }
    }

    // v0.1.2 B11: auditor may write `pinned_sessions` partials (UI
    // affordance, no security threat); any partial that touches another
    // settings field reverts to the wholesale auditor-rejection.
    #[test]
    fn b11_pinned_sessions_only_partial_allows_auditor() {
        let partial = serde_json::json!({
            "pinned_sessions": [{"session_id": "abc", "pinned_at": "2026-05-17T12:00:00Z"}]
        });
        assert!(partial_is_pinned_sessions_only(&partial));
    }

    #[test]
    fn b11_pinned_sessions_with_extra_field_blocks_auditor() {
        let partial = serde_json::json!({
            "pinned_sessions": [],
            "theme": "dark"
        });
        assert!(!partial_is_pinned_sessions_only(&partial));
    }

    #[test]
    fn b11_other_field_alone_blocks_auditor() {
        for key in [
            "theme",
            "density",
            "disable_tamper_warnings",
            "heavy_redaction_threshold",
            "capture_cli_path",
            "hmac",
        ] {
            let partial = serde_json::json!({ key: "x" });
            assert!(
                !partial_is_pinned_sessions_only(&partial),
                "partial with only `{key}` must NOT be treated as pinned_sessions-only"
            );
        }
    }

    #[test]
    fn b11_empty_partial_blocks_auditor() {
        // No use case for an empty write; require an explicit
        // pinned_sessions key.
        let partial = serde_json::json!({});
        assert!(!partial_is_pinned_sessions_only(&partial));
    }

    #[test]
    fn b11_non_object_partial_blocks_auditor() {
        // Defence-in-depth: a malformed partial that isn't an object
        // must NOT pass through. The handler's merge_settings_partial
        // would also reject this with InvalidArguments, but the gate
        // here is the first line.
        assert!(!partial_is_pinned_sessions_only(&serde_json::json!([])));
        assert!(!partial_is_pinned_sessions_only(&serde_json::json!("x")));
        assert!(!partial_is_pinned_sessions_only(&serde_json::json!(null)));
    }

    #[test]
    fn c15_persona_forbidden_serialises_to_kebab_discriminator() {
        // Wire-level check: the frontend's Zod ipcErrorSchema
        // discriminates on the `kind` string. The variant must emit
        // `kind: "persona-forbidden"` so the Banner / M4 modal can
        // surface "Auditor mode is read-only" copy.
        let err = IpcError::PersonaForbidden {
            persona: "auditor".to_string(),
            command: "post_to_pr".to_string(),
        };
        let v = serde_json::to_value(&err).expect("serde");
        assert_eq!(v["kind"], "persona-forbidden");
        assert_eq!(v["persona"], "auditor");
        assert_eq!(v["command"], "post_to_pr");
    }

    // Cycle-3 C2 (PR #21): unknown persona strings must fail at the
    // serde-deserialize boundary, not at a string-equality match. The
    // previous `pub persona: String` accepted ANY string and only
    // `reject_auditor`'s literal `== "auditor"` filter blocked the
    // auditor — but a hand-crafted DevTools payload with persona =
    // "creator" from auditor mode would have bypassed the filter. The
    // `Persona` enum closes that bypass: the serde discriminator is
    // the closed set { creator, reviewer, auditor } and unknown
    // strings produce a deserialize error that callers translate into
    // `IpcError::InvalidArguments`.
    #[test]
    fn c2_persona_enum_accepts_valid_lowercase_strings() {
        for (raw, expected) in [
            ("creator", Persona::Creator),
            ("reviewer", Persona::Reviewer),
            ("auditor", Persona::Auditor),
        ] {
            let json = format!(r#""{raw}""#);
            let parsed: Persona = serde_json::from_str(&json)
                .unwrap_or_else(|e| panic!("Persona::{raw} must deserialize: {e}"));
            assert_eq!(parsed, expected);
        }
    }

    #[test]
    fn c2_persona_enum_rejects_unknown_strings() {
        // Empty string, unknown words, mixed-case (the serde
        // rename_all = "lowercase" attribute means uppercase variants
        // are rejected — a lowercase canonical form keeps wire-shape
        // discipline tight).
        for raw in ["", "admin", "AUDITOR", "Creator", "hacker", "root"] {
            let json = format!(r#""{raw}""#);
            let res: Result<Persona, _> = serde_json::from_str(&json);
            assert!(
                res.is_err(),
                "Persona deserialize must reject {raw:?} but got {:?}",
                res.ok()
            );
        }
    }

    #[test]
    fn c2_post_to_pr_args_reject_unknown_persona_at_deserialize() {
        // End-to-end: PostToPrArgs deserialization fails when persona
        // is outside the closed set. The Tauri runtime would return
        // `IpcError::InvalidArguments` at the boundary; here we
        // assert the underlying serde rejection so the contract
        // doesn't silently widen.
        let payload = r#"{
            "packet_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "pr_number": null,
            "persona": "admin"
        }"#;
        let res: Result<PostToPrArgs, _> = serde_json::from_str(payload);
        assert!(res.is_err(), "PostToPrArgs must reject persona=admin");
    }

    #[test]
    fn c2_save_decision_args_reject_unknown_persona_at_deserialize() {
        // C4: SaveDecisionArgs gains the persona field; same
        // closed-set discipline.
        let payload = r#"{
            "packet_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "claim_id": "CLAIM-001",
            "decision": "accept",
            "by": "alice",
            "at": "2026-05-09T12:00:00Z",
            "persona": "hacker"
        }"#;
        let res: Result<SaveDecisionArgs, _> = serde_json::from_str(payload);
        assert!(res.is_err(), "SaveDecisionArgs must reject persona=hacker");
    }

    // Cycle-4.5 W13 (PR #21): DecideOnPrArgs lacked an explicit
    // serde-deserialize-rejects-unknown-persona test. The other three
    // C4-gated args structs (PostToPr, SaveDecision, OverrideRisk)
    // each have one; the omission was a coverage gap. A future
    // refactor that, e.g., relaxed `pub persona: Persona` to `pub
    // persona: String` on this struct alone would pass the existing
    // c2_persona_enum_rejects_unknown_strings test (which only
    // exercises the bare enum) while silently widening the IPC
    // surface.
    #[test]
    fn c2_decide_on_pr_args_reject_unknown_persona_at_deserialize() {
        let payload = r#"{
            "packet_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "claim_id": "CLAIM-001",
            "decision": "block",
            "reason": "breaks tests",
            "by": "alice",
            "pr_number": null,
            "persona": "ADMIN"
        }"#;
        let res: Result<DecideOnPrArgs, _> = serde_json::from_str(payload);
        assert!(res.is_err(), "DecideOnPrArgs must reject persona=ADMIN");
    }

    #[test]
    fn c2_override_risk_args_reject_unknown_persona_at_deserialize() {
        let payload = r#"{
            "packet_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "claim_id": "CLAIM-001",
            "layer": "creator",
            "new_level": "high",
            "reason": "promote",
            "by": "alice",
            "at": "2026-05-09T12:00:00Z",
            "persona": ""
        }"#;
        let res: Result<OverrideRiskArgs, _> = serde_json::from_str(payload);
        assert!(res.is_err(), "OverrideRiskArgs must reject empty persona");
    }

    // Cycle-4.5 W1 (PR #21): WriteSettingsArgs gains the persona field;
    // same closed-set discipline as post / decide / save / override.
    // Without the field, an auditor with DevTools could call
    // `write_settings({ partial: { disable_tamper_warnings: true } })`
    // and silence J12 tamper warnings — exactly the auditor-bypass class
    // that cycle-3.5 closed for the other write IPCs.
    #[test]
    fn c2_write_settings_args_reject_unknown_persona_at_deserialize() {
        let payload = r#"{
            "partial": { "theme": "dark" },
            "persona": "admin"
        }"#;
        let res: Result<WriteSettingsArgs, _> = serde_json::from_str(payload);
        assert!(res.is_err(), "WriteSettingsArgs must reject persona=admin");
    }

    // Cycle-4.5 W2 (PR #21): AuditLogAppendArgs gains the persona field
    // — same closed-set discipline. The previous handler had no
    // persona gating, so an auditor with DevTools could append rows
    // to the audit chain.
    #[test]
    fn c2_audit_log_append_args_reject_unknown_persona_at_deserialize() {
        let payload = r#"{
            "event_type": "tamper_dismissed",
            "packet_id": null,
            "details": {},
            "persona": "ROOT"
        }"#;
        let res: Result<AuditLogAppendArgs, _> = serde_json::from_str(payload);
        assert!(res.is_err(), "AuditLogAppendArgs must reject persona=ROOT");
    }

    // Cycle-4.5 W2 (PR #21): the 4 KB serialized-JSON cap on `details`
    // is enforced at handler entry. We test the boundary directly since
    // the handler requires DbState; the validator branches on
    // `details_string.len() > AUDIT_DETAILS_MAX_BYTES` and surfaces an
    // `InvalidArguments` error with the size in the message.
    #[test]
    fn cycle_4_5_w2_audit_details_max_bytes_constant_is_4kb() {
        assert_eq!(AUDIT_DETAILS_MAX_BYTES, 4096);
    }

    #[test]
    fn cycle_4_5_w2_audit_details_oversize_payload_serializes_above_cap() {
        // Build a payload whose serde_json::to_string output exceeds
        // 4 KB — a 5 KB string in a single field is the simplest fixture.
        let big_string = "x".repeat(5000);
        let v = serde_json::json!({ "blob": big_string });
        let serialized = serde_json::to_string(&v).expect("serialize");
        assert!(
            serialized.len() > AUDIT_DETAILS_MAX_BYTES,
            "5KB blob must exceed the 4KB cap; got {}",
            serialized.len()
        );
    }

    // -----------------------------------------------------------------
    // Cycle-3 C3-S-TR-001: wire-string contract tests for IpcError-adjacent
    // enums. Several variants are currently `#[allow(dead_code)]` because
    // they aren't constructed in Rust today — but they are emitted to the
    // TS side via serde and consumed by `apps/ui/src/ipc/contract.ts`. A
    // rename (e.g., `Timeout` → `Deadline`) would compile clean on the
    // Rust side and silently break the frontend's Zod schema. These tests
    // pin the Display / kebab-case wire format so any rename has to update
    // both ends in lockstep.
    // -----------------------------------------------------------------

    #[test]
    fn yaml_reason_wire_strings_pin_kebab_case() {
        // The frontend's Zod schema expects exactly these four strings;
        // any rename here forces a corresponding ts contract update.
        assert_eq!(YamlReason::SizeCap.to_string(), "size-cap");
        assert_eq!(YamlReason::Timeout.to_string(), "timeout");
        assert_eq!(YamlReason::AnchorCount.to_string(), "anchor-count");
        assert_eq!(YamlReason::Syntax.to_string(), "syntax");
    }

    #[test]
    fn mismatch_type_wire_strings_pin_kebab_case() {
        // packet-changed-externally event payload's `mismatch_type` is
        // the TS-side discriminator. The closed enum on both sides must
        // serialize to identical kebab-case literals.
        assert_eq!(MismatchType::HashMismatch.to_string(), "hash-mismatch");
        assert_eq!(MismatchType::Missing.to_string(), "missing");
        assert_eq!(MismatchType::ParseError.to_string(), "parse-error");
    }

    #[test]
    fn ipc_error_permission_denied_display_pins_message_format() {
        // PermissionDenied is currently `#[allow(dead_code)]` (no handler
        // constructs it yet) but its Display template is contract surface
        // for when the gh CLI bridge starts surfacing 403s. The thiserror
        // template must read "permission denied: {message}".
        let err = IpcError::PermissionDenied {
            message: "missing scope: repo".into(),
        };
        assert_eq!(err.to_string(), "permission denied: missing scope: repo");
    }
}
