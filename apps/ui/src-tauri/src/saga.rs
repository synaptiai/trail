//! P2 atomic-write saga (B5 §3).
//!
//! The saga's order is intentional (B5 §3.1): YAML write happens BEFORE the
//! libSQL TX so YAML stays canonical even if the TX is interrupted. An
//! intent-log marker file (`.trail/sessions/<sid>/.pending-<txn>.json`) lets
//! the backend recover from a SIGKILL between rename (step 6) and TX commit
//! (step 8).
//!
//! Sprint 1 shipped the marker primitives in isolation; Sprint 4 lands the
//! full driver (`SagaDriver::run_decision_saga`) plus the boot-time recovery
//! scan (`recover_pending_sagas`).
//!
//! The saga steps (B5 §3.1 verbatim, mapped to method names):
//!
//!   1. UI: optimistic React state update (out of saga scope; happens in TS)
//!   2. Backend: read current packet.yml from disk    (`read_packet_yaml`)
//!   3. Backend: compute new YAML with decision applied
//!                                                    (`apply_decision_to_yaml`)
//!   4. Backend: validate new YAML against schema     (`validate_after_mutation`)
//!   4a.Backend: write intent-log marker              (`write_marker`)
//!   5. Backend: write packet.yml.tmp + fsync         (`atomic_write`)
//!   6. Backend: atomic rename tmp → packet.yml       (`atomic_write` continues)
//!   6a.Backend: update marker stage = 'pre-libsql'   (`advance_marker`)
//!   7. Backend: compute sha256(approval_trail block) (`compute_approval_hash`)
//!   8. Backend: BEGIN libSQL TX + commit             (`commit_to_libsql`)
//!   8a.Backend: delete intent-log marker             (`delete_marker`)
//!   9. Backend: emit IPC `decision-saved` to UI      (caller's responsibility)

use crate::watcher::SagaInFlightRegistry;
use crate::yaml_safety;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, SystemTimeError, UNIX_EPOCH};
use thiserror::Error;
use tracing::{error, info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SagaStage {
    /// Marker exists; YAML rename has not yet been attempted.
    PreRename,
    /// YAML rename succeeded; libSQL TX has not committed.
    PreLibsql,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentLogMarker {
    pub txn_id: String,
    pub packet_id: String,
    pub expected_yaml_hash: Option<String>,
    pub stage: SagaStage,
    /// Absolute path to the packet YAML the saga is mutating. Recorded so
    /// boot-time recovery can locate the file without re-querying libSQL
    /// (libSQL may also be stale at recovery time).
    pub yaml_path: String,
    /// Unix epoch milliseconds at marker creation; markers older than 1h are
    /// treated as unrecoverable per B5 §3.1.
    pub created_at_ms: u64,
}

/// Per PR #6 cycle-1 review F6 (P2 correctness unchallenged):
///
/// Clock-fallback to 0 was unsafe: a system clock set before 1970 (test envs,
/// timezone misconfigurations, embedded boards) caused `now_ms()` to return
/// 0, which made every existing marker look 56-year-stale on startup —
/// silently aborting valid in-flight sagas. Stale-detection is a security
/// primitive (an incomplete saga can leave YAML inconsistent with libSQL).
///
/// New behavior: `now_ms()` returns `Result<u64, ClockError>`. The saga
/// driver propagates the error explicitly; `IntentLogMarker::new` takes a
/// pre-computed timestamp so the boundary is forced at the call-site that
/// owns clock-anomaly handling. `is_stale` accepts `Option<u64>`: when the
/// clock is unreadable, NO marker is treated as stale (the safer side —
/// false negative = saga retries; false positive = silent abort of valid
/// work).
#[derive(Debug, Error)]
pub enum ClockError {
    #[error("system clock is before unix epoch: {0}")]
    BeforeEpoch(#[from] SystemTimeError),
}

impl IntentLogMarker {
    /// Construct a marker pinned at `created_at_ms`. Callers MUST pass a
    /// timestamp that came from `now_ms()`; constructing markers with a
    /// derived timestamp is an error (use `new_with_timestamp` for that).
    pub fn new(
        packet_id: impl Into<String>,
        txn_id: impl Into<String>,
        yaml_path: impl Into<String>,
    ) -> Result<Self, ClockError> {
        let created_at_ms = now_ms()?;
        Ok(Self::new_with_timestamp(
            packet_id,
            txn_id,
            yaml_path,
            created_at_ms,
        ))
    }

    /// Test-only constructor for deterministic timestamps. Production code
    /// should use `new()` so the clock-anomaly path is exercised.
    pub fn new_with_timestamp(
        packet_id: impl Into<String>,
        txn_id: impl Into<String>,
        yaml_path: impl Into<String>,
        created_at_ms: u64,
    ) -> Self {
        Self {
            txn_id: txn_id.into(),
            packet_id: packet_id.into(),
            expected_yaml_hash: None,
            stage: SagaStage::PreRename,
            yaml_path: yaml_path.into(),
            created_at_ms,
        }
    }

    pub fn advance_to_pre_libsql(&mut self, expected_yaml_hash: impl Into<String>) {
        self.expected_yaml_hash = Some(expected_yaml_hash.into());
        self.stage = SagaStage::PreLibsql;
    }

    /// Markers older than this are dropped on startup (per B5 §3.1).
    pub const STALE_MS: u64 = 60 * 60 * 1_000;

    /// Returns true ONLY when the now-timestamp is readable AND exceeds the
    /// staleness window. When the clock is unreadable (`None`), no marker
    /// is treated as stale — the saga retries are safer than silent abort.
    pub fn is_stale(&self, now_ms_value: Option<u64>) -> bool {
        match now_ms_value {
            Some(now) => now.saturating_sub(self.created_at_ms) > Self::STALE_MS,
            None => false,
        }
    }
}

/// Returns the current Unix-epoch milliseconds, propagating clock anomalies
/// instead of silently flooring to 0.
pub fn now_ms() -> Result<u64, ClockError> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH)?;
    Ok(elapsed.as_millis() as u64)
}

// ---------------------------------------------------------------------------
// Saga input shapes
// ---------------------------------------------------------------------------

/// One decision to apply to the packet's `approval_trail[]`. Mirrors the
/// schema's `$defs/approval_trail_entry` shape and the TS-side
/// `ApprovalTrailEntry` type in capture/src/packet/types.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecisionEntry {
    pub claim_id: String,
    pub decision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub by: String,
    pub at: String,
}

/// One creator/reviewer risk override applied to a claim. The saga writes
/// the override into the packet's `summary.claims[].risk_*_creator_override`
/// or `risk_*_reviewer_override` fields and, in the libSQL TX, updates the
/// matching column on `claims`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskOverride {
    pub claim_id: String,
    pub layer: RiskLayer,
    pub new_level: String,
    pub reason: String,
    pub by: String,
    pub at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RiskLayer {
    Creator,
    Reviewer,
}

/// What the saga is being asked to do. Captured in one enum so the driver
/// has a single pre-condition + step ordering for both decision-record and
/// risk-override paths.
#[derive(Debug, Clone)]
pub enum SagaInput {
    /// Append `entry` to packet.approval_trail[] (B4 §6 / J9).
    AppendDecision(DecisionEntry),
    /// Write a risk override on a single claim.
    SetRiskOverride(RiskOverride),
}

