//! Production-runtime IPC dispatch smoke (v0.1.1 B2 — P1 gate).
//!
//! Locks in the wire-shape contract that v0.1.0 shipped broken: every
//! `#[tauri::command]` in `src/ipc.rs` takes a single named parameter
//! `args: <SomeStruct>`, and Tauri 2's serde-driven argument resolver
//! expects the JS-side IPC payload to be `{ args: <SomeStruct> }`. Passing
//! the inner struct flat (the v0.1.0 client bug, fixed in commit 9f3c2f0)
//! produces "command <name> missing required key args" at the resolver
//! boundary before the handler body ever runs.
//!
//! v0.1.0 shipped with EVERY IPC broken because no test of any kind booted
//! `tauri::test::mock_builder()`; the existing `#[cfg(test)] mod tests`
//! inside `ipc.rs` exercise the handler bodies directly (no serde dispatch
//! envelope), and `tauri::Builder` is silent when the renderer hand-rolls
//! a payload shape the resolver rejects. This integration test closes that
//! gap by:
//!
//!   1. Booting `mock_builder()` with the production `invoke_handler!`
//!      set from `src/main.rs` (every command listed there, minus the
//!      debug-gated `seed_stress_packets`).
//!   2. Building a `WebviewWindow` so `tauri::test::get_ipc_response` can
//!      dispatch InvokeRequests through the real serde resolver.
//!   3. Dispatching each command with a schema-valid `{ args: ... }`
//!      envelope and asserting the resolver accepts it. Handlers may
//!      still return a domain error like `IpcError::NotFound` /
//!      `IpcError::PacketNotFound` — those are POST-resolution outcomes,
//!      which is exactly the contract we want: the args parsed.
//!   4. Picking ONE canary command (`read_settings`) and asserting that
//!      a flat `{}` envelope (the v0.1.0 bug shape) is rejected with a
//!      "missing required key args" error from the resolver. This is the
//!      regression assertion that would break if a hypothetical revert of
//!      9f3c2f0 reintroduced the flat-payload shape.
//!
//! Constraints:
//!   - This file is allowed to touch ONLY `tests/ipc_dispatch_smoke.rs`
//!     and `Cargo.toml` (for dev-deps). It MUST NOT modify any production
//!     code in `src/`. To reach the production modules without adding a
//!     `[lib]` target, we pull each required file into the test crate's
//!     module tree via `#[path = "../src/<file>"]`. The compiler sees the
//!     SAME source the binary sees; the `crate::*` paths inside those
//!     files resolve to this test crate's root, where we declare the
//!     same `mod <name>;` statements `main.rs` declares.
//!   - Tauri's mock runtime under the `test` feature is what makes this
//!     possible; the production `wry`/`webview` runtime is desktop-only
//!     and cannot run in `cargo test`.

// ---------------------------------------------------------------------------
// Pull production modules into the test crate's root via #[path].
//
// Order matches the dependency graph (db → migrations; saga → watcher,
// yaml_safety; ipc → db, saga, settings, watcher, cli_bridge), but Rust's
// module resolution does not care about declaration order — each `mod`
// statement makes the namespace available crate-wide. The `#[allow(dead_code)]`
// silences warnings for production functions this test does not directly
// reference (the IPC dispatch path reaches them through the handler set).
// ---------------------------------------------------------------------------

#[allow(dead_code)]
#[path = "../src/migrations.rs"]
mod migrations;

#[allow(dead_code)]
#[path = "../src/db.rs"]
mod db;

#[allow(dead_code)]
#[path = "../src/yaml_safety.rs"]
mod yaml_safety;

#[allow(dead_code)]
#[path = "../src/watcher.rs"]
mod watcher;

#[allow(dead_code)]
#[path = "../src/saga.rs"]
mod saga;

#[allow(dead_code)]
#[path = "../src/settings.rs"]
mod settings;

