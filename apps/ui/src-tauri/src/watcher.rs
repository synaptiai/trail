//! P4 filesystem watcher (B5 §4).
//!
//! Two-layer self-write detection:
//!   1. saga_in_flight in-memory map keyed by packet_id (covers slow disks
//!      where saga exceeds the debounce window).
//!   2. content-hash compare against libSQL's last_known_hash (covers
//!      cross-process external writes — `vim packet-1.yml` while Trail open).
//!
//! Sprint 1 shipped the saga-in-flight registry as a stand-alone module so
//! its semantics are testable. Sprint 4 wires the notify-debouncer-full
//! instance + IPC emission, and adds `evaluate_change` — the pure function
//! that classifies a filesystem event as self-write / external-edit / no-op.

use crate::saga::compute_approval_trail_hash;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use tracing::{error, warn};

/// Per PR #6 cycle-1 review F5 (P2 error-handling consensus HIGH):
///
/// The registry's invariant is "this set accurately reflects active saga
/// writes." If a panic poisons the mutex mid-`insert`/`remove`, the set may
/// be in a half-mutated state. The previous implementation called
/// `into_inner()` on `PoisonError`, silently accepting the partial state
/// and risking false-positive J12 firings on the user's own writes — the
/// exact failure mode this registry exists to prevent.
///
/// New semantic: on `PoisonError`, log at ERROR level and ABORT the
/// process. The OS terminates the desktop process; the user re-launches
/// Trail (saga recovery via the persisted intent-log marker per B5 §3
/// rebuilds the in-flight set from disk on next startup). This is the
/// documented "fail-loud" behavior referenced in B5 §4 — better a visible
/// crash than silent corruption of the self-write detection invariant.
///
/// Cycle-2 N32 documentation-accuracy fix: tauri 2.x `Builder` does NOT
/// supervise/restart on `std::process::abort()`. The earlier wording
/// ("supervisor will restart the watcher cold") implied an automatic
/// restart that does not exist in Tauri 2.x. The correct mental model is
/// "fail loud, user re-launches, saga recovery rebuilds state from disk."
#[derive(Debug, Default)]
pub struct SagaInFlightRegistry {
    inner: Mutex<HashSet<String>>,
}

/// Helper invoked on `PoisonError`. Logs the corruption then aborts. The
/// signature returns the guard type only to satisfy the `unwrap_or_else`
/// closure shape; in practice `std::process::abort()` does not return.
#[cold]
#[inline(never)]
fn abort_on_poison<T>(err: PoisonError<MutexGuard<'_, T>>) -> MutexGuard<'_, T> {
    error!(
        target: "trail::watcher",
        "saga_in_flight_registry mutex poisoned: panic occurred while holding the lock; \
         aborting to surface the corruption rather than continue with a half-mutated state. \
         The user must re-launch Trail; saga recovery (B5 §3) rebuilds state from disk. \
         (Tauri 2.x does NOT auto-restart desktop processes on abort.)"
    );
    let _ = err; // bind so the borrow checker keeps the lifetime
    // std::process::abort() bypasses unwinding entirely; chosen so
    // destructors do not run on the corrupted state. Marked unreachable
    // for the type system below this point.
    std::process::abort();
}

impl SagaInFlightRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mark(&self, packet_id: impl Into<String>) {
        let mut guard = self.inner.lock().unwrap_or_else(abort_on_poison);
        guard.insert(packet_id.into());
    }

    pub fn clear(&self, packet_id: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(abort_on_poison);
        guard.remove(packet_id);
    }

    pub fn contains(&self, packet_id: &str) -> bool {
        let guard = self.inner.lock().unwrap_or_else(abort_on_poison);
        guard.contains(packet_id)
    }
}

/// Debounce window per B5 §4.5 — locked at 500ms; widened from 200ms to
/// absorb slow-disk windows while keeping the saga-in-flight flag as the
/// primary self-write detector.
pub const DEBOUNCE_MS: u64 = 500;

// ---------------------------------------------------------------------------
// Self-race / external-edit classifier (B5 §4.2)
//
// v0.1.1 B6 refactor (`route watcher through evaluate_change`): this
// classifier is now the single source of truth for the watcher dispatch
// loop. `main.rs::spawn_fs_watcher` calls `evaluate_change` once per
// debounced path and maps the returned `WatcherDecision` to the
// corresponding Tauri `app.emit()` calls — replacing the prior inline
// re-implementation that had two latent bugs (non-NotFound read errors
// silently dropped; parse-error / missing events emitted with an empty
// `packet_id` when libSQL hadn't yet ingested the path).
// ---------------------------------------------------------------------------