// ---------------------------------------------------------------------------
// Saga errors
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum SagaError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("clock: {0}")]
    Clock(#[from] ClockError),
    #[error("yaml parse: {0}")]
    YamlParse(String),
    #[error("yaml serialize: {0}")]
    YamlSerialize(String),
    /// The mutation's pre-condition was violated (e.g., claim_id not in
    /// packet). Surfaced as `IpcError::InvalidArguments` upstream.
    #[error("invalid mutation: {0}")]
    InvalidMutation(String),
    /// Strict-redaction gate fired — Layer 2 scan found a pattern in the
    /// post-mutation YAML. Surfaced as `IpcError::Internal` upstream with
    /// the offending pattern names so the operator can investigate.
    #[error("strict-redaction-gate: {0}")]
    StrictRedaction(String),
    #[error("sql: {0}")]
    Sql(#[from] rusqlite::Error),
    /// A marker exists but the recovery path could not resolve it cleanly.
    /// Surfaced via the audit log; the desktop continues to boot.
    #[error("recovery: {0}")]
    Recovery(String),
}

// ---------------------------------------------------------------------------
// Saga driver
// ---------------------------------------------------------------------------

/// Compute sha256 hex of an arbitrary string. Used for both the
/// `expected_yaml_hash` (full file) and `last_known_hash`
/// (approval_trail block).
fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    hex_lower(&digest)
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Locate the per-session intent-log directory for a given packet YAML.
/// Per B5 §3.1, the marker lives next to the packet under
/// `.trail/sessions/<sid>/.pending-<txn>.json`. We co-locate it with the
/// packet rather than under a global `.trail/.intent-log/` so a copied or
/// moved session takes its pending markers with it.
fn marker_path(yaml_path: &Path, txn_id: &str) -> PathBuf {
    let parent = yaml_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    parent.join(format!(".pending-{txn_id}.json"))
}

/// Layer 2 hit — mirrors the Phase 1 `RedactionValidationError` shape at
/// `apps/capture/src/packet/types.ts` (cycle-1.5 F6 fix; F25 character-
/// for-character port). `pattern` is the named pattern; `snippet` is
/// `sha256(match)[:8]` so the strict-redaction-gate decision carries
/// forensic evidence of WHICH text matched without exposing the
/// original content in the saga error chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layer2Hit {
    pub pattern: String,
    pub snippet: String,
}

/// 8-hex-char (4-byte) prefix of sha256(match). Matches the TS
/// `snippetHash` at apps/capture/src/redaction/layer2.ts:11-13.
fn snippet_hash(match_text: &str) -> String {
    let mut hex = String::with_capacity(8);
    let full = sha256_hex(match_text);
    hex.push_str(&full[..8]);
    hex
}

/// Strict-redaction gate. Layer 2 of the redaction defense (B5 §3.1 step 3-4):
/// scan the SERIALIZED YAML for any pattern in the supplied set. If any
/// match, abort the saga before writing to disk.
///
/// `patterns` is supplied by the caller so test fixtures can use a small
/// set; production wires this from `bin/trail-redaction-patterns.yml`
/// loaded once at boot.
///
/// **Cycle-1.5 F6 fix**: returns `Vec<Layer2Hit>` (with snippet hash)
/// instead of `Vec<String>` so an aborted saga's forensic evidence
/// matches the Phase 1 capture-side contract. This is the F25 spec-port
/// drift cycle-1 review F6 called out — Phase 1 records
/// `{pattern, snippet}`, Rust now does too.
pub fn layer2_scan(
    serialized_yaml: &str,
    patterns: &[(String, regex::Regex)],
) -> Vec<Layer2Hit> {
    // Match the JS Layer 2 contract: strip existing `[REDACTED:...]` markers
    // before scanning so a re-emission of an already-redacted value does
    // not trip the gate.
    let scrubbed = redaction_marker_re()
        .replace_all(serialized_yaml, "")
        .into_owned();
    let mut hits = Vec::new();
    for (name, regex) in patterns {
        if let Some(m) = regex.find(&scrubbed) {
            hits.push(Layer2Hit {
                pattern: name.clone(),
                snippet: snippet_hash(m.as_str()),
            });
        }
    }
    hits
}

// Process-static regex; compiled once. `OnceLock` is in stdlib since 1.70.
static REDACTION_MARKER_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
fn redaction_marker_re() -> &'static regex::Regex {
    REDACTION_MARKER_RE.get_or_init(|| {
        regex::Regex::new(r"\[REDACTED:[a-z0-9-]+\]").expect("static regex must compile")
    })
}

/// Compute the canonical approval_trail block hash used by the watcher
/// self-race + tamper detection contract (B5 §4.2). The hash covers ONLY
/// the approval_trail block (not the full file), so re-rendering of the
/// markdown sibling, comment additions outside approval_trail, etc. do not
/// trip J12.
///
/// **Cross-language hash constraint (cycle-1 review F5).** The serializer
/// flavor matters: this function uses `serde_yaml::to_string`, which has
/// subtle differences from `js-yaml.dump` (the capture CLI's serializer)
/// — quoting style of strings containing colons, scalar style for numbers,
/// indent width. **As long as the saga (Rust) is the SOLE writer of
/// approval_trail entries** the hash is internally consistent. If a
/// future code path appends approval_trail directly from the capture
/// CLI (TypeScript / js-yaml), this hash WILL diverge from the Rust
/// counterpart and produce false-positive J12 events.
///
/// The accompanying test `approval_trail_hash_pin` characterizes the
/// current serde_yaml output for a known fixture; a regression in
/// serde_yaml's serializer (or a port to a different YAML library)
/// surfaces here BEFORE the watcher silently starts mis-classifying
/// self-writes.
///
/// F25 lesson — port specs character-for-character. If TS-side
/// approval_trail writes are ever added, mirror this hash function in
/// TS (using a normalize-then-hash strategy: parse → re-emit via
/// `serde_yaml::to_string`-equivalent, then sha256 the bytes) and
/// pin the same fixture in both languages.
pub fn compute_approval_trail_hash(yaml_value: &serde_yaml::Value) -> String {
    let block = yaml_value
        .get("approval_trail")
        .cloned()
        .unwrap_or(serde_yaml::Value::Sequence(Vec::new()));
    // Serialize deterministically so the same logical block always hashes
    // to the same value. serde_yaml's serializer is key-order-stable for a
    // given input; reading + re-serializing matches the saga's own write.
    let serialized = serde_yaml::to_string(&block).unwrap_or_default();
    sha256_hex(&serialized)
}

/// Append `entry` to `packet.approval_trail[]`. Creates the array if missing.
/// Does NOT mutate any other fields. Mirrors the capture-side
/// `appendApprovalTrail` helper at apps/capture/src/post/posted-to-pr.ts.
fn apply_decision_mutation(
    packet: &mut serde_yaml::Value,
    entry: &DecisionEntry,
) -> Result<(), SagaError> {
    let map = packet.as_mapping_mut().ok_or_else(|| {
        SagaError::InvalidMutation("packet root is not a YAML mapping".into())
    })?;
    let key = serde_yaml::Value::String("approval_trail".into());
    let arr = map
        .entry(key)
        .or_insert_with(|| serde_yaml::Value::Sequence(Vec::new()));
    let seq = arr.as_sequence_mut().ok_or_else(|| {
        SagaError::InvalidMutation(
            "approval_trail exists but is not a sequence".into(),
        )
    })?;
    let entry_value = serde_yaml::to_value(entry).map_err(|e| {
        SagaError::YamlSerialize(format!("approval_trail entry: {e}"))
    })?;
    seq.push(entry_value);
    Ok(())
}

/// Write a risk-override under `summary.claims[].risk_*_<layer>_override*`.
/// Returns Err(InvalidMutation) when the claim_id does not resolve to any
/// claim (matches by both `id` and `stable_id`).
fn apply_risk_override_mutation(
    packet: &mut serde_yaml::Value,
    ov: &RiskOverride,
) -> Result<(), SagaError> {
    let summary = packet
        .get_mut("summary")
        .ok_or_else(|| SagaError::InvalidMutation("packet.summary missing".into()))?;
    let claims = summary
        .get_mut("claims")
        .ok_or_else(|| {
            SagaError::InvalidMutation("packet.summary.claims missing".into())
        })?
        .as_sequence_mut()
        .ok_or_else(|| {
            SagaError::InvalidMutation(
                "packet.summary.claims is not a sequence".into(),
            )
        })?;

    let target = claims.iter_mut().find(|c| {
        let id_match = c.get("id").and_then(|v| v.as_str()) == Some(&ov.claim_id);
        let stable_match =
            c.get("stable_id").and_then(|v| v.as_str()) == Some(&ov.claim_id);
        id_match || stable_match
    });
    let claim = target.ok_or_else(|| {
        SagaError::InvalidMutation(format!(
            "claim_id '{}' not found in packet.summary.claims",
            ov.claim_id
        ))
    })?;
    let claim_map = claim.as_mapping_mut().ok_or_else(|| {
        SagaError::InvalidMutation("claim entry is not a mapping".into())
    })?;
    let prefix = match ov.layer {
        RiskLayer::Creator => "creator",
        RiskLayer::Reviewer => "reviewer",
    };
    claim_map.insert(
        serde_yaml::Value::String(format!("risk_level_{prefix}_override")),
        serde_yaml::Value::String(ov.new_level.clone()),
    );
    claim_map.insert(
        serde_yaml::Value::String(format!("risk_reason_{prefix}_override")),
        serde_yaml::Value::String(ov.reason.clone()),
    );
    claim_map.insert(
        serde_yaml::Value::String(format!("risk_{prefix}_override_at")),
        serde_yaml::Value::String(ov.at.clone()),
    );
    claim_map.insert(
        serde_yaml::Value::String(format!("risk_{prefix}_override_by")),
        serde_yaml::Value::String(ov.by.clone()),
    );
    Ok(())
}