#[allow(dead_code)]
#[path = "../src/cli_bridge.rs"]
mod cli_bridge;

#[allow(dead_code)]
#[path = "../src/ipc.rs"]
mod ipc;

use serde_json::{json, Value};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindow;
use tauri::{ipc::CallbackFn, ipc::InvokeBody};

/// Canonical valid ULID used across all schema-valid payloads. The Rust
/// `validate_ulid` predicate (ipc.rs::validate_ulid) accepts 26 ASCII
/// alphanumeric characters; this is the Crockford-Base32 ULID example
/// also used by the JS-side contract tests.
const TEST_ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/// Build the production handler set (mirrors `main.rs` lines 100-117 minus
/// the debug-gated `seed_stress_packets`) and bring up an App + WebviewWindow
/// on the mock runtime. State containers (`DbState`, `SagaState`) are
/// `manage()`'d so the handlers that take `State<'_, _>` parameters resolve.
///
/// The DB and settings files live under a per-process tempdir so the test
/// is hermetic — no `~/.trail/` pollution, no cross-test interference.
fn boot_app_with_handlers() -> (
    tauri::App<tauri::test::MockRuntime>,
    tempfile::TempDir,
) {
    let tmp = tempfile::tempdir().expect("create tempdir for hermetic test state");

    // Point settings + db at the tempdir BEFORE any handler reads them.
    // The env-var overrides are the same hooks production uses for the
    // E2E harness (see db.rs::resolve_db_path + settings.rs::resolve_settings_path).
    std::env::set_var("TRAIL_DB_PATH", tmp.path().join("trail.db"));
    std::env::set_var("TRAIL_SETTINGS_PATH", tmp.path().join("settings.json"));

    let db_path = tmp.path().join("trail.db");
    let conn = db::open_and_migrate(&db_path).expect("open + migrate trail.db in tempdir");
    let db_state = db::DbState::new(conn);

    // Saga state with an empty layer-2 redaction pattern set — the saga
    // handlers (`save_decision`, `override_risk`) will fail with
    // `IpcError::NotFound` on packet-id lookup BEFORE the layer-2 gate
    // runs, so an empty pattern set is fine for the wire-shape smoke.
    let saga_state = ipc::SagaState::new(Vec::new());

    let app = mock_builder()
        .manage(db_state)
        .manage(saga_state)
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
        ])
        .build(mock_context(noop_assets()))
        .expect("mock_builder().build() must succeed for IPC dispatch");
    (app, tmp)
}

/// Helper: build a `WebviewWindow` on the app. Required because
/// `get_ipc_response` dispatches through a webview, not the app handle.
fn build_window(app: &tauri::App<tauri::test::MockRuntime>) -> WebviewWindow<tauri::test::MockRuntime> {
    tauri::WebviewWindowBuilder::new(app, "main", Default::default())
        .build()
        .expect("build mock WebviewWindow")
}