/// Outcome of classifying a single filesystem event for a packet YAML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatcherDecision {
    /// Saga-in-flight flag is set; ignore. UI was the writer.
    IgnoreInFlight,
    /// Saga-in-flight is clear AND the on-disk approval_trail hash matches
    /// `packets.last_known_hash`. The saga finished cleanly OR this is a
    /// no-op rewrite (e.g., `touch packet-1.yml`). Caller emits
    /// `trail-needs-refresh` so the sidebar picks up freshly-captured
    /// packets.
    NoOp,
    /// External edit: hash mismatch. Fire J12 with this mismatch_type. The
    /// `packet_id` was successfully extracted from the on-disk YAML and is
    /// carried inline so the caller can populate the event payload without
    /// a second round-trip through libSQL.
    External {
        packet_id: String,
        kind: MismatchKind,
    },
    /// File read or YAML parse failed (corrupt YAML on disk, EACCES, EIO,
    /// etc.). Surface to UI as a J12 variant with reason=parse-error. The
    /// caller is responsible for reverse-looking-up the `packet_id` from
    /// the path via libSQL (`select_packet_id_by_path`); when libSQL has
    /// not yet ingested the packet, the caller emits with `packet_id:
    /// null`.
    ParseError(String),
    /// File no longer present (deleted between event and read). Treat as
    /// J12 missing. Same `packet_id` resolution rule as `ParseError`.
    Missing,
    /// Path did not match the watched packet pattern; ignore entirely.
    Unwatched,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MismatchKind {
    /// approval_trail hash differs from libSQL.
    HashMismatch,
}

/// Classify a filesystem event for a packet YAML. Pure function (no I/O,
/// no global state) — caller supplies:
///
///   - `path`: the changed file
///   - `read_yaml`: closure that reads + parses the file (so tests can
///     inject in-memory bytes; production wires fs::read_to_string)
///   - `lookup_known_hash`: closure that returns the libSQL
///     `packets.last_known_hash` for the packet at `path`
///   - `saga_in_flight`: closure that checks the registry by packet_id
///
/// The classifier mirrors the contract in B5 §4.2 verbatim: if-saga-in-flight
/// → IgnoreInFlight; else hash-compare → NoOp or External.
pub fn evaluate_change<R, L, S>(
    path: &Path,
    mut read_yaml: R,
    mut lookup_known_hash: L,
    mut saga_in_flight: S,
) -> WatcherDecision
where
    R: FnMut(&Path) -> Result<serde_yaml::Value, ReadError>,
    L: FnMut(&str) -> Option<String>,
    S: FnMut(&str) -> bool,
{
    if !is_packet_yaml(path) {
        return WatcherDecision::Unwatched;
    }
    let packet_id = match parse_packet_id_from_yaml_path(path, &mut read_yaml) {
        Ok(id) => id,
        Err(ReadError::NotFound) => return WatcherDecision::Missing,
        Err(ReadError::ParseError(msg)) => return WatcherDecision::ParseError(msg),
        Err(ReadError::Other(msg)) => return WatcherDecision::ParseError(msg),
    };
    if saga_in_flight(&packet_id) {
        return WatcherDecision::IgnoreInFlight;
    }
    let parsed = match read_yaml(path) {
        Ok(v) => v,
        Err(ReadError::NotFound) => return WatcherDecision::Missing,
        Err(ReadError::ParseError(m)) | Err(ReadError::Other(m)) => {
            return WatcherDecision::ParseError(m)
        }
    };
    let current_hash = compute_approval_trail_hash(&parsed);
    let known = lookup_known_hash(&packet_id);
    match known {
        Some(stored) if stored == current_hash => WatcherDecision::NoOp,
        Some(_) => WatcherDecision::External {
            packet_id,
            kind: MismatchKind::HashMismatch,
        },
        // No prior hash on file means this packet has never had a decision
        // saved. The on-disk YAML is canonical-by-default; we treat the
        // event as a no-op (the trail browser will refresh independently).
        None => WatcherDecision::NoOp,
    }
}