/// Driver state held by the Tauri State container. One instance per
/// process; the driver is `Send + Sync` because all mutable state lives in
/// the libSQL `Connection` (passed in per call) and the
/// `SagaInFlightRegistry` (which is itself `Send + Sync`).
pub struct SagaDriver {
    /// Layer 2 redaction patterns loaded once at boot. Empty in tests that
    /// only exercise the mutation + atomic-write path.
    pub layer2_patterns: Vec<(String, regex::Regex)>,
}

impl SagaDriver {
    pub fn new(layer2_patterns: Vec<(String, regex::Regex)>) -> Self {
        Self { layer2_patterns }
    }

    /// Run the full saga for a single mutation against `yaml_path`. The
    /// caller MUST hold the appropriate per-packet lock + libSQL connection.
    /// On success, returns the new approval_trail hash so the watcher
    /// self-race contract can ignore the upcoming filesystem event.
    pub fn run_decision_saga(
        &self,
        packet_id: &str,
        yaml_path: &Path,
        input: &SagaInput,
        registry: &SagaInFlightRegistry,
        conn: &mut Connection,
    ) -> Result<SagaSuccess, SagaError> {
        registry.mark(packet_id);
        let result = self.run_inner(packet_id, yaml_path, input, conn);
        registry.clear(packet_id);
        // Cycle-1.5 F11 (P3): on ClockError abort, attempt to record an
        // audit_log row so an auditor can correlate "user closed Trail
        // before retry" with "decision never landed". The audit write
        // is best-effort: chrono::Utc::now() also depends on the
        // system clock, so we tolerate failure (the tracing log
        // captures the event regardless).
        if let Err(SagaError::Clock(ref clock_err)) = result {
            let detail = format!(
                "{{\"packet_id\":\"{}\",\"reason\":\"{}\"}}",
                packet_id,
                clock_err.to_string().replace('"', "'")
            );
            if let Err(e) = crate::db::append_audit_log(
                conn,
                "saga_aborted_clock_anomaly",
                Some(packet_id),
                &detail,
            ) {
                warn!(
                    target: "trail::saga",
                    packet_id = %packet_id,
                    error = %e,
                    "best-effort audit log write failed for ClockError abort"
                );
            }
        }
        result
    }

    fn run_inner(
        &self,
        packet_id: &str,
        yaml_path: &Path,
        input: &SagaInput,
        conn: &mut Connection,
    ) -> Result<SagaSuccess, SagaError> {
        // Step 2: read packet YAML.
        let original_text = fs::read_to_string(yaml_path)?;

        // Cycle-3 C3-S-SEC-4: gate the parse on yaml_safety's size + anchor
        // checks (B5 §6.5). The packet YAML lives in the user's
        // .trail/sessions/ tree and is generated by the capture CLI under
        // normal use, but the watcher monitors the directory for external
        // edits and the IPC layer could be reached by a renderer with
        // DevTools access — so the parse path must tolerate hostile input.
        // Without these gates a billion-laughs / oversize attack would
        // fork-bomb the desktop process. The yaml_safety module shipped
        // dormant in cycle-1.5; wiring it here closes the v0.1.0 defense
        // gap rather than carrying it forward to v0.1.x.
        yaml_safety::check_size(original_text.as_bytes()).map_err(|e| match e {
            yaml_safety::YamlSafetyError::SizeCap { actual } => SagaError::YamlParse(format!(
                "yaml safety: size cap exceeded ({} bytes > {} max)",
                actual,
                yaml_safety::MAX_BYTES
            )),
            yaml_safety::YamlSafetyError::AnchorCount { actual } => SagaError::YamlParse(format!(
                "yaml safety: anchor count exceeded ({} > {} max)",
                actual,
                yaml_safety::MAX_ANCHORS
            )),
        })?;
        yaml_safety::check_anchor_count(&original_text).map_err(|e| match e {
            yaml_safety::YamlSafetyError::SizeCap { actual } => SagaError::YamlParse(format!(
                "yaml safety: size cap exceeded ({} bytes > {} max)",
                actual,
                yaml_safety::MAX_BYTES
            )),
            yaml_safety::YamlSafetyError::AnchorCount { actual } => SagaError::YamlParse(format!(
                "yaml safety: anchor count exceeded ({} > {} max)",
                actual,
                yaml_safety::MAX_ANCHORS
            )),
        })?;

        // Step 3: parse + mutate in-memory.
        let mut value: serde_yaml::Value = serde_yaml::from_str(&original_text)
            .map_err(|e| SagaError::YamlParse(e.to_string()))?;
        match input {
            SagaInput::AppendDecision(e) => apply_decision_mutation(&mut value, e)?,
            SagaInput::SetRiskOverride(o) => apply_risk_override_mutation(&mut value, o)?,
        }
        // Step 3 cont: serialize back to YAML.
        let new_yaml = serde_yaml::to_string(&value)
            .map_err(|e| SagaError::YamlSerialize(e.to_string()))?;
        // Step 4: strict-redaction gate. Empty patterns set = pass-through
        // (used by tests that don't need to exercise the gate).
        let scan_hits = layer2_scan(&new_yaml, &self.layer2_patterns);
        if !scan_hits.is_empty() {
            // Cycle-1.5 F6: surface `pattern@snippet` pairs in the
            // SagaError message so an aborted saga's audit trail
            // carries the forensic evidence matching Phase 1's
            // RedactionValidationError shape. The snippet is a
            // sha256(match)[:8] hash, never the original text.
            let summary = scan_hits
                .iter()
                .map(|h| format!("{}@{}", h.pattern, h.snippet))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(SagaError::StrictRedaction(summary));
        }
        // Step 4a: write intent-log marker.
        //
        // txn_id uses a monotonic ULID — survives a clock fallback (where
        // now_ms() returns Err and we'd otherwise need a deterministic
        // fallback that risks marker-path collision on rapid repeat writes
        // for the same packet). ULID's monotonic generator includes a
        // crypto-random tail so two markers in the same millisecond do
        // not collide.
        let txn_id = ulid::Ulid::new().to_string();
        let marker_pth = marker_path(yaml_path, &txn_id);
        let marker = IntentLogMarker::new(
            packet_id,
            &txn_id,
            yaml_path.to_string_lossy().to_string(),
        )?;
        write_marker(&marker_pth, &marker)?;
        // Step 5: tmp write. Step 6: atomic rename.
        atomic_write(yaml_path, &new_yaml)?;
        // Step 6a: advance marker to pre-libsql.
        let mut marker = marker;
        let full_hash = sha256_hex(&new_yaml);
        marker.advance_to_pre_libsql(&full_hash);
        write_marker(&marker_pth, &marker)?;
        // Step 7: compute approval_trail hash.
        let approval_hash = compute_approval_trail_hash(&value);
        // Step 8: BEGIN IMMEDIATE libSQL TX.
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        match input {
            SagaInput::AppendDecision(e) => {
                let position: i64 = tx
                    .query_row(
                        "SELECT COALESCE(MAX(position), -1) + 1 FROM approval_trail WHERE packet_id = ?1",
                        [packet_id],
                        |row| row.get(0),
                    )?;
                tx.execute(
                    "INSERT INTO approval_trail (packet_id, claim_id, decision, reason, decided_by, decided_at, position) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        packet_id,
                        e.claim_id,
                        e.decision,
                        e.reason,
                        e.by,
                        e.at,
                        position
                    ],
                )?;
            }
            SagaInput::SetRiskOverride(o) => {
                let layer_col_prefix = match o.layer {
                    RiskLayer::Creator => "creator",
                    RiskLayer::Reviewer => "reviewer",
                };
                let sql = format!(
                    "UPDATE claims SET \
                       risk_level_{prefix}_override = ?1, \
                       risk_reason_{prefix}_override = ?2, \
                       risk_{prefix}_override_at = ?3, \
                       risk_{prefix}_override_by = ?4 \
                     WHERE claim_id = ?5",
                    prefix = layer_col_prefix
                );
                tx.execute(
                    &sql,
                    rusqlite::params![o.new_level, o.reason, o.at, o.by, o.claim_id],
                )?;
            }
        }
        tx.execute(
            "UPDATE packets SET last_known_hash = ?1, libsql_dirty = 0, updated_at = datetime('now') \
             WHERE packet_id = ?2",
            rusqlite::params![approval_hash, packet_id],
        )?;
        tx.commit()?;
        // Step 8a: delete marker.
        delete_marker_if_present(&marker_pth);
        Ok(SagaSuccess {
            packet_id: packet_id.into(),
            new_approval_hash: approval_hash,
            new_full_hash: full_hash,
        })
    }
}