/// Helper: build an `InvokeRequest` for `cmd` carrying `body` as the
/// payload. Mirrors what the production renderer does when it calls
/// `bridge.invoke(cmd, payload)` — the macro on the Rust side reads the
/// `args` key out of this body via the CommandItem deserializer.
fn invoke_request(cmd: &str, body: Value) -> InvokeRequest {
    InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .expect("parse tauri:// origin URL"),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

/// Helper: dispatch the given cmd + payload and assert the resolver
/// accepted it. The handler may still return a domain `IpcError` (e.g.,
/// `not-found` because the tempdir DB has no rows); what we assert is
/// that the error — if any — is NOT the resolver's serde-deserialize
/// "missing required key" error. Returns the raw response on Ok and the
/// raw error JSON on Err so individual tests can inspect the variant.
fn dispatch_expect_resolved(
    window: &WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    payload: Value,
) -> Result<Value, Value> {
    let req = invoke_request(cmd, payload);
    let res = get_ipc_response(window, req);
    let res = res.map(|b| b.deserialize::<Value>().expect("Ok body is JSON"));
    if let Err(ref e) = res {
        // The resolver's missing-key error is a plain string variant
        // produced by serde_json::Error::custom; the IPC channel surfaces
        // it as a JSON string (not an object with `kind`). Any structured
        // IpcError surfaced by the handler is wrapped as a JSON object
        // with a `kind` field — those are POST-resolution and acceptable.
        if let Some(s) = e.as_str() {
            assert!(
                !s.contains("missing required key args"),
                "command {cmd} failed at the serde resolver — wire-shape regression: {s}"
            );
            // Other string-shaped errors (e.g., a deserialize error inside
            // the args struct) are still surfaced; let the caller decide.
        }
    }
    res
}

// ---------------------------------------------------------------------------
// Happy-path dispatch tests — one per production IPC command.
//
// Each test sends a schema-valid `{ args: ... }` envelope. The expected
// outcome is one of:
//   - Ok(value)              → handler completed end-to-end.
//   - Err(<IpcError JSON>)   → handler ran and returned a domain error
//                              (e.g., not-found because the tempdir DB
//                              has no matching row). The dispatch_expect_
//                              resolved helper has already asserted this
//                              is NOT a resolver-level failure.
//
// What we explicitly check is the NEGATIVE assertion: no "missing required
// key args" error. The regression-canary test below covers the positive
// assertion that the flat envelope IS rejected at the same boundary.
// ---------------------------------------------------------------------------

#[test]
fn read_packet_dispatches_with_wrapped_args() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    let _ = dispatch_expect_resolved(
        &window,
        "read_packet",
        json!({ "args": { "packet_id": TEST_ULID } }),
    );
}

#[test]
fn save_decision_dispatches_with_wrapped_args() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    let _ = dispatch_expect_resolved(
        &window,
        "save_decision",
        json!({
            "args": {
                "packet_id": TEST_ULID,
                "claim_id": "claim-1",
                "decision": "accept",
                "reason": null,
                "by": "tester",
                "at": "2026-05-17T00:00:00Z",
                "persona": "creator",
            }
        }),
    );
}

#[test]
fn override_risk_dispatches_with_wrapped_args() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    let _ = dispatch_expect_resolved(
        &window,
        "override_risk",
        json!({
            "args": {
                "packet_id": TEST_ULID,
                "claim_id": "claim-1",
                "layer": "creator",
                "new_level": "low",
                "reason": "smoke test reason >= 3 chars",
                "by": "tester",
                "at": "2026-05-17T00:00:00Z",
                "persona": "creator",
            }
        }),
    );
}

#[test]
fn post_to_pr_dispatches_with_wrapped_args() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    let _ = dispatch_expect_resolved(
        &window,
        "post_to_pr",
        json!({
            "args": {
                "packet_id": TEST_ULID,
                "pr_number": null,
                "persona": "creator",
            }
        }),
    );
}

#[test]
fn decide_on_pr_dispatches_with_wrapped_args() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    let _ = dispatch_expect_resolved(
        &window,
        "decide_on_pr",
        json!({
            "args": {
                "packet_id": TEST_ULID,
                "claim_id": "claim-1",
                "decision": "accept",
                "reason": null,
                "by": "tester",
                "pr_number": null,
                "persona": "creator",
            }
        }),
    );
}

#[test]
fn query_trail_dispatches_with_wrapped_args() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    let res = dispatch_expect_resolved(
        &window,
        "query_trail",
        json!({
            "args": {
                "filter": {},
                "limit": 50,
                "cursor": null,
            }
        }),
    );
    // query_trail on a fresh empty DB returns Ok with an empty packets list;
    // pin that to give one positive end-to-end success in the suite.
    let body = res.expect("query_trail should succeed on an empty tempdir DB");
    assert!(body.is_object(), "query_trail response is a JSON object");
    assert!(body.get("packets").is_some(), "response has packets key");
}