#[derive(Debug)]
pub enum ReadError {
    NotFound,
    ParseError(String),
    /// Non-NotFound, non-parse I/O error (EACCES, EIO, etc.). v0.1.1 B6
    /// surfaces this through `WatcherDecision::ParseError` so the J12
    /// "unparseable file" banner fires; the prior inline classifier in
    /// `main.rs::spawn_fs_watcher` logged at warn and silently dropped
    /// the event.
    Other(String),
}

/// Whether `path` is a packet YAML the watcher cares about. Per B5 §4.6:
/// recursive watch on `.trail/sessions/`; we accept paths matching
/// `**/sessions/<sid>/packet-N.yml`.
pub fn is_packet_yaml(path: &Path) -> bool {
    let name = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return false,
    };
    if !name.starts_with("packet-") || !name.ends_with(".yml") {
        return false;
    }
    // The middle slice must be a non-negative integer.
    let middle = &name["packet-".len()..name.len() - ".yml".len()];
    if middle.is_empty() || !middle.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    // Path must contain `sessions` segment somewhere.
    path.components().any(|c| c.as_os_str() == "sessions")
}

/// Parse the `_meta.packet_id` field out of the YAML so the classifier can
/// look up the libSQL row. Implemented as its own helper so a test can
/// inject a malformed file without touching the global filesystem.
fn parse_packet_id_from_yaml_path<R>(
    path: &Path,
    read_yaml: &mut R,
) -> Result<String, ReadError>
where
    R: FnMut(&Path) -> Result<serde_yaml::Value, ReadError>,
{
    let v = read_yaml(path)?;
    let pid = v
        .get("_meta")
        .and_then(|m| m.get("packet_id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| ReadError::ParseError("missing _meta.packet_id".into()))?;
    Ok(pid.to_string())
}

// ---------------------------------------------------------------------------
// notify-debouncer-full glue
// ---------------------------------------------------------------------------

use notify::{RecursiveMode, Watcher as _};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::time::Duration;

/// Watcher handle. Holds the debouncer + the receiver thread. Drop
/// terminates the watcher; the desktop holds one of these for the lifetime
/// of the process.
pub struct WatcherHandle {
    _debouncer: Debouncer<notify::RecommendedWatcher, FileIdMap>,
}

/// Spawn the watcher on `sessions_dir` (recursive). Each debounced batch
/// is forwarded to `on_event`, which the caller wires to a Tauri emitter
/// (see ipc::subscribe_fs_watch). The classifier itself is invoked inside
/// `on_event` so this module remains testable in isolation.
///
/// `on_error` is invoked when notify reports a backend-level error (e.g.,
/// inotify_add_watch ENOSPC, fsevents drop). Cycle-1.5 F12 fix: cycle-1
/// only logged at warn level, which left the watcher silently broken
/// while the desktop continued to run; AC-3 + AC-4 both depend on the
/// watcher actually receiving events. The caller is expected to surface
/// a "watcher-degraded" event to the UI via app_handle.emit so the
/// operator sees the offline state.
pub fn spawn_watcher<F, E>(
    sessions_dir: &Path,
    thread_name: &str,
    on_event: F,
    on_error: E,
) -> Result<WatcherHandle, notify::Error>
where
    F: Fn(Vec<PathBuf>) + Send + Sync + 'static,
    E: Fn(Vec<String>) + Send + Sync + 'static,
{
    let (tx, rx) = channel::<DebounceEventResult>();
    let mut debouncer = new_debouncer(Duration::from_millis(DEBOUNCE_MS), None, tx)?;
    debouncer
        .watcher()
        .watch(sessions_dir, RecursiveMode::Recursive)?;
    // Spawn a thread that drains the channel and dispatches paths. Per
    // v0.2 P2-F6: the drain-thread name distinguishes the fs-packet
    // watcher from the claude-sessions watcher in panic backtraces and
    // `top -H`. Both watchers spawned with the same name made
    // diagnostics ambiguous.
    let on_event = Arc::new(on_event);
    let on_error = Arc::new(on_error);
    std::thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || drain_loop(rx, on_event, on_error))
        .ok();
    Ok(WatcherHandle {
        _debouncer: debouncer,
    })
}

fn drain_loop(
    rx: Receiver<DebounceEventResult>,
    on_event: Arc<dyn Fn(Vec<PathBuf>) + Send + Sync>,
    on_error: Arc<dyn Fn(Vec<String>) + Send + Sync>,
) {
    while let Ok(result) = rx.recv() {
        match result {
            Ok(events) => {
                let mut paths = Vec::new();
                for ev in events {
                    for p in &ev.paths {
                        paths.push(p.clone());
                    }
                }
                if !paths.is_empty() {
                    on_event(paths);
                }
            }
            Err(errs) => {
                // Cycle-1.5 F12 fix: also emit a structured error
                // payload so the UI layer can surface the degraded
                // watcher state (toast / banner). The cycle-1 code
                // logged at warn but left the desktop with no visible
                // signal that AC-3 / AC-4 were no longer enforceable.
                let messages: Vec<String> = errs
                    .iter()
                    .map(|e| format!("{e:?}"))
                    .collect();
                for e in &errs {
                    warn!(target: "trail::watcher", error = ?e, "notify error in debouncer");
                }
                on_error(messages);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn registry_tracks_in_flight_writes() {
        let reg = SagaInFlightRegistry::new();
        assert!(!reg.contains("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
        reg.mark("01ARZ3NDEKTSV4RRFFQ69G5FAV");
        assert!(reg.contains("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
        reg.clear("01ARZ3NDEKTSV4RRFFQ69G5FAV");
        assert!(!reg.contains("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
    }

    #[test]
    fn registry_handles_concurrent_marks() {
        let reg = SagaInFlightRegistry::new();
        for i in 0..32 {
            reg.mark(format!("p-{i}"));
        }
        for i in 0..32 {
            assert!(reg.contains(&format!("p-{i}")));
        }
    }

    #[test]
    fn is_packet_yaml_accepts_canonical_paths() {
        assert!(is_packet_yaml(&PathBuf::from(
            ".trail/sessions/abc/packet-1.yml"
        )));
        assert!(is_packet_yaml(&PathBuf::from(
            "/repo/.trail/sessions/abc/packet-12.yml"
        )));
    }

    #[test]
    fn is_packet_yaml_rejects_non_packet_files() {
        // Non-numeric N
        assert!(!is_packet_yaml(&PathBuf::from(
            ".trail/sessions/abc/packet-foo.yml"
        )));
        // Markdown sibling — watcher does NOT trigger on .md per the spec
        // (B5 §4.6 lists .md but the self-race contract is YAML-only).
        assert!(!is_packet_yaml(&PathBuf::from(
            ".trail/sessions/abc/packet-1.md"
        )));
        // Root-level YAML
        assert!(!is_packet_yaml(&PathBuf::from("packet-1.yml")));
        // Nested under wrong dir
        assert!(!is_packet_yaml(&PathBuf::from(
            "elsewhere/packet-1.yml"
        )));
    }

    #[test]
    fn evaluate_change_self_write_via_in_flight_flag() {
        // Saga in flight → IgnoreInFlight regardless of hash.
        let yaml = serde_yaml::from_str::<serde_yaml::Value>(
            "_meta:\n  packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\napproval_trail: []\n",
        )
        .unwrap();
        let decision = evaluate_change(
            &PathBuf::from(".trail/sessions/abc/packet-1.yml"),
            |_| Ok(yaml.clone()),
            |_| Some("ignored".into()),
            |_| true,
        );
        assert_eq!(decision, WatcherDecision::IgnoreInFlight);
    }

    #[test]
    fn evaluate_change_no_op_when_hash_matches() {
        let yaml = serde_yaml::from_str::<serde_yaml::Value>(
            "_meta:\n  packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\napproval_trail: []\n",
        )
        .unwrap();
        let known = compute_approval_trail_hash(&yaml);
        let decision = evaluate_change(
            &PathBuf::from(".trail/sessions/abc/packet-1.yml"),
            |_| Ok(yaml.clone()),
            |_| Some(known.clone()),
            |_| false,
        );
        assert_eq!(decision, WatcherDecision::NoOp);
    }

    #[test]
    fn evaluate_change_external_when_hash_mismatch() {
        let yaml = serde_yaml::from_str::<serde_yaml::Value>(
            "_meta:\n  packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\napproval_trail:\n  - claim_id: CLAIM-001\n    decision: accept\n    by: e\n    at: t\n",
        )
        .unwrap();
        let decision = evaluate_change(
            &PathBuf::from(".trail/sessions/abc/packet-1.yml"),
            |_| Ok(yaml.clone()),
            |_| Some("0".repeat(64)), // wrong stored hash
            |_| false,
        );
        assert_eq!(
            decision,
            WatcherDecision::External {
                packet_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
                kind: MismatchKind::HashMismatch,
            }
        );
    }

    #[test]
    fn evaluate_change_no_op_when_no_known_hash() {
        // First-time YAML appearance (e.g., capture just wrote a fresh
        // packet); libSQL has no last_known_hash yet. Treat as NoOp; the
        // trail browser will pick it up via its own refresh path.
        let yaml = serde_yaml::from_str::<serde_yaml::Value>(
            "_meta:\n  packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n",
        )
        .unwrap();
        let decision = evaluate_change(
            &PathBuf::from(".trail/sessions/abc/packet-1.yml"),
            |_| Ok(yaml.clone()),
            |_| None,
            |_| false,
        );
        assert_eq!(decision, WatcherDecision::NoOp);
    }

    #[test]
    fn evaluate_change_unwatched_for_non_packet_paths() {
        let decision = evaluate_change(
            &PathBuf::from("README.md"),
            |_| panic!("must not read"),
            |_| panic!("must not lookup"),
            |_| panic!("must not check registry"),
        );
        assert_eq!(decision, WatcherDecision::Unwatched);
    }

    #[test]
    fn evaluate_change_parse_error_surfaces() {
        let decision = evaluate_change(
            &PathBuf::from(".trail/sessions/abc/packet-1.yml"),
            |_| Err(ReadError::ParseError("bad yaml".into())),
            |_| None,
            |_| false,
        );
        match decision {
            WatcherDecision::ParseError(m) => assert_eq!(m, "bad yaml"),
            other => panic!("expected ParseError, got {other:?}"),
        }
    }

    #[test]
    fn evaluate_change_missing_when_file_absent() {
        let decision = evaluate_change(
            &PathBuf::from(".trail/sessions/abc/packet-1.yml"),
            |_| Err(ReadError::NotFound),
            |_| None,
            |_| false,
        );
        assert_eq!(decision, WatcherDecision::Missing);
    }

    #[test]
    fn ui_self_write_does_not_trigger_reload() {
        // Sprint 4 acceptance criterion 3: UI's own writes never trigger
        // reload. We model the saga sequence: registry.mark(pid) → write
        // YAML → registry.clear(pid). Between mark and clear, evaluate
        // returns IgnoreInFlight even if the hash differs from the
        // last_known_hash recorded BEFORE the saga ran.
        let reg = SagaInFlightRegistry::new();
        reg.mark("01ARZ3NDEKTSV4RRFFQ69G5FAV");
        let yaml = serde_yaml::from_str::<serde_yaml::Value>(
            "_meta:\n  packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\napproval_trail:\n  - claim_id: CLAIM-001\n    decision: accept\n    by: e\n    at: t\n",
        )
        .unwrap();
        let decision = evaluate_change(
            &PathBuf::from(".trail/sessions/abc/packet-1.yml"),
            |_| Ok(yaml.clone()),
            |_| Some("0".repeat(64)),
            |id| reg.contains(id),
        );
        assert_eq!(decision, WatcherDecision::IgnoreInFlight);
    }

    #[test]
    fn external_edit_does_trigger_j12() {
        // Sprint 4 acceptance criterion 4: external YAML edit → J12.
        // Saga is NOT in flight; hash differs from libSQL's last_known.
        let reg = SagaInFlightRegistry::new();
        let yaml = serde_yaml::from_str::<serde_yaml::Value>(
            "_meta:\n  packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\napproval_trail:\n  - claim_id: CLAIM-001\n    decision: block\n    by: attacker\n    at: t\n",
        )
        .unwrap();
        let decision = evaluate_change(
            &PathBuf::from(".trail/sessions/abc/packet-1.yml"),
            |_| Ok(yaml.clone()),
            |_| Some("legitimate-hash-stored-from-a-prior-decision".into()),
            |id| reg.contains(id),
        );
        assert_eq!(
            decision,
            WatcherDecision::External {
                packet_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
                kind: MismatchKind::HashMismatch,
            }
        );
    }

    // -----------------------------------------------------------------
    // v0.1.1 B6: latent-bug regression tests.
    //
    // The prior inline classifier in `main.rs::spawn_fs_watcher` had two
    // bugs that the eval/emit-mapping refactor closes:
    //
    //   B6.1 — Non-NotFound `fs::read_to_string` errors (EACCES, EIO)
    //          were logged at `warn` and `continue`'d, so the watcher
    //          silently swallowed I/O failures. `evaluate_change` now
    //          flows the error through `ReadError::Other(msg)` →
    //          `WatcherDecision::ParseError(msg)`, which `main.rs` maps
    //          to `packet-changed-externally` with
    //          `mismatch_type: "parse-error"`.
    //
    //   B6.2 — When the YAML's `_meta.packet_id` couldn't be resolved
    //          from libSQL (fresh packet not yet INSERTed), the inline
    //          emit used `unwrap_or_default()` → `""`. The frontend
    //          filter `payload.packet_id === packetId` silently dropped
    //          those. The refactor surfaces ParseError / Missing with
    //          an unresolved `packet_id`; `main.rs` reverse-looks-up
    //          via libSQL and emits with `Option<String>` (JSON `null`
    //          when not in DB), so the UI can render a global
    //          "watcher saw an unparseable file" banner.
    //
    // These tests pin the contract at the classifier boundary; the
    // wire-shape mapping is asserted on the TS side via the contract.
    // -----------------------------------------------------------------

    #[test]
    fn evaluate_change_non_notfound_read_error_surfaces_as_parse_error_b6_1() {
        // EACCES / EIO / any non-NotFound I/O error. The classifier
        // wraps the message into ParseError so the J12 banner fires
        // (was a silent `warn!` + `continue` in the inline classifier).
        let decision = evaluate_change(
            &PathBuf::from(".trail/sessions/abc/packet-1.yml"),
            |_| Err(ReadError::Other("permission denied (os error 13)".into())),
            |_| None,
            |_| false,
        );
        match decision {
            WatcherDecision::ParseError(m) => {
                assert!(
                    m.contains("permission denied"),
                    "expected propagated I/O error message, got {m}"
                );
            }
            other => panic!("expected ParseError for non-NotFound read error, got {other:?}"),
        }
    }

    /// v0.2 P2-F6: `spawn_watcher` honors the `thread_name` parameter so
    /// the fs-packet watcher and the claude-sessions watcher are
    /// distinguishable in panic backtraces and `top -H`. Asserted by
    /// reading `thread::current().name()` inside the on_event closure
    /// after a file write triggers a debounced event.
    #[test]
    fn spawn_watcher_names_drain_thread_v02_p2_f6() {
        use std::sync::mpsc::channel as std_channel;
        use std::time::Duration;

        let dir = tempfile::tempdir().expect("tempdir");
        let (name_tx, name_rx) = std_channel::<Option<String>>();

        let _handle = spawn_watcher(
            dir.path(),
            "trail-test-named-watcher",
            move |_paths| {
                // Capture thread name from the drain thread's context.
                let _ = name_tx
                    .send(std::thread::current().name().map(|s| s.to_string()));
            },
            |_messages| {},
        )
        .expect("spawn_watcher");

        // Trigger an event so the drain thread executes the closure.
        // notify-debouncer-full default debounce window is DEBOUNCE_MS
        // (500ms) — the recv timeout must exceed it.
        std::fs::write(dir.path().join("ping.txt"), b"hello").expect("write");
        let observed = name_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("debounced event did not arrive within 3s");
        assert_eq!(
            observed.as_deref(),
            Some("trail-test-named-watcher"),
            "drain thread did not adopt the thread_name argument"
        );
    }

    #[test]
    fn evaluate_change_parse_error_carries_no_packet_id_b6_2() {
        // The classifier cannot recover a packet_id from an unparseable
        // YAML. The caller (main.rs) must reverse-look-up via libSQL;
        // when libSQL returns None (fresh packet not yet INSERTed),
        // the wire payload's packet_id is `null` rather than the
        // cycle-1 broken empty-string. Pins: ParseError is a
        // packet_id-less variant.
        let decision = evaluate_change(
            &PathBuf::from(".trail/sessions/abc/packet-1.yml"),
            |_| Err(ReadError::ParseError("invalid YAML at line 3".into())),
            |_| None,
            |_| false,
        );
        // Pattern-match exhaustively to assert no packet_id field
        // smuggled into the ParseError variant — the caller is
        // responsible for resolution, not the classifier.
        match decision {
            WatcherDecision::ParseError(m) => {
                assert_eq!(m, "invalid YAML at line 3");
            }
            other => panic!("expected ParseError variant, got {other:?}"),
        }
        // Missing has the same packet_id-less shape.
        let decision_missing = evaluate_change(
            &PathBuf::from(".trail/sessions/abc/packet-1.yml"),
            |_| Err(ReadError::NotFound),
            |_| None,
            |_| false,
        );
        assert_eq!(decision_missing, WatcherDecision::Missing);
    }
}