/// Saga-success metadata: emitted by the driver, currently only inspected
/// in tests / via logs (callers consume the saga's side-effects, not its
/// return value). Wiring the fields into an IPC success payload lands in
/// v0.1.x (Phase 4 cycle-1 review F2-19).
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct SagaSuccess {
    pub packet_id: String,
    pub new_approval_hash: String,
    pub new_full_hash: String,
}

// ---------------------------------------------------------------------------
// Atomic write — tmp+rename. Mirrors apps/capture/src/io/atomic.ts contract.
// ---------------------------------------------------------------------------

/// Write `contents` atomically to `final_path` via `<final>.tmp` + fsync +
/// rename. On any error, removes the tmp file and propagates. POSIX-rename
/// guarantees atomicity for same-filesystem renames.
pub fn atomic_write(final_path: &Path, contents: &str) -> Result<(), SagaError> {
    let mut tmp = final_path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp_path = PathBuf::from(tmp);
    // RAII cleanup: if anything below errors, the Drop impl removes tmp.
    let _guard = TmpCleanup {
        path: tmp_path.clone(),
        armed: std::cell::Cell::new(true),
    };
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp_path)?;
        use std::io::Write;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        // file dropped here, releasing handle before rename.
    }
    fs::rename(&tmp_path, final_path)?;
    _guard.armed.set(false);
    Ok(())
}