/// v0.1.3 bug-1 regression canary: when the Rust handler has no further
/// page to return, the response MUST NOT carry `"next_cursor": null` —
/// serde must omit the key entirely so the Zod `.optional()` schema in
/// `apps/ui/src/ipc/contract.ts::queryTrailResponseSchema` accepts the
/// payload.
///
/// v0.1.0–v0.1.2 shipped `pub next_cursor: Option<String>` without
/// `#[serde(skip_serializing_if = "Option::is_none")]`. Daniel's fresh
/// v0.1.2 install bricked the sidebar on first paint with
/// "Expected string, received null at next_cursor". The B2 dispatch
/// smoke (Request envelope) did not catch it because the failure was
/// in the response shape, not the request shape. This test closes that
/// gap — round-tripping the wire JSON through the SAME serializer the
/// production Tauri runtime uses.
#[test]
fn query_trail_response_omits_next_cursor_when_none() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    let res = dispatch_expect_resolved(
        &window,
        "query_trail",
        json!({
            "args": {
                "filter": {},
                "limit": 50,
                "cursor": null,
            }
        }),
    );
    let body = res.expect("query_trail should succeed on an empty tempdir DB");
    let obj = body.as_object().expect("response is a JSON object");
    assert!(
        !obj.contains_key("next_cursor"),
        "v0.1.3 bug-1: next_cursor must be OMITTED when there's no \
         further page (skip_serializing_if must be active). Got: {body}"
    );
    // Belt-and-braces: even if the key were present, a `null` would be
    // the failure mode that bricked Daniel's v0.1.2.
    assert_ne!(
        obj.get("next_cursor"),
        Some(&Value::Null),
        "v0.1.3 bug-1: next_cursor must never serialize as JSON null"
    );
}

#[test]
fn query_recent_sessions_dispatches_with_wrapped_args() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    let res = dispatch_expect_resolved(
        &window,
        "query_recent_sessions",
        json!({ "args": { "limit": 5 } }),
    );
    // Empty DB → empty array, also Ok end-to-end.
    let body = res.expect("query_recent_sessions should succeed on an empty tempdir DB");
    assert!(body.is_array(), "query_recent_sessions returns an array");
}

#[test]
fn read_settings_dispatches_with_wrapped_args() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    let res = dispatch_expect_resolved(
        &window,
        "read_settings",
        json!({ "args": {} }),
    );
    // No settings.json on disk → Settings::default(); Ok end-to-end.
    let body = res.expect("read_settings should succeed when no settings file exists");
    assert!(body.is_object(), "read_settings response is a Settings object");
}

#[test]
fn write_settings_dispatches_with_wrapped_args() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    let res = dispatch_expect_resolved(
        &window,
        "write_settings",
        json!({
            "args": {
                "partial": { "theme": "dark" },
                "persona": "creator",
            }
        }),
    );
    let body = res.expect("write_settings should succeed with a valid partial");
    assert_eq!(body.get("ok"), Some(&Value::Bool(true)));
}

#[test]
fn preview_redacted_dispatches_with_wrapped_args() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    let res = dispatch_expect_resolved(
        &window,
        "preview_redacted",
        json!({
            "args": {
                "packet_id": TEST_ULID,
                "redaction_id": "redact-1",
            }
        }),
    );
    // Always returns Ok({ original: null }) per the B6 P1 contract.
    let body = res.expect("preview_redacted always succeeds for a valid ULID");
    assert!(body.is_object());
}

#[test]
fn audit_log_append_dispatches_with_wrapped_args() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    // `packet_id` is intentionally omitted (it's Option<String> in
    // AuditLogAppendArgs). A real ULID would FK-fail against the empty
    // `packets` table in the tempdir DB — that's a post-resolution domain
    // error, not a wire-shape regression, but skipping the FK keeps this
    // test's positive Ok assertion intact for the audit-log row write.
    let res = dispatch_expect_resolved(
        &window,
        "audit_log_append",
        json!({
            "args": {
                "event_type": "tamper_dismissed",
                "details": { "mismatch_type": "hash-mismatch" },
                "persona": "creator",
            }
        }),
    );
    let body = res.expect("audit_log_append should succeed for a valid event");
    assert_eq!(body.get("ok"), Some(&Value::Bool(true)));
}

