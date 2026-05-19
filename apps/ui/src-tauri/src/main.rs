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
            ipc::detect_capture_cli,
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
    "detect_capture_cli",
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

// [gh#9 / 2026-05-18] Layer 2 patterns compile-time embed.
//
// Closes v0.1.1 security audit P3-6 (CWD-trust on patterns load). The
// previous implementation walked CWD ancestors looking for
// `bin/trail-redaction-patterns.yml` — any directory the user `cd`s to
// before launching the desktop binary could host a hostile YAML that
// would be loaded in place of the bundled one. The mitigation in v0.1.1
// (`yaml_safety::guard()` at parse) limited the blast radius but did
// not close the substitution itself.
//
// This test pair pins two properties of `load_layer2_patterns()`:
//
//   1. `parse_patterns_str(&str)` (the new pure-parser entry point used
//      by the include_str! path) successfully parses the canonical
//      bundled YAML and returns a non-empty pattern set including known
//      names.
//   2. The body of `fn load_layer2_patterns` contains `include_str!`
//      and contains no CWD-walking constructs (`current_dir(` /
//      `.pop()`). This is a structural guard against re-introducing the
//      P3-6 attack surface. The IPC handler pin test
//      (`ipc_handler_registration_pinned`, above) uses the same
//      source-read pattern.
#[cfg(test)]
mod layer2_embed_tests {
    use super::*;
    use std::fs;

    #[test]
    fn parse_patterns_str_parses_bundled_yaml() {
        let yaml = include_str!("../../../../bin/trail-redaction-patterns.yml");
        let result = parse_patterns_str(yaml);
        assert!(result.is_ok(), "parse_patterns_str failed: {:?}", result);
        let patterns = result.unwrap();
        assert!(!patterns.is_empty(), "expected non-empty pattern set");
        let names: Vec<&str> = patterns.iter().map(|(n, _)| n.as_str()).collect();
        assert!(
            names.contains(&"aws-access-key"),
            "missing aws-access-key in bundled set: {:?}",
            names
        );
        assert!(
            names.contains(&"home-path"),
            "missing home-path in bundled set: {:?}",
            names
        );
    }

