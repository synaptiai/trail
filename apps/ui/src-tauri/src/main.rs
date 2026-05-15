// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli_bridge;
#[cfg(test)]
mod capabilities_negative;
mod db;
mod ipc;
mod migrations;
mod saga;
mod settings;
mod shell_allowlist;
mod watcher;
mod yaml_safety;

use tauri::{Emitter, Manager};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

fn main() {
    // Tracing initialization (per F15 — Sprint 1 baseline).
    //
    // Sprint 4 still uses stderr-only via tracing_subscriber::fmt(); the
    // saga-recovery audit trail flows through libSQL `audit_log` rows
    // (B5 §7.1) so a rolling file appender is not yet required.
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let db_path = match db::resolve_db_path() {
        Ok(p) => p,
        Err(e) => {
            error!(target: "trail::boot", error = %e, "could not resolve db path");
            std::process::exit(1);
        }
    };
    let mut conn = match db::open_and_migrate(&db_path) {
        Ok(c) => c,
        Err(e) => {
            error!(target: "trail::boot", path = %db_path.display(), error = %e, "db open/migrate failed");
            std::process::exit(1);
        }
    };
    info!(target: "trail::boot", path = %db_path.display(), "db ready");

    // Sprint 4 (gh#11 criterion 2): boot-time saga recovery scan.
    //
    // Walk every `.trail/sessions/*/.pending-*.json` marker; for each
    // pre-libsql marker with a matching YAML hash, invoke a synthetic
    // rebuild that re-parses the canonical YAML and re-INSERTs the
    // approval_trail rows. This closes the SIGKILL window between
    // saga step 6 (rename) and step 8 (libSQL TX).
    if let Some(sessions_dir) = resolve_trail_sessions_dir() {
        let mut rebuild = build_recovery_rebuild_closure(&mut conn);
        let report = saga::recover_pending_sagas(&sessions_dir, &mut rebuild);
        if report.recovered + report.stale_dropped > 0 {
            info!(
                target: "trail::boot",
                recovered = report.recovered,
                stale = report.stale_dropped,
                errors = report.errors.len(),
                "saga recovery scan completed at boot"
            );
        }
        for err in &report.errors {
            warn!(target: "trail::boot::recover", error = %err, "saga recovery non-fatal error");
        }
    }

    // Sprint 4: load Layer 2 redaction patterns from the bundled YAML so
    // the saga's strict-redaction gate runs in production. The patterns
    // file ships in `bin/trail-redaction-patterns.yml` (workspace root)
    // and is workspace-relative; if absent (e.g., a packaged binary
    // without the bundled file), the saga falls back to an empty pattern
    // set with a warning.
    let layer2_patterns = load_layer2_patterns().unwrap_or_else(|e| {
        warn!(
            target: "trail::boot",
            error = %e,
            "could not load layer-2 redaction patterns; saga gate runs with empty set"
        );
        Vec::new()
    });

    let saga_state = ipc::SagaState::new(layer2_patterns);

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(db::DbState::new(conn))
        .manage(saga_state)
        .setup(|app| {
            // Sprint 4 (gh#11 criterion 3): spawn the filesystem watcher on
            // app setup so the desktop is reactive to external edits from
            // boot. The watcher emits Tauri events; the frontend listens
            // via `@tauri-apps/api/event#listen`.
            spawn_fs_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::read_packet,
            ipc::save_decision,
            ipc::override_risk,
            ipc::post_to_pr,
            ipc::decide_on_pr,
            ipc::query_trail,
            ipc::query_recent_sessions,
            ipc::read_settings,
            ipc::write_settings,
            ipc::preview_redacted,
            ipc::audit_log_append,
            ipc::subscribe_fs_watch,
            ipc::subscribe_settings_change,
            ipc::validate_capture_cli_path,
            #[cfg(any(debug_assertions, feature = "test-fixtures"))]
            ipc::seed_stress_packets,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Cycle-2 C9 (PR #21): cross-language IPC drift pin.
//
// `apps/ui/src/ipc/contract.ts::IPC_COMMAND_SCHEMAS` lists 14 IPC
// commands; `apps/ui/tests/unit/ipc-contract.test.ts` pins that list
// against a literal sorted array. Trail does NOT use ts-rs / tauri-specta
// so an authoritative codegen step does not exist; instead we pin BOTH
// directions:
//   - TS side: ipc-contract.test.ts (already exists at L21-36).
//   - Rust side: this test parses main.rs and asserts the
//     generate_handler! list contains the same 14 production commands
//     (the dev-only `seed_stress_packets` is excluded).
//
// If a Rust handler is added or removed without updating the literal
// here AND in contract.ts, `cargo test --locked` fails. If a TS handler
// drifts, ipc-contract.test.ts fails. Either failure blocks merge.
// Referenced only from `#[cfg(test)] mod ipc_handler_pin_tests` below
// (which does `use super::PINNED_IPC_HANDLERS;` + source-text parsing of
// this same file via `fs::read_to_string`). Non-test builds therefore see
// the const as unreferenced — the test-only consumer doesn't satisfy
// `#[allow(dead_code)]`'s "used" check across cfg boundaries. The lint
// silence keeps the drift guard intact across build profiles.
//
// Cycle-1 F2-19 originally suppressed this warning; cycle-3 C3-S-CR-4 +
// C3-S-TR-004 (consensus) corrected the rationale — the prior comment
// cited a non-existent `tests/ipc_handler_drift.rs` and missed the real
// in-file `#[cfg(test)]` consumer.
#[allow(dead_code)]
const PINNED_IPC_HANDLERS: &[&str] = &[
    "audit_log_append",
    "decide_on_pr",
    "override_risk",
    "post_to_pr",
    "preview_redacted",
    "query_recent_sessions",
    "query_trail",
    "read_packet",
    "read_settings",
    "save_decision",
    "subscribe_fs_watch",
    "subscribe_settings_change",
    "validate_capture_cli_path",
    "write_settings",
];

#[cfg(test)]
mod ipc_handler_pin_tests {
    use super::PINNED_IPC_HANDLERS;
    use std::fs;

    /// Pin the Rust `tauri::generate_handler!` list against
    /// `PINNED_IPC_HANDLERS`. Production handlers only — the
    /// debug/test-fixtures-gated `seed_stress_packets` is excluded.
    ///
    /// Drift modes this test detects:
    ///   - Rust adds a handler but TS contract.ts not updated.
    ///   - Rust removes a handler but TS contract.ts not updated.
    ///   - Renamed handler (case-sensitive comparison).
    ///
    /// The companion TS test
    /// `apps/ui/tests/unit/ipc-contract.test.ts` asserts the same
    /// literal list against `Object.keys(IPC_COMMAND_SCHEMAS)`.
    ///
    /// Cycle-3 (PR #21):
    ///   - C9 Rust pin source-text: the test reads `src/main.rs` from
    ///     disk at runtime. Anchored against `CARGO_MANIFEST_DIR` so
    ///     `cargo test` from any CWD (workspace root, IDE-driven test
    ///     run) finds the file. Previous code used the bare relative
    ///     path which only worked when the test ran from
    ///     `apps/ui/src-tauri`.
    ///   - F5 inline-comment fragility: the parser previously didn't
    ///     strip inline `// ...` comments before checking line shape.
    ///     A trailing comment like `ipc::foo, // notes` would parse
    ///     as a name `foo,` with the comment glued on; the
    ///     `trim_end_matches(',')` masked it but a future change
    ///     adding `ipc::foo // experimental` (no trailing comma) would
    ///     parse `foo` plus `//` plus `experimental` as one name. Strip
    ///     `//` and everything after BEFORE the shape match.
    #[test]
    fn ipc_handler_registration_pinned() {
        // Cycle-3 C9 / F5 (PR #21): anchor the path to CARGO_MANIFEST_DIR
        // so the test runs regardless of cargo CWD.
        let main_rs_path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/main.rs");
        let main_rs = fs::read_to_string(main_rs_path)
            .expect("read src/main.rs via CARGO_MANIFEST_DIR anchor");

        // Extract the body between `tauri::generate_handler![` and the
        // matching `])`. Stop at the first `])` after the macro start.
        let start_marker = "tauri::generate_handler![";
        let start = main_rs
            .find(start_marker)
            .expect("generate_handler! invocation must exist in main.rs");
        let after_start = &main_rs[start + start_marker.len()..];
        let end = after_start
            .find("])")
            .expect("generate_handler! invocation must end with `])`");
        let body = &after_start[..end];

        // Collect each `ipc::<name>` reference. Skip lines that are
        // gated by `#[cfg(...)]` for non-production builds — the
        // simplest filter: drop any line whose previous non-empty line
        // starts with `#[cfg(any(debug_assertions, feature =`.
        //
        // Cycle-3 F5 (PR #21): strip inline `//` comments before
        // matching so a future trailing-comment addition doesn't
        // smuggle text into the parsed handler name.
        let mut prod_handlers: Vec<String> = Vec::new();
        let mut prev_was_cfg_gate = false;
        for raw_line in body.lines() {
            // F5: drop everything from the first `//` onward, then
            // trim. A line that's purely a comment becomes empty
            // and falls through to the empty-string skip.
            let line = raw_line.split("//").next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            if line.starts_with("#[cfg(any(debug_assertions") {
                prev_was_cfg_gate = true;
                continue;
            }
            if let Some(after) = line.strip_prefix("ipc::") {
                let name = after.trim_end_matches(',').trim().to_string();
                if !prev_was_cfg_gate {
                    prod_handlers.push(name);
                }
                prev_was_cfg_gate = false;
                continue;
            }
            prev_was_cfg_gate = false;
        }

        prod_handlers.sort();
        let mut pinned: Vec<String> = PINNED_IPC_HANDLERS.iter().map(|s| s.to_string()).collect();
        pinned.sort();

        assert_eq!(
            prod_handlers, pinned,
            "Rust generate_handler! drifted from PINNED_IPC_HANDLERS — \
             update both main.rs (handler registration) and \
             apps/ui/src/ipc/contract.ts::IPC_COMMAND_SCHEMAS, then \
             update PINNED_IPC_HANDLERS + ipc-contract.test.ts to \
             match."
        );
    }
}

/// Construct a closure that rebuilds libSQL state for one packet from its
/// on-disk YAML (B5 §3.3 contract). Used by the boot-time recovery scan;
/// the closure captures the connection by mutable reference because
/// rebuild may run multiple times (idempotent per the spec).
fn build_recovery_rebuild_closure(
    conn: &mut rusqlite::Connection,
) -> Box<dyn FnMut(&saga::IntentLogMarker) -> Result<(), saga::SagaError> + '_> {
    Box::new(move |marker: &saga::IntentLogMarker| {
        let yaml = std::fs::read_to_string(&marker.yaml_path)?;
        let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml)
            .map_err(|e| saga::SagaError::YamlParse(e.to_string()))?;
        let entries = parsed
            .get("approval_trail")
            .and_then(|v| v.as_sequence())
            .cloned()
            .unwrap_or_default();
        let approval_hash = saga::compute_approval_trail_hash(&parsed);
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute(
            "DELETE FROM approval_trail WHERE packet_id = ?1",
            [&marker.packet_id],
        )?;
        for (i, entry) in entries.iter().enumerate() {
            let claim_id = entry
                .get("claim_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| saga::SagaError::Recovery("missing claim_id".into()))?;
            let decision = entry
                .get("decision")
                .and_then(|v| v.as_str())
                .ok_or_else(|| saga::SagaError::Recovery("missing decision".into()))?;
            let reason = entry.get("reason").and_then(|v| v.as_str());
            let by = entry
                .get("by")
                .and_then(|v| v.as_str())
                .ok_or_else(|| saga::SagaError::Recovery("missing by".into()))?;
            let at = entry
                .get("at")
                .and_then(|v| v.as_str())
                .ok_or_else(|| saga::SagaError::Recovery("missing at".into()))?;
            tx.execute(
                "INSERT INTO approval_trail (packet_id, claim_id, decision, reason, decided_by, decided_at, position) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    marker.packet_id,
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
            rusqlite::params![approval_hash, marker.packet_id],
        )?;
        tx.commit()?;
        Ok(())
    })
}

fn load_layer2_patterns() -> Result<Vec<(String, regex::Regex)>, String> {
    // Search for the bundled patterns file walking up from cwd. Keeps
    // this v0.1 simple — a packaged binary would embed the patterns at
    // build-time (e.g. via `include_str!`); this is acceptable for the
    // Sprint 4 development surface.
    let mut here = std::env::current_dir().map_err(|e| e.to_string())?;
    loop {
        let candidate = here.join("bin").join("trail-redaction-patterns.yml");
        if candidate.exists() {
            return parse_patterns_file(&candidate);
        }
        if !here.pop() {
            return Err("trail-redaction-patterns.yml not found".into());
        }
    }
}

/// Walk ancestors of cwd to find a `.trail/sessions/` directory. v0.1
/// runs against a single repo at a time (B5 §4.6), so this is the
/// canonical way to locate the watched tree without a user-supplied
/// path. Returns None when no such ancestor exists (Trail is being
/// launched outside any repo); callers degrade gracefully.
fn resolve_trail_sessions_dir() -> Option<std::path::PathBuf> {
    let mut here = std::env::current_dir().ok()?;
    loop {
        let candidate = here.join(".trail").join("sessions");
        if candidate.exists() {
            return Some(candidate);
        }
        if !here.pop() {
            return None;
        }
    }
}

fn parse_patterns_file(path: &std::path::Path) -> Result<Vec<(String, regex::Regex)>, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let v: serde_yaml::Value = serde_yaml::from_str(&raw).map_err(|e| e.to_string())?;
    let arr = v
        .get("patterns")
        .and_then(|p| p.as_sequence())
        .ok_or_else(|| "patterns: not a sequence".to_string())?;
    let mut out = Vec::new();
    for entry in arr {
        let name = entry
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "pattern.name missing".to_string())?
            .to_string();
        let pattern = entry
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "pattern.pattern missing".to_string())?;
        let flags = entry.get("flags").and_then(|v| v.as_str()).unwrap_or("");
        let prefixed = if flags.is_empty() {
            pattern.to_string()
        } else {
            // `regex` crate supports inline group flags `(?ims)` etc.
            // mapped from the YAML 'flags' field (subset of 'imsx').
            format!("(?{flags}){pattern}")
        };
        match regex::Regex::new(&prefixed) {
            Ok(r) => out.push((name, r)),
            Err(e) => warn!(
                target: "trail::saga::layer2",
                name = %name,
                error = %e,
                "skipping pattern that did not compile"
            ),
        }
    }
    Ok(out)
}

fn spawn_fs_watcher<R: tauri::Runtime>(handle: tauri::AppHandle<R>) {
    // Watch the repo's `.trail/sessions/` directory. Walks ancestors
    // from cwd to find the nearest `.trail/sessions/` directory; if
    // none, the watcher does not start (no harm — the user has not
    // opened a Trail repo yet).
    let Some(sessions_dir) = resolve_trail_sessions_dir() else {
        info!(
            target: "trail::watcher",
            "no .trail/sessions/ directory in cwd or ancestors; watcher idle"
        );
        return;
    };

    let handle_clone = handle.clone();
    let handle_for_error = handle.clone();
    let result = watcher::spawn_watcher(
        &sessions_dir,
        move |paths| {
        let h = handle_clone.clone();
        // Process each path through the classifier. The classifier needs
        // (path, read_yaml, lookup_known_hash, saga_in_flight). We
        // resolve all of these here and emit Tauri events accordingly.
        for path in paths {
            // Cycle-1.5 F2 fix (gh#11 AC-4 closure for parse-error /
            // missing branches): reverse-lookup the packet_id from the
            // path via libSQL BEFORE emitting parse-error / missing
            // events so the frontend's `packet_id === packetId` filter
            // surfaces the J12 banner for the open packet. Cycle-1
            // emitted with `packet_id: ""` which the React filter
            // silently swallowed.
            let resolved_packet_id: String = {
                let db_state = h.state::<db::DbState>();
                let resolved = match db_state.0.lock() {
                    Ok(conn) => db::select_packet_id_by_path(&conn, &path)
                        .ok()
                        .flatten()
                        .unwrap_or_default(),
                    Err(_) => String::new(),
                };
                resolved
            };
            let yaml_text = match std::fs::read_to_string(&path) {
                Ok(s) => Some(s),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => {
                    warn!(target: "trail::watcher", path = %path.display(), error = %e, "watcher read failed");
                    continue;
                }
            };
            let parsed = match yaml_text.as_deref().map(serde_yaml::from_str::<serde_yaml::Value>) {
                Some(Ok(v)) => Some(v),
                Some(Err(e)) => {
                    let _ = h.emit(
                        "packet-changed-externally",
                        serde_json::json!({
                            "packet_id": resolved_packet_id,
                            "mismatch_type": "parse-error",
                            "message": e.to_string(),
                        }),
                    );
                    continue;
                }
                None => None,
            };
            let Some(parsed) = parsed else {
                let _ = h.emit(
                    "packet-changed-externally",
                    serde_json::json!({
                        "packet_id": resolved_packet_id,
                        "mismatch_type": "missing",
                    }),
                );
                continue;
            };
            let packet_id = parsed
                .get("_meta")
                .and_then(|m| m.get("packet_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if packet_id.is_empty() {
                continue;
            }
            // Self-write check: registry membership.
            let saga_state = h.state::<ipc::SagaState>();
            if saga_state.registry.contains(&packet_id) {
                continue; // ignore — the saga itself is mid-write
            }
            // Hash compare.
            let db_state = h.state::<db::DbState>();
            let stored_hash = match db_state.0.lock() {
                Ok(conn) => conn
                    .query_row(
                        "SELECT last_known_hash FROM packets WHERE packet_id = ?1",
                        [&packet_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .ok()
                    .flatten(),
                Err(_) => None,
            };
            let current_hash = saga::compute_approval_trail_hash(&parsed);
            match stored_hash {
                Some(stored) if stored == current_hash => {
                    // No-op: in sync. Still notify the trail browser
                    // path so a freshly-captured packet (just appended
                    // via capture CLI) shows up.
                    let _ = h.emit("trail-needs-refresh", serde_json::json!({}));
                }
                Some(_) => {
                    let _ = h.emit(
                        "packet-changed-externally",
                        serde_json::json!({
                            "packet_id": packet_id,
                            "mismatch_type": "hash-mismatch",
                        }),
                    );
                }
                None => {
                    // No prior hash — first-touch packet. Trail refresh.
                    let _ = h.emit("trail-needs-refresh", serde_json::json!({}));
                }
            }
        }
        },
        // Cycle-1.5 F12 fix: emit a UI-facing event when the notify
        // backend reports an error (e.g., inotify_add_watch ENOSPC,
        // fsevents drop). Without this signal the watcher silently
        // stops and AC-3 / AC-4 become unenforceable while the desktop
        // continues to run. The frontend listens for "watcher-degraded"
        // and surfaces a banner.
        move |messages| {
            let _ = handle_for_error.emit(
                "watcher-degraded",
                serde_json::json!({
                    "messages": messages,
                }),
            );
        },
    );
    match result {
        Ok(handle) => {
            // Hold the handle for the app lifetime — drop terminates
            // the watcher. We `Box::leak` so the handle never drops
            // (acceptable for a singleton at app boot).
            Box::leak(Box::new(handle));
            info!(target: "trail::watcher", path = %sessions_dir.display(), "watcher started");
        }
        Err(e) => {
            error!(target: "trail::watcher", error = %e, "spawn_watcher failed");
        }
    }
}