#[test]
fn subscribe_fs_watch_dispatches_with_wrapped_args() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    let res = dispatch_expect_resolved(
        &window,
        "subscribe_fs_watch",
        json!({ "args": {} }),
    );
    let body = res.expect("subscribe_fs_watch is unconditionally Ok in v0.1");
    assert_eq!(body.get("ok"), Some(&Value::Bool(true)));
}

#[test]
fn subscribe_settings_change_dispatches_with_wrapped_args() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    let _ = dispatch_expect_resolved(
        &window,
        "subscribe_settings_change",
        json!({ "args": {} }),
    );
    // Handler returns IpcError::Internal("not yet implemented (Sprint 6)") —
    // that's POST-resolution, which is the contract this test pins. The
    // dispatch helper has already asserted no missing-key resolver error.
}

#[test]
fn validate_capture_cli_path_dispatches_with_wrapped_args() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);
    let _ = dispatch_expect_resolved(
        &window,
        "validate_capture_cli_path",
        json!({
            "args": {
                "path": "/usr/local/bin/trail-capture",
            }
        }),
    );
    // Will Ok-with-False (binary not present in CI) or Ok-with-True
    // (lucky tempdir hit) — either way, POST-resolution; the helper
    // has already asserted no resolver-level failure.
}

// ---------------------------------------------------------------------------
// Regression canary — the v0.1.0 bug shape.
//
// This is the assertion that would have caught v0.1.0 in CI. Until commit
// 9f3c2f0 the client sent `parsed.data` flat — every command erred at the
// Tauri serde resolver with "command <name> missing required key args".
// Hypothetically reverting the wire shape on the JS side would not break
// this Rust-only test (the test sends its own payload), but the property
// it pins — "the resolver REJECTS flat envelopes" — is the inverse of the
// happy-path tests above and is what makes them load-bearing.
// ---------------------------------------------------------------------------

#[test]
fn read_settings_rejects_flat_envelope_at_resolver() {
    let (app, _tmp) = boot_app_with_handlers();
    let window = build_window(&app);

    // The v0.1.0 bug shape: send the inner struct flat (no `args` key).
    // For `read_settings` the inner struct is `EmptyArgs` — i.e. `{}`.
    let req = invoke_request("read_settings", json!({}));
    let res = get_ipc_response(&window, req);

    let err_value = match res {
        Ok(_) => panic!(
            "read_settings accepted a FLAT `{{}}` envelope — the wire-shape regression \
             has reappeared. Every IPC command in src/ipc.rs takes a single `args` \
             parameter; the Tauri serde resolver must reject payloads that omit it. \
             See commit 9f3c2f0 (v0.1.1 P0) for the fix history."
        ),
        Err(v) => v,
    };

    // The resolver's serde_json::Error::custom surfaces as a JSON string
    // payload at the IPC boundary (NOT a structured IpcError object). The
    // string contains the verbatim "command <name> missing required key
    // <field>" text from `command.rs::deserialize_json` in the tauri
    // crate (tauri-2.x src/ipc/command.rs:99-101).
    let msg = err_value.as_str().unwrap_or_else(|| {
        panic!(
            "expected a JSON-string resolver error for flat envelope; got structured \
             value: {err_value}"
        )
    });
    assert!(
        msg.contains("missing required key"),
        "expected resolver to reject flat envelope with `missing required key`; got: {msg}"
    );
    assert!(
        msg.contains("args"),
        "expected the missing-key name to be `args`; got: {msg}"
    );
}