    #[test]
    fn load_layer2_patterns_uses_compile_time_embed_only() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/main.rs");
        let src = fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("read main.rs at {path}: {e}"));
        // The test mod is above the function definition AND mentions
        // the function name in literals (error messages, this marker
        // string itself). `rfind` pins to the last occurrence — the
        // actual definition — regardless of how many literal mentions
        // appear in the source above it.
        let fn_marker = "fn load_layer2_patterns() -> Result";
        let fn_start = src
            .rfind(fn_marker)
            .unwrap_or_else(|| panic!("load_layer2_patterns must exist in {path}"));
        // Find the opening brace of the function body.
        let body_open_rel = src[fn_start..]
            .find('{')
            .unwrap_or_else(|| panic!("load_layer2_patterns must have a body in {path}"));
        let body_open = fn_start + body_open_rel;
        // Walk forward, counting brace depth, to find the matching close.
        let mut depth = 0i32;
        let mut body_close = body_open;
        for (i, ch) in src[body_open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        body_close = body_open + i + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &src[body_open..body_close];
        // Cycle-1 F2 (P2): the brace counter is byte-naive — it counts
        // every `{`/`}` including those inside string literals, char
        // literals, format strings, and `r#"..."#` raw strings. If a
        // future edit adds e.g. `tracing::warn!("x {y}", y = …)` inside
        // the function body, the counter would prematurely terminate
        // and the forbidden-construct asserts below would scan a
        // truncated body — silently passing while the real body
        // contains the construct. Mitigation: assert the extracted
        // body contains the function's only outbound call
        // (`parse_patterns_str(`) and is at least ~200 chars (the
        // include_str! line + comments + the parse call). Either gate
        // failing means the brace walker landed in the wrong place,
        // and the test fails-fast with a clear message rather than a
        // misleading PASS.
        assert!(
            body.contains("parse_patterns_str("),
            "extracted body did not contain expected outbound call \
             `parse_patterns_str(`; brace counter likely walked past \
             the function close. Body length: {}. Body:\n{}",
            body.len(),
            body
        );
        assert!(
            body.len() > 200,
            "extracted body unreasonably short ({} chars) — brace counter \
             likely terminated early. Body:\n{}",
            body.len(),
            body
        );
        // Required: compile-time embed.
        assert!(
            body.contains("include_str!"),
            "load_layer2_patterns must embed the bundled YAML via include_str! (gh#9 AC#2). Body:\n{}",
            body
        );
        // Forbidden: CWD-walking constructs (v0.1.1 P3-6).
        assert!(
            !body.contains("current_dir("),
            "load_layer2_patterns must NOT call std::env::current_dir() (v0.1.1 P3-6). Body:\n{}",
            body
        );
        assert!(
            !body.contains(".pop()"),
            "load_layer2_patterns must NOT walk path ancestors via .pop() (v0.1.1 P3-6). Body:\n{}",
            body
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
        // v0.1.1 B7: gate boot recovery YAML against anchor-bomb / oversize
        // attacks. A marker pointing at hostile YAML would otherwise hit an
        // unbounded serde_yaml::from_str during the recovery scan and OOM
        // the desktop before the UI even starts.
        yaml_safety::guard(&yaml)
            .map_err(|e| saga::SagaError::YamlParse(format!("yaml_safety: {e:?}")))?;
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
    // gh#9 / 2026-05-18 (closes v0.1.1 security audit P3-6): the bundled
    // patterns YAML is embedded at compile time via `include_str!` and
    // parsed at boot. The previous implementation walked CWD ancestors
    // for `bin/trail-redaction-patterns.yml`, which let any directory
    // the user `cd`s to before launching the desktop binary substitute
    // a hostile patterns file (partially mitigated by `yaml_safety::guard()`
    // at parse, but the substitution itself was the deeper issue).
    //
    // The path resolves relative to this source file (4 levels up to
    // repo root, then into `bin/`); cargo recompiles automatically when
    // the embedded file changes. `yaml_safety::guard()` still runs on
    // the embedded YAML — even though it's trusted at build time, the
    // anchor-bomb / size check is cheap and preserves the gate against
    // future YAML changes that might violate the cap.
    //
    // gh#9 cycle-2 SEC-1 anchor pin: a second `include_bytes!` against
    // the same path makes a future move of main.rs (e.g., extraction
    // into a deeper crate) fail the build with a clear "file not
    // found" rather than silently re-pointing at a different file at a
    // different depth. Cheap and self-documenting.
    const _PATTERNS_ANCHOR: &[u8] = include_bytes!("../../../../bin/trail-redaction-patterns.yml");
    let embedded = include_str!("../../../../bin/trail-redaction-patterns.yml");
    parse_patterns_str(embedded)
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

// gh#9 / 2026-05-18: pure parser over a YAML string body. The only
// caller is `load_layer2_patterns()`, which now passes the compile-time
// embedded canonical YAML (closes v0.1.1 P3-6). The previous
// `parse_patterns_file(path)` was removed along with its filesystem
// read — no other caller existed.
//
// `yaml_safety::guard()` is retained even though the input is trusted
// at build time: the anchor-bomb / size check is cheap and preserves
// the gate against future YAML changes that might violate the cap.
fn parse_patterns_str(raw: &str) -> Result<Vec<(String, regex::Regex)>, String> {
    yaml_safety::guard(raw)
        .map_err(|e| format!("patterns file rejected by yaml_safety: {e:?}"))?;
    let v: serde_yaml::Value = serde_yaml::from_str(raw)
        .map_err(|e| format!("bundled patterns YAML parse: {e}"))?;
    let arr = v
        .get("patterns")
        .and_then(|p| p.as_sequence())
        .ok_or_else(|| "patterns: not a sequence".to_string())?;
    // gh#9 cycle-2 F1/ERR-1: explicit empty-array gate. `patterns: []`
    // deserializes to an empty sequence (not None), so the `ok_or_else`
    // above doesn't fire; without this check the empty-after-skip guard
    // at the loop's tail would also fall through (its `arr_len > 0`
    // qualifier was dropped — see below — but a separate early Err
    // surfaces the empty-catalog case more cleanly than waiting for the
    // tail check).
    if arr.is_empty() {
        return Err("patterns: empty sequence (no entries to compile)".to_string());
    }
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
    // gh#9 cycle-2 F1/ERR-1: if every catalog entry failed to compile,
    // the strict-redaction gate would silently run with an empty pattern
    // set — saga's Layer 2 scan would never catch anything, and the
    // caller's `unwrap_or_else(|| empty_set)` wouldn't fire because we'd
    // return Ok(empty). Surface this as Err so the boot-time fallback
    // log is taken intentionally. The single-pattern-failure case
    // (`out.len() < input` but `out.len() > 0`) remains silent-skip —
    // those failures are tolerated by design (e.g., a JS-only inline-
    // flag pattern in a user-supplied YAML).
    //
    // The early `if arr.is_empty()` gate above catches `patterns: []`
    // explicitly. The check here covers the "all entries failed to
    // compile" case where the input was non-empty but `out` is.
    if out.is_empty() {
        return Err("all pattern entries failed to compile; refusing to ship empty Layer 2 set"
            .to_string());
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
            // v0.1.1 B6: route each path through `watcher::evaluate_change`
            // so the classifier is the single source of truth (replaces the
            // previous inline re-implementation). The closures below resolve
            // (read_yaml, lookup_known_hash, saga_in_flight) from the Tauri
            // state; the returned `WatcherDecision` maps 1:1 onto the same
            // three event names emitted by the prior inline classifier
            // (`packet-changed-externally`, `trail-needs-refresh`,
            // `watcher-degraded`).
            for path in paths {
                dispatch_watcher_event(&h, &path);
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

/// v0.1.1 B6: classify one debounced filesystem event and emit the matching
/// Tauri event. The classifier (`watcher::evaluate_change`) is pure; this
/// function does the I/O — `fs::read_to_string` + `serde_yaml::from_str`
/// for the YAML read closure, a libSQL query for the known-hash lookup,
/// and the saga-in-flight registry for the self-write check.
///
/// Event-name contract (must stay byte-identical to v0.1.0):
///   - `packet-changed-externally` → J12 banner (mismatch_type: hash-mismatch,
///                                              parse-error, or missing).
///   - `trail-needs-refresh` → sidebar refresh; emitted for `NoOp` outcomes
///                             so freshly-captured packets show up.
///
/// Two latent bugs in the prior inline classifier are closed here:
///   B6.1 — Non-NotFound `read_to_string` errors (EACCES, EIO) now flow
///          through `ReadError::Other` → `WatcherDecision::ParseError`,
///          which emits `packet-changed-externally` with `mismatch_type:
///          "parse-error"`. The cycle-1.5 code logged at `warn!` and
///          `continue`'d, silently dropping the event.
///   B6.2 — `packet_id` is now `Option<String>` on the wire (serialized
///          as JSON `null` when libSQL has not yet ingested the path).
///          The cycle-1.5 code used `unwrap_or_default()` → `""`, which
///          the React filter `payload.packet_id === packetId` silently
///          dropped on every render of the open packet view.
fn dispatch_watcher_event<R: tauri::Runtime>(
    h: &tauri::AppHandle<R>,
    path: &std::path::Path,
) {
    // YAML read closure: returns the parsed serde_yaml::Value, or a
    // structured ReadError so the classifier can pick the right
    // WatcherDecision variant (Missing vs ParseError vs Other-as-
    // ParseError per B6.1).
    let read_yaml = |p: &std::path::Path| -> Result<serde_yaml::Value, watcher::ReadError> {
        match std::fs::read_to_string(p) {
            Ok(text) => {
                // v0.1.1 B7: gate watcher-observed YAML against
                // anchor-bomb / oversize attacks. A malicious YAML dropped
                // into .trail/sessions/ would otherwise hit an unbounded
                // serde_yaml::from_str on every filesystem-event tick.
                // Map a yaml_safety rejection to ParseError so the
                // existing WatcherDecision::ParseError branch surfaces it
                // as a J12 banner instead of a silent drop.
                if let Err(safety_err) = yaml_safety::guard(&text) {
                    return Err(watcher::ReadError::ParseError(format!(
                        "yaml_safety: {safety_err:?}"
                    )));
                }
                serde_yaml::from_str::<serde_yaml::Value>(&text)
                    .map_err(|e| watcher::ReadError::ParseError(e.to_string()))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Err(watcher::ReadError::NotFound)
            }
            Err(e) => Err(watcher::ReadError::Other(e.to_string())),
        }
    };

    // Known-hash lookup closure: returns `packets.last_known_hash` for
    // the resolved packet_id, or None when the packet has never had a
    // saved decision.
    let db_state = h.state::<db::DbState>();
    let lookup_known_hash = |packet_id: &str| -> Option<String> {
        match db_state.0.lock() {
            Ok(conn) => conn
                .query_row(
                    "SELECT last_known_hash FROM packets WHERE packet_id = ?1",
                    [packet_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .ok()
                .flatten(),
            Err(_) => None,
        }
    };

    // Saga-in-flight closure: the registry the saga driver mutates
    // around its critical-section write.
    let saga_state = h.state::<ipc::SagaState>();
    let saga_in_flight = |packet_id: &str| -> bool {
        saga_state.registry.contains(packet_id)
    };

    let decision = watcher::evaluate_change(path, read_yaml, lookup_known_hash, saga_in_flight);

    match decision {
        watcher::WatcherDecision::Unwatched | watcher::WatcherDecision::IgnoreInFlight => {
            // No emit. Unwatched paths fall outside the packet pattern;
            // IgnoreInFlight is the UI's own write — the saga's
            // post-write `registry.clear` is the only signal needed.
        }
        watcher::WatcherDecision::NoOp => {
            // In-sync: hash matches OR no prior hash (fresh capture).
            // Either way, refresh the trail browser so a newly-captured
            // packet shows up in the sidebar.
            let _ = h.emit("trail-needs-refresh", serde_json::json!({}));
        }
        watcher::WatcherDecision::External { packet_id, kind } => {
            let mismatch_type = match kind {
                watcher::MismatchKind::HashMismatch => "hash-mismatch",
            };
            // `evaluate_change` only constructs External after successfully
            // reading + parsing the YAML's _meta.packet_id, so we have a
            // concrete packet_id here. Serialize as a JSON string (not
            // null) so the React filter trips for the open packet.
            let _ = h.emit(
                "packet-changed-externally",
                serde_json::json!({
                    "packet_id": Some(packet_id),
                    "mismatch_type": mismatch_type,
                }),
            );
        }
        watcher::WatcherDecision::ParseError(message) => {
            // B6.2 reverse-lookup: the classifier couldn't parse the
            // YAML, so it does not know the packet_id. Reverse-resolve
            // from the path via libSQL; when the path isn't in libSQL
            // yet, emit with packet_id: null so the frontend can show
            // a global "watcher saw an unparseable file" banner rather
            // than silently dropping the event (the cycle-1.5 behavior
            // when `unwrap_or_default()` produced an empty string).
            let resolved_packet_id: Option<String> = match db_state.0.lock() {
                Ok(conn) => db::select_packet_id_by_path(&conn, path).ok().flatten(),
                Err(_) => None,
            };
            let _ = h.emit(
                "packet-changed-externally",
                serde_json::json!({
                    "packet_id": resolved_packet_id,
                    "mismatch_type": "parse-error",
                    "message": message,
                }),
            );
        }
        watcher::WatcherDecision::Missing => {
            // Same reverse-lookup as ParseError: the packet_id is
            // unknown from the classifier's perspective; libSQL may
            // still know it.
            let resolved_packet_id: Option<String> = match db_state.0.lock() {
                Ok(conn) => db::select_packet_id_by_path(&conn, path).ok().flatten(),
                Err(_) => None,
            };
            let _ = h.emit(
                "packet-changed-externally",
                serde_json::json!({
                    "packet_id": resolved_packet_id,
                    "mismatch_type": "missing",
                }),
            );
        }
    }
}