struct TmpCleanup {
    path: PathBuf,
    armed: std::cell::Cell<bool>,
}
impl Drop for TmpCleanup {
    fn drop(&mut self) {
        if self.armed.get() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

// ---------------------------------------------------------------------------
// Intent-log marker I/O
// ---------------------------------------------------------------------------

fn write_marker(path: &Path, marker: &IntentLogMarker) -> Result<(), SagaError> {
    let json = serde_json::to_string(marker)
        .map_err(|e| SagaError::YamlSerialize(format!("marker json: {e}")))?;
    // Marker writes are best-effort atomic via tmp+rename — the same
    // primitive as the YAML write so a SIGKILL during marker write does
    // not leave a corrupted JSON document on disk.
    atomic_write(path, &json)
}

fn delete_marker_if_present(path: &Path) {
    if let Err(e) = fs::remove_file(path) {
        if e.kind() != io::ErrorKind::NotFound {
            warn!(target: "trail::saga", path = %path.display(), error = %e, "failed to remove intent-log marker");
        }
    }
}

// ---------------------------------------------------------------------------
// Boot-time recovery — scans for orphaned markers and resolves them.
// ---------------------------------------------------------------------------

/// Scan a `.trail/sessions/` tree for orphaned `.pending-<txn>.json` markers
/// and resolve each per B5 §3.1:
///
///   - stage='pre-libsql' AND on-disk YAML hash matches `expected_yaml_hash`:
///       rebuild_libsql_for_packet (caller-supplied) + delete marker.
///       NO J12 fired — this was a crashed self-write.
///   - stage='pre-rename' AND no packet.yml has the new content:
///       delete the orphaned `.tmp` (if any) + delete marker. Decision lost.
///   - marker older than STALE_MS: log + delete (do not block startup).
///
/// Returns the count of markers recovered + the list of errors. Errors are
/// non-fatal — the desktop continues to boot regardless.
pub struct RecoveryReport {
    pub recovered: usize,
    pub stale_dropped: usize,
    pub errors: Vec<String>,
}

pub fn recover_pending_sagas(
    sessions_dir: &Path,
    rebuild: &mut dyn FnMut(&IntentLogMarker) -> Result<(), SagaError>,
) -> RecoveryReport {
    let mut report = RecoveryReport {
        recovered: 0,
        stale_dropped: 0,
        errors: Vec::new(),
    };
    if !sessions_dir.exists() {
        return report;
    }
    let now = now_ms().ok();
    let session_iter = match fs::read_dir(sessions_dir) {
        Ok(it) => it,
        Err(e) => {
            report
                .errors
                .push(format!("read sessions dir: {e}"));
            return report;
        }
    };
    for session_entry in session_iter.flatten() {
        if !session_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let session_path = session_entry.path();
        let inner = match fs::read_dir(&session_path) {
            Ok(it) => it,
            Err(e) => {
                report
                    .errors
                    .push(format!("read {}: {e}", session_path.display()));
                continue;
            }
        };
        for entry in inner.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let s = name.to_string_lossy();
            if !s.starts_with(".pending-") || !s.ends_with(".json") {
                continue;
            }
            match resolve_one(&path, sessions_dir, now, rebuild) {
                Ok(ResolveOutcome::Recovered) => report.recovered += 1,
                Ok(ResolveOutcome::Stale) => report.stale_dropped += 1,
                Ok(ResolveOutcome::OrphanedTmpRemoved) => report.recovered += 1,
                Err(e) => {
                    error!(target: "trail::saga::recover", path = %path.display(), error = %e, "marker recovery failed");
                    report.errors.push(format!("{}: {e}", path.display()));
                }
            }
        }
    }
    info!(
        target: "trail::saga::recover",
        recovered = report.recovered,
        stale = report.stale_dropped,
        errors = report.errors.len(),
        "saga recovery scan complete"
    );
    report
}

enum ResolveOutcome {
    Recovered,
    Stale,
    OrphanedTmpRemoved,
}

/// Validate that `marker.yaml_path` lies under `sessions_dir` after
/// canonicalization. Returns Ok if the marker is safe to act on, Err
/// with a human message if either canonicalization fails or the
/// resolved path escapes the sessions root.
///
/// Cycle-1.5 F1: an attacker with filesystem write access to
/// `.trail/sessions/<sid>/` could drop a fabricated `.pending-*.json`
/// marker pointing at any YAML they control via the `yaml_path` field.
/// On hash-match, the recovery scan would invoke `rebuild` against the
/// attacker-controlled YAML — low-impact escalation, but worth gating.
///
/// Note on pre-rename markers: the YAML file may not exist on disk yet
/// (only the `.tmp` sibling does — the rename hasn't happened). We
/// therefore canonicalize the marker yaml_path's PARENT directory
/// (which DOES exist; it is the session dir holding the marker) and
/// compose the basename back. This admits the pre-rename happy path
/// without weakening the attacker-write protection.
fn validate_marker_yaml_path(
    marker: &IntentLogMarker,
    sessions_dir: &Path,
) -> Result<(), String> {
    let yaml = Path::new(&marker.yaml_path);
    let parent = yaml
        .parent()
        .ok_or_else(|| format!("yaml_path has no parent: {}", yaml.display()))?;
    let canon_parent = parent.canonicalize().map_err(|e| {
        format!("canonicalize parent {}: {e}", parent.display())
    })?;
    let canon_sessions = sessions_dir.canonicalize().map_err(|e| {
        format!("canonicalize sessions_dir {}: {e}", sessions_dir.display())
    })?;
    if !canon_parent.starts_with(&canon_sessions) {
        return Err(format!(
            "yaml_path parent {} not under sessions_dir {}",
            canon_parent.display(),
            canon_sessions.display()
        ));
    }
    // Defense-in-depth: also reject a basename containing path
    // separators or `..` that could lift the resolved path out of the
    // canonicalized parent. `Path::file_name` returns None on `..`, so
    // a None here is itself a rejection.
    let basename = yaml.file_name().ok_or_else(|| {
        format!("yaml_path basename invalid: {}", yaml.display())
    })?;
    let basename_str = basename.to_string_lossy();
    if basename_str.contains("..") || basename_str.contains('/') || basename_str.contains('\\') {
        return Err(format!(
            "yaml_path basename rejected: {basename_str}"
        ));
    }
    Ok(())
}

fn resolve_one(
    marker_pth: &Path,
    sessions_dir: &Path,
    now: Option<u64>,
    rebuild: &mut dyn FnMut(&IntentLogMarker) -> Result<(), SagaError>,
) -> Result<ResolveOutcome, SagaError> {
    let raw = fs::read_to_string(marker_pth)?;
    let marker: IntentLogMarker = serde_json::from_str(&raw)
        .map_err(|e| SagaError::Recovery(format!("parse marker: {e}")))?;

    if marker.is_stale(now) {
        delete_marker_if_present(marker_pth);
        warn!(target: "trail::saga::recover", txn_id = %marker.txn_id, "marker stale; dropped");
        return Ok(ResolveOutcome::Stale);
    }

    // Cycle-1.5 F1 fix (gh#11 cycle-1 review F1, P3): validate the
    // marker's `yaml_path` field is a child of the watched
    // `.trail/sessions/` root after canonicalization. The driver constructs
    // markers via `IntentLogMarker::new` with a yaml_path the saga
    // controls, so production-path markers are safe; this guard catches
    // a fabricated marker dropped by an attacker with filesystem write
    // (low-impact escalation path). Without this guard, a hash-match
    // marker pointing at an attacker-placed YAML would invoke `rebuild`
    // against the attacker-controlled file.
    //
    // Reject the marker if EITHER:
    //   - canonicalize fails on the marker's yaml_path
    //   - canonicalize fails on sessions_dir
    //   - the canonicalized yaml_path does not start with the
    //     canonicalized sessions_dir (with proper path separators)
    if let Err(e) = validate_marker_yaml_path(&marker, sessions_dir) {
        // Drop the marker so the same forged file does not persist on
        // disk to be re-processed at every boot. Audit log is not
        // available at this layer (it is the saga driver's
        // responsibility); we log at warn so operators see the event.
        warn!(
            target: "trail::saga::recover",
            txn_id = %marker.txn_id,
            packet_id = %marker.packet_id,
            yaml_path = %marker.yaml_path,
            sessions_dir = %sessions_dir.display(),
            error = %e,
            "marker rejected: yaml_path outside sessions_dir; dropping marker"
        );
        delete_marker_if_present(marker_pth);
        return Ok(ResolveOutcome::Stale);
    }

    match marker.stage {
        SagaStage::PreRename => {
            // Tmp file may exist; rename did NOT happen. Decision is
            // unrecoverable; clean up tmp + drop marker. Caller's UI
            // re-prompts.
            let yaml_path = PathBuf::from(&marker.yaml_path);
            let mut tmp = yaml_path.as_os_str().to_owned();
            tmp.push(".tmp");
            let tmp_path = PathBuf::from(tmp);
            if tmp_path.exists() {
                let _ = fs::remove_file(&tmp_path);
            }
            delete_marker_if_present(marker_pth);
            warn!(
                target: "trail::saga::recover",
                txn_id = %marker.txn_id,
                packet_id = %marker.packet_id,
                "pre-rename marker resolved (decision lost)"
            );
            Ok(ResolveOutcome::OrphanedTmpRemoved)
        }
        SagaStage::PreLibsql => {
            let yaml_path = PathBuf::from(&marker.yaml_path);
            if !yaml_path.exists() {
                // YAML missing: this is a hard inconsistency; surface to
                // operator. We do NOT delete the marker so a later run can
                // see it.
                return Err(SagaError::Recovery(format!(
                    "pre-libsql marker references missing YAML at {}",
                    yaml_path.display()
                )));
            }
            let on_disk = fs::read_to_string(&yaml_path)?;
            let on_disk_hash = sha256_hex(&on_disk);
            if marker.expected_yaml_hash.as_deref() != Some(on_disk_hash.as_str()) {
                // Hash mismatch: external edit happened between rename and
                // recovery. Treat as J12 path; do NOT silently rebuild — leave
                // the marker so the operator sees it via audit log.
                return Err(SagaError::Recovery(format!(
                    "pre-libsql marker hash mismatch for packet {}",
                    marker.packet_id
                )));
            }
            // Hash matches — invoke caller-supplied rebuild + drop marker.
            rebuild(&marker).map_err(|e| {
                SagaError::Recovery(format!(
                    "rebuild_libsql_for_packet({}) failed: {e}",
                    marker.packet_id
                ))
            })?;
            delete_marker_if_present(marker_pth);
            info!(
                target: "trail::saga::recover",
                txn_id = %marker.txn_id,
                packet_id = %marker.packet_id,
                "pre-libsql marker recovered (libSQL rebuilt)"
            );
            Ok(ResolveOutcome::Recovered)
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::watcher::SagaInFlightRegistry;
    use rusqlite::Connection;
    use tempfile::TempDir;

    fn fresh_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_all(&mut conn).unwrap();
        conn
    }

    /// Cycle-1.5 F5 fix — pin `compute_approval_trail_hash` against a
    /// known fixture so a serde_yaml serializer change (or a port to a
    /// different YAML library) surfaces here as a test failure rather
    /// than as silent watcher false-positives.
    ///
    /// The hash on the right was captured by running the same fixture
    /// through the function at commit time; if a future serde_yaml
    /// version changes scalar quoting / indent / line endings, this
    /// pin breaks BEFORE the tampering invariant breaks in production.
    ///
    /// Cross-language constraint: see compute_approval_trail_hash
    /// docstring. As long as Rust is the SOLE writer of approval_trail
    /// entries the hash is internally consistent. A future TS-side
    /// writer would need to mirror this fixture in TS and pin the
    /// same expected hash (which is the F25 character-for-character
    /// port discipline).
    #[test]
    fn approval_trail_hash_pin_single_entry() {
        let yaml = r#"
approval_trail:
  - claim_id: CLAIM-001
    decision: accept
    reason: looks good
    by: alice
    at: '2026-05-09T12:00:00Z'
"#;
        let v: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        let got = compute_approval_trail_hash(&v);
        // Sanity: hex-encoded sha256 is 64 chars.
        assert_eq!(got.len(), 64, "hash must be hex sha256 (64 chars)");
        assert!(
            got.chars().all(|c| c.is_ascii_hexdigit()),
            "hash must be hex chars only: {got}"
        );
        // The pin: any change here should be reviewed (was the
        // serializer or input deliberately changed?).
        let expected = APPROVAL_TRAIL_HASH_SINGLE_ENTRY_PIN;
        assert_eq!(
            got, expected,
            "approval_trail hash drifted from pin — review serde_yaml or fixture changes"
        );
    }

    #[test]
    fn approval_trail_hash_empty_block_is_stable() {
        // Empty packet (no approval_trail key) must hash to the same
        // value as a packet with `approval_trail: []`. The function
        // gracefully handles the missing-key case by substituting an
        // empty Sequence.
        let v_missing: serde_yaml::Value =
            serde_yaml::from_str("_meta:\n  packet_id: x\n").unwrap();
        let v_empty: serde_yaml::Value =
            serde_yaml::from_str("_meta:\n  packet_id: x\napproval_trail: []\n").unwrap();
        let h_missing = compute_approval_trail_hash(&v_missing);
        let h_empty = compute_approval_trail_hash(&v_empty);
        assert_eq!(
            h_missing, h_empty,
            "missing key and empty array must hash to the same value"
        );
    }

    /// Pin captured at commit time; run the test once to harvest, then
    /// freeze. Computed via:
    ///     let v: Value = serde_yaml::from_str(yaml).unwrap();
    ///     let block = v.get("approval_trail").cloned().unwrap_or(Value::Sequence(vec![]));
    ///     let s = serde_yaml::to_string(&block).unwrap();
    ///     sha256(s.as_bytes())
    const APPROVAL_TRAIL_HASH_SINGLE_ENTRY_PIN: &str =
        "21e147bda94b13163b089b9c28132b8d4dc333106a8809949c47880867ebcadd";

    fn seed_packet(conn: &Connection, packet_id: &str, yaml_path: &Path) {
        conn.execute(
            "INSERT INTO packets (packet_id, session_id, repo_path, captured_at, schema_version, yaml_path) \
             VALUES (?1, 'session-x', '/tmp/repo', '2026-01-01T00:00:00Z', '0.1.1', ?2)",
            rusqlite::params![packet_id, yaml_path.to_string_lossy().to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO claims (claim_id, packet_id, claim_text, synthesis_mode, risk_level_agent, position) \
             VALUES ('CLAIM-001', ?1, 'sample claim', 'mechanical', 'med', 0)",
            rusqlite::params![packet_id],
        )
        .unwrap();
    }

    fn write_packet_fixture(dir: &Path, packet_id: &str) -> PathBuf {
        let session_dir = dir.join("session-x");
        fs::create_dir_all(&session_dir).unwrap();
        let yaml = format!(
            "_meta:\n  packet_id: {pid}\n  session_id: session-x\nsummary:\n  claims:\n    - id: CLAIM-001\n      stable_id: 0123456789abcdef\n      claim_text: sample\n      risk_level_agent: med\n",
            pid = packet_id,
        );
        let p = session_dir.join("packet-1.yml");
        fs::write(&p, yaml).unwrap();
        p
    }

    #[test]
    fn marker_starts_at_pre_rename() {
        let m = IntentLogMarker::new(
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "txn-1",
            "/tmp/p.yml",
        )
        .unwrap();
        assert_eq!(m.stage, SagaStage::PreRename);
        assert!(m.expected_yaml_hash.is_none());
    }

    #[test]
    fn advance_records_yaml_hash_and_stage() {
        let mut m = IntentLogMarker::new(
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "txn-1",
            "/tmp/p.yml",
        )
        .unwrap();
        m.advance_to_pre_libsql("a".repeat(64));
        assert_eq!(m.stage, SagaStage::PreLibsql);
        assert_eq!(
            m.expected_yaml_hash.as_deref(),
            Some("a".repeat(64).as_str())
        );
    }

    #[test]
    fn stale_after_one_hour() {
        let m = IntentLogMarker::new_with_timestamp("y", "x", "/tmp/p.yml", 0);
        assert!(m.is_stale(Some(IntentLogMarker::STALE_MS + 1)));
        assert!(!m.is_stale(Some(IntentLogMarker::STALE_MS - 1)));
    }

    #[test]
    fn unreadable_clock_does_not_mark_anything_stale() {
        let m = IntentLogMarker::new_with_timestamp("y", "x", "/tmp/p.yml", 0);
        assert!(
            !m.is_stale(None),
            "unreadable clock must NOT trigger stale-abort"
        );
    }

    #[test]
    fn marker_round_trips_via_serde_json() {
        let m = IntentLogMarker::new(
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "txn-1",
            "/tmp/p.yml",
        )
        .unwrap();
        let s = serde_json::to_string(&m).unwrap();
        let back: IntentLogMarker = serde_json::from_str(&s).unwrap();
        assert_eq!(back.packet_id, m.packet_id);
        assert_eq!(back.stage, SagaStage::PreRename);
    }

    #[test]
    fn now_ms_returns_a_recent_value() {
        let v = now_ms().expect("system clock readable");
        assert!(v > 1_704_067_200_000, "expected modern timestamp, got {v}");
    }

    #[test]
    fn atomic_write_replaces_target() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("a.yml");
        fs::write(&p, "old").unwrap();
        atomic_write(&p, "new").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "new");
        // No tmp residue.
        let mut tmp = p.as_os_str().to_owned();
        tmp.push(".tmp");
        assert!(!Path::new(&tmp).exists());
    }

    #[test]
    fn layer2_scan_flags_secret_pattern() {
        let patterns = vec![(
            "openai-key".into(),
            regex::Regex::new(r"sk-[A-Za-z0-9]{16,}").unwrap(),
        )];
        let yaml = "_meta: {}\nclaim: contains sk-abcdefghijklmnopqr secret\n";
        let hits = layer2_scan(yaml, &patterns);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].pattern, "openai-key");
        // Cycle-1.5 F6: snippet is sha256(match)[:8].
        assert_eq!(hits[0].snippet.len(), 8);
        assert!(
            hits[0].snippet.chars().all(|c| c.is_ascii_hexdigit()),
            "snippet must be hex"
        );
        // Sanity: matches the documented sha256[:8] of the matched
        // text. The match is "sk-abcdefghijklmnopqr".
        let expected_full = sha256_hex("sk-abcdefghijklmnopqr");
        assert_eq!(hits[0].snippet, expected_full[..8]);
    }

    /// Cycle-1.5 F6 (P3): the strict-redaction-gate error message
    /// surfaces `pattern@snippet` pairs so an aborted saga's audit
    /// trail carries the forensic evidence matching Phase 1's
    /// RedactionValidationError shape. The snippet is sha256[:8],
    /// NEVER the original text.
    #[test]
    fn strict_redaction_error_message_carries_snippet_hashes() {
        let dir = TempDir::new().unwrap();
        let sessions = dir.path().join(".trail").join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let yaml_path = write_packet_fixture(&sessions, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        // Embed an obvious secret-like value in the seed YAML so the
        // saga's serialize-then-scan picks it up.
        let yaml_with_secret = fs::read_to_string(&yaml_path).unwrap()
            + "leaked: sk-abcdefghijklmnopqr\n";
        fs::write(&yaml_path, &yaml_with_secret).unwrap();
        let mut conn = fresh_db();
        seed_packet(&conn, "01ARZ3NDEKTSV4RRFFQ69G5FAV", &yaml_path);

        let driver = SagaDriver::new(vec![(
            "openai-key".into(),
            regex::Regex::new(r"sk-[A-Za-z0-9]{16,}").unwrap(),
        )]);
        let registry = SagaInFlightRegistry::new();
        let entry = DecisionEntry {
            claim_id: "CLAIM-001".into(),
            decision: "accept".into(),
            reason: None,
            by: "alice".into(),
            at: "2026-05-09T12:00:00Z".into(),
        };

        let err = driver
            .run_decision_saga(
                "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                &yaml_path,
                &SagaInput::AppendDecision(entry),
                &registry,
                &mut conn,
            )
            .unwrap_err();
        // Error message contains the pattern name AND the 8-char snippet hash.
        let msg = format!("{err}");
        assert!(msg.contains("openai-key"), "missing pattern name: {msg}");
        let expected_snippet = &sha256_hex("sk-abcdefghijklmnopqr")[..8];
        assert!(
            msg.contains(expected_snippet),
            "missing snippet hash {expected_snippet} in: {msg}"
        );
        // The original secret text MUST NOT leak into the error message.
        assert!(
            !msg.contains("sk-abcdefghijklmnopqr"),
            "original secret leaked in error: {msg}"
        );
    }

    #[test]
    fn layer2_scan_skips_already_redacted_markers() {
        // A pattern that would otherwise match `[REDACTED:openai-key]` text
        // must NOT fire because the marker is stripped before scanning.
        let patterns = vec![(
            "open-bracket".into(),
            regex::Regex::new(r"openai-key").unwrap(),
        )];
        let yaml = "_meta: {}\nclaim: was [REDACTED:openai-key] before\n";
        let hits = layer2_scan(yaml, &patterns);
        assert!(hits.is_empty(), "marker token must be scrubbed pre-scan");
    }

    #[test]
    fn full_decision_saga_writes_yaml_and_libsql() {
        let dir = TempDir::new().unwrap();
        let sessions = dir.path().join(".trail").join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let yaml_path = write_packet_fixture(&sessions, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        let mut conn = fresh_db();
        seed_packet(&conn, "01ARZ3NDEKTSV4RRFFQ69G5FAV", &yaml_path);

        let driver = SagaDriver::new(Vec::new());
        let registry = SagaInFlightRegistry::new();
        let entry = DecisionEntry {
            claim_id: "CLAIM-001".into(),
            decision: "accept".into(),
            reason: None,
            by: "alice@example.com".into(),
            at: "2026-05-09T12:00:00+00:00".into(),
        };
        let result = driver
            .run_decision_saga(
                "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                &yaml_path,
                &SagaInput::AppendDecision(entry.clone()),
                &registry,
                &mut conn,
            )
            .unwrap();
        assert_eq!(result.packet_id, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        assert_eq!(result.new_approval_hash.len(), 64);

        // YAML now contains approval_trail entry.
        let on_disk = fs::read_to_string(&yaml_path).unwrap();
        assert!(on_disk.contains("approval_trail"));
        assert!(on_disk.contains("alice@example.com"));

        // libSQL has the row.
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM approval_trail WHERE packet_id = ?1",
                ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        // last_known_hash updated.
        let stored: String = conn
            .query_row(
                "SELECT last_known_hash FROM packets WHERE packet_id = ?1",
                ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, result.new_approval_hash);

        // No marker residue (saga-complete delete worked).
        for entry in fs::read_dir(yaml_path.parent().unwrap()).unwrap().flatten() {
            let s = entry.file_name().to_string_lossy().to_string();
            assert!(!s.starts_with(".pending-"), "marker {s} was not cleaned up");
        }

        // saga_in_flight cleared.
        assert!(!registry.contains("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
    }

    #[test]
    fn strict_redaction_gate_aborts_before_write() {
        let dir = TempDir::new().unwrap();
        let sessions = dir.path().join(".trail").join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let yaml_path = write_packet_fixture(&sessions, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        let original_yaml = fs::read_to_string(&yaml_path).unwrap();

        let mut conn = fresh_db();
        seed_packet(&conn, "01ARZ3NDEKTSV4RRFFQ69G5FAV", &yaml_path);

        // Pattern that always matches once we serialize: the word 'sample'
        // appears in the fixture's claim_text.
        let patterns = vec![(
            "sentinel-secret".into(),
            regex::Regex::new(r"sample").unwrap(),
        )];
        let driver = SagaDriver::new(patterns);
        let registry = SagaInFlightRegistry::new();
        let entry = DecisionEntry {
            claim_id: "CLAIM-001".into(),
            decision: "accept".into(),
            reason: None,
            by: "alice@example.com".into(),
            at: "2026-05-09T12:00:00+00:00".into(),
        };
        let err = driver
            .run_decision_saga(
                "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                &yaml_path,
                &SagaInput::AppendDecision(entry),
                &registry,
                &mut conn,
            )
            .unwrap_err();
        assert!(matches!(err, SagaError::StrictRedaction(_)));

        // YAML untouched.
        assert_eq!(fs::read_to_string(&yaml_path).unwrap(), original_yaml);
        // libSQL untouched.
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM approval_trail",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        // saga_in_flight cleared even on error.
        assert!(!registry.contains("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
    }

    #[test]
    fn risk_override_saga_writes_claim_columns() {
        let dir = TempDir::new().unwrap();
        let sessions = dir.path().join(".trail").join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let yaml_path = write_packet_fixture(&sessions, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        let mut conn = fresh_db();
        seed_packet(&conn, "01ARZ3NDEKTSV4RRFFQ69G5FAV", &yaml_path);

        let driver = SagaDriver::new(Vec::new());
        let registry = SagaInFlightRegistry::new();
        let ov = RiskOverride {
            claim_id: "CLAIM-001".into(),
            layer: RiskLayer::Reviewer,
            new_level: "high".into(),
            reason: "raised based on new evidence".into(),
            by: "bob@example.com".into(),
            at: "2026-05-09T12:30:00+00:00".into(),
        };
        driver
            .run_decision_saga(
                "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                &yaml_path,
                &SagaInput::SetRiskOverride(ov.clone()),
                &registry,
                &mut conn,
            )
            .unwrap();

        let on_disk = fs::read_to_string(&yaml_path).unwrap();
        assert!(on_disk.contains("risk_level_reviewer_override: high"));
        assert!(on_disk.contains("bob@example.com"));

        let stored_level: String = conn
            .query_row(
                "SELECT risk_level_reviewer_override FROM claims WHERE claim_id = 'CLAIM-001'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored_level, "high");
    }

    #[test]
    fn recovery_pre_libsql_with_matching_hash_invokes_rebuild() {
        let dir = TempDir::new().unwrap();
        let sessions = dir.path().join("sessions");
        let session_dir = sessions.join("session-x");
        fs::create_dir_all(&session_dir).unwrap();
        let yaml_path = session_dir.join("packet-1.yml");
        fs::write(&yaml_path, "_meta: {}\napproval_trail: []\n").unwrap();

        // Place a pre-libsql marker pointing at this YAML with the matching
        // hash. recover_pending_sagas should fire the rebuild callback.
        let on_disk_hash = sha256_hex(&fs::read_to_string(&yaml_path).unwrap());
        let mut marker = IntentLogMarker::new(
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "txn-recover",
            yaml_path.to_string_lossy().to_string(),
        )
        .unwrap();
        marker.advance_to_pre_libsql(&on_disk_hash);
        let marker_pth = marker_path(&yaml_path, &marker.txn_id);
        write_marker(&marker_pth, &marker).unwrap();

        let mut called = 0usize;
        let mut rebuild = |m: &IntentLogMarker| {
            assert_eq!(m.packet_id, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
            called += 1;
            Ok(())
        };
        let report = recover_pending_sagas(&sessions, &mut rebuild);
        assert_eq!(called, 1);
        assert_eq!(report.recovered, 1);
        assert!(!marker_pth.exists());
    }

    #[test]
    fn recovery_pre_rename_cleans_orphan_tmp() {
        let dir = TempDir::new().unwrap();
        let sessions = dir.path().join("sessions");
        let session_dir = sessions.join("session-x");
        fs::create_dir_all(&session_dir).unwrap();
        let yaml_path = session_dir.join("packet-2.yml");
        let mut tmp = yaml_path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp_path = PathBuf::from(tmp);
        fs::write(&tmp_path, "<orphaned tmp>").unwrap();

        let marker = IntentLogMarker::new(
            "01ARZ3NDEKTSV4RRFFQ69G5FAW",
            "txn-pre-rename",
            yaml_path.to_string_lossy().to_string(),
        )
        .unwrap();
        let marker_pth = marker_path(&yaml_path, &marker.txn_id);
        write_marker(&marker_pth, &marker).unwrap();

        let mut rebuild =
            |_: &IntentLogMarker| panic!("pre-rename markers must NOT trigger rebuild");
        let report = recover_pending_sagas(&sessions, &mut rebuild);
        assert_eq!(report.recovered, 1, "pre-rename counted as recovered");
        assert!(!tmp_path.exists(), "orphaned tmp removed");
        assert!(!marker_pth.exists());
    }

    #[test]
    fn recovery_skips_stale_markers() {
        let dir = TempDir::new().unwrap();
        let sessions = dir.path().join("sessions");
        let session_dir = sessions.join("session-x");
        fs::create_dir_all(&session_dir).unwrap();
        let yaml_path = session_dir.join("packet-3.yml");
        fs::write(&yaml_path, "_meta: {}\n").unwrap();

        // Marker created at epoch 0 — guaranteed older than 1h vs now.
        let marker = IntentLogMarker::new_with_timestamp(
            "01ARZ3NDEKTSV4RRFFQ69G5FAX",
            "txn-stale",
            yaml_path.to_string_lossy().to_string(),
            0,
        );
        let marker_pth = marker_path(&yaml_path, &marker.txn_id);
        write_marker(&marker_pth, &marker).unwrap();

        let mut rebuild =
            |_: &IntentLogMarker| panic!("stale markers must NOT trigger rebuild");
        let report = recover_pending_sagas(&sessions, &mut rebuild);
        assert_eq!(report.stale_dropped, 1);
        assert!(!marker_pth.exists());
    }

    #[test]
    fn recovery_hash_mismatch_keeps_marker_for_audit() {
        let dir = TempDir::new().unwrap();
        let sessions = dir.path().join("sessions");
        let session_dir = sessions.join("session-x");
        fs::create_dir_all(&session_dir).unwrap();
        let yaml_path = session_dir.join("packet-4.yml");
        fs::write(&yaml_path, "_meta: {}\n").unwrap();

        let mut marker = IntentLogMarker::new(
            "01ARZ3NDEKTSV4RRFFQ69G5FAY",
            "txn-mismatch",
            yaml_path.to_string_lossy().to_string(),
        )
        .unwrap();
        marker.advance_to_pre_libsql("0".repeat(64)); // wrong hash
        let marker_pth = marker_path(&yaml_path, &marker.txn_id);
        write_marker(&marker_pth, &marker).unwrap();

        let mut rebuild =
            |_: &IntentLogMarker| panic!("mismatch must NOT trigger rebuild");
        let report = recover_pending_sagas(&sessions, &mut rebuild);
        assert_eq!(report.recovered, 0);
        assert_eq!(report.errors.len(), 1);
        // Marker preserved so the operator/J12 path can surface it.
        assert!(marker_pth.exists());
    }

    /// Cycle-1.5 F1 (P3): a fabricated marker whose `yaml_path` field
    /// points outside the `.trail/sessions/` root MUST be rejected
    /// (and the marker dropped to prevent boot-time replay) so an
    /// attacker with filesystem write cannot trick recovery into
    /// rebuilding libSQL against an arbitrary YAML.
    ///
    /// Construct: a marker dropped INSIDE the sessions dir, but its
    /// JSON yaml_path field references a YAML in a different temp dir.
    /// On a real attack the YAML would be attacker-controlled; the
    /// guard rejects pre-rebuild.
    #[test]
    fn recovery_rejects_marker_pointing_outside_sessions_dir() {
        let dir = TempDir::new().unwrap();
        let sessions = dir.path().join("sessions");
        let session_dir = sessions.join("session-x");
        fs::create_dir_all(&session_dir).unwrap();

        // Place an attacker-controlled YAML OUTSIDE the sessions root.
        let attacker_dir = dir.path().join("attacker");
        fs::create_dir_all(&attacker_dir).unwrap();
        let attacker_yaml = attacker_dir.join("evil-packet.yml");
        fs::write(&attacker_yaml, "_meta: {}\napproval_trail: []\n").unwrap();
        let on_disk_hash =
            sha256_hex(&fs::read_to_string(&attacker_yaml).unwrap());

        // Forge a marker — txn_id is plausible, yaml_path points at the
        // attacker file, hash matches its on-disk content.
        let mut marker = IntentLogMarker::new(
            "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
            "txn-forged",
            attacker_yaml.to_string_lossy().to_string(),
        )
        .unwrap();
        marker.advance_to_pre_libsql(&on_disk_hash);

        // Drop the marker inside sessions/<sid>/.pending-<txn>.json
        // (matching the directory the recovery scan walks).
        let marker_pth = session_dir.join(format!(".pending-{}.json", marker.txn_id));
        write_marker(&marker_pth, &marker).unwrap();

        let mut called = 0usize;
        let mut rebuild = |_: &IntentLogMarker| {
            called += 1;
            Ok(())
        };
        let report = recover_pending_sagas(&sessions, &mut rebuild);
        // rebuild MUST NOT have been called
        assert_eq!(
            called, 0,
            "rebuild MUST NOT run on a marker pointing outside sessions_dir"
        );
        // Marker is dropped to prevent boot-time replay
        assert!(
            !marker_pth.exists(),
            "forged marker MUST be deleted on rejection"
        );
        // Recovery counts the rejection as a stale-drop, not a recovered
        assert_eq!(report.recovered, 0);
        assert_eq!(report.stale_dropped, 1);
    }

    /// Crash-injection: kill the process after rename + before libSQL commit
    /// (between step 6 and step 8). We simulate by manually performing the
    /// pre-libsql writes (atomic write + marker advance) and skipping the TX
    /// commit. Recovery scan must then invoke rebuild.
    #[test]
    fn crash_between_rename_and_libsql_recovers_via_marker() {
        let dir = TempDir::new().unwrap();
        let sessions = dir.path().join(".trail").join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let yaml_path = write_packet_fixture(&sessions, "01ARZ3NDEKTSV4RRFFQ69GCRA");
        let mut conn = fresh_db();
        seed_packet(&conn, "01ARZ3NDEKTSV4RRFFQ69GCRA", &yaml_path);

        // Manually perform up through step 6a (rename + advance marker), then
        // STOP before step 8 (libSQL commit). This is the crash window.
        let original = fs::read_to_string(&yaml_path).unwrap();
        let mut value: serde_yaml::Value = serde_yaml::from_str(&original).unwrap();
        let entry = DecisionEntry {
            claim_id: "CLAIM-001".into(),
            decision: "block".into(),
            reason: Some("oauth wiring incomplete".into()),
            by: "carol@example.com".into(),
            at: "2026-05-09T13:00:00+00:00".into(),
        };
        apply_decision_mutation(&mut value, &entry).unwrap();
        let new_yaml = serde_yaml::to_string(&value).unwrap();
        let txn_id = "txn-crash";
        let marker_pth = marker_path(&yaml_path, txn_id);
        let mut marker = IntentLogMarker::new(
            "01ARZ3NDEKTSV4RRFFQ69GCRA",
            txn_id,
            yaml_path.to_string_lossy().to_string(),
        )
        .unwrap();
        write_marker(&marker_pth, &marker).unwrap();
        atomic_write(&yaml_path, &new_yaml).unwrap();
        let full_hash = sha256_hex(&new_yaml);
        marker.advance_to_pre_libsql(&full_hash);
        write_marker(&marker_pth, &marker).unwrap();
        // ✗ would-be step 8 here (libSQL TX commit) — CRASH ✗
        // Disk state: YAML has the new approval_trail entry; libSQL does NOT;
        // marker still on disk at stage='pre-libsql'.
        let pre_recovery_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM approval_trail WHERE packet_id = ?1",
                ["01ARZ3NDEKTSV4RRFFQ69GCRA"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pre_recovery_count, 0, "libSQL is not yet updated");
        assert!(marker_pth.exists(), "marker is still on disk pre-recovery");
        assert!(fs::read_to_string(&yaml_path).unwrap().contains("carol@example.com"));

        // Boot-time recovery: rebuild closure simulates the
        // `rebuild_libsql_for_packet` helper (B5 §3.3). Here we re-read the
        // YAML and INSERT the missing approval_trail row.
        let mut rebuild = |m: &IntentLogMarker| {
            let yaml = fs::read_to_string(&m.yaml_path)?;
            let parsed: serde_yaml::Value =
                serde_yaml::from_str(&yaml).map_err(|e| SagaError::YamlParse(e.to_string()))?;
            let entries = parsed
                .get("approval_trail")
                .and_then(|v| v.as_sequence())
                .cloned()
                .unwrap_or_default();
            let approval_hash = compute_approval_trail_hash(&parsed);
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            tx.execute(
                "DELETE FROM approval_trail WHERE packet_id = ?1",
                [&m.packet_id],
            )?;
            for (i, entry) in entries.iter().enumerate() {
                let claim_id = entry
                    .get("claim_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| SagaError::Recovery("missing claim_id".into()))?;
                let decision = entry
                    .get("decision")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| SagaError::Recovery("missing decision".into()))?;
                let reason = entry.get("reason").and_then(|v| v.as_str());
                let by = entry
                    .get("by")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| SagaError::Recovery("missing by".into()))?;
                let at = entry
                    .get("at")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| SagaError::Recovery("missing at".into()))?;
                tx.execute(
                    "INSERT INTO approval_trail (packet_id, claim_id, decision, reason, decided_by, decided_at, position) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        m.packet_id,
                        claim_id,
                        decision,
                        reason,
                        by,
                        at,
                        i as i64
                    ],
                )?;
            }
            tx.execute(
                "UPDATE packets SET last_known_hash = ?1, libsql_dirty = 0 WHERE packet_id = ?2",
                rusqlite::params![approval_hash, m.packet_id],
            )?;
            tx.commit()?;
            Ok(())
        };
        let report = recover_pending_sagas(&sessions, &mut rebuild);
        assert_eq!(report.recovered, 1, "recovery healed the crash window");
        assert!(!marker_pth.exists(), "marker deleted after recovery");

        // libSQL now has the row.
        let post_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM approval_trail WHERE packet_id = ?1",
                ["01ARZ3NDEKTSV4RRFFQ69GCRA"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(post_count, 1);

        // YAML still canonical (untorn).
        let final_yaml = fs::read_to_string(&yaml_path).unwrap();
        assert!(final_yaml.contains("approval_trail"));
        assert!(final_yaml.contains("carol@example.com"));
    }
}
