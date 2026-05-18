//! Capabilities negative tests — IPC allowlist scope verification (gh#13 AC-4).
//!
//! Sprint 6 closure: assert the Tauri capability JSON scopes the runtime
//! to the values B5 §6 + B6 P1 declare. Any future capability addition
//! must update this test deliberately.
//!
//! Negative assertions:
//!
//!   1. Reading `~/.ssh/` (or any path outside `.trail/` + `~/.trail/` +
//!      `$RESOURCE/.trail/`) is rejected by the `fs:scope` allowlist.
//!   2. `clipboard.readText` is absent (no clipboard permission grants
//!      it; the only clipboard use is `clipboard.writeText` via M2's
//!      copy-button, which is wrapped at the App level — see
//!      App.tsx::useEffect for the M3 redaction-preview defense).
//!   3. File writes outside `.trail/` + `~/.trail/` are rejected by the
//!      same `fs:scope`.
//!   4. The shell allowlist permits ONLY gh CLI subcommands — no
//!      arbitrary `cmd`, `bash`, `sh`, no `fetch`/HTTP plugin, no
//!      `process` plugin.
//!   5. The 14 IPC commands (B5 §6.1 12 + validate_capture_cli_path +
//!      decide_on_pr) are the typed surface — any new command must be
//!      added explicitly. The TS-side `IPC_COMMAND_SCHEMAS` pin
//!      (apps/ui/tests/unit/ipc-contract.test.ts) is the canonical
//!      build-time check; this test mirrors the count from the Rust
//!      side via `tauri::generate_handler!` macros.
//!
//! Mode: `#[cfg(test)]` only. The capability JSON is `include_str!`'d
//! at compile time so the tests run without booting Tauri.

#![cfg(test)]

use serde_json::Value;

const CAPABILITY_JSON: &str = include_str!("../capabilities/default.json");

fn parsed_capability() -> Value {
    serde_json::from_str(CAPABILITY_JSON)
        .expect("capabilities/default.json must parse as JSON")
}

fn fs_scope_paths() -> Vec<String> {
    let parsed = parsed_capability();
    let permissions = parsed["permissions"]
        .as_array()
        .expect("permissions is an array");
    for perm in permissions {
        if perm.get("identifier").and_then(|v| v.as_str()) != Some("fs:scope") {
            continue;
        }
        let allow = perm["allow"]
            .as_array()
            .expect("fs:scope.allow is an array");
        return allow
            .iter()
            .filter_map(|entry| entry["path"].as_str().map(str::to_owned))
            .collect();
    }
    panic!("no fs:scope permission found in capability JSON");
}

fn shell_allow_execute_names() -> Vec<String> {
    let parsed = parsed_capability();
    let permissions = parsed["permissions"]
        .as_array()
        .expect("permissions is an array");
    for perm in permissions {
        if perm.get("identifier").and_then(|v| v.as_str()) != Some("shell:allow-execute") {
            continue;
        }
        let allow = perm["allow"]
            .as_array()
            .expect("shell:allow-execute.allow is an array");
        return allow
            .iter()
            .filter_map(|entry| entry["name"].as_str().map(str::to_owned))
            .collect();
    }
    panic!("no shell:allow-execute permission found in capability JSON");
}

fn shell_allow_execute_cmds() -> Vec<String> {
    let parsed = parsed_capability();
    let permissions = parsed["permissions"]
        .as_array()
        .expect("permissions is an array");
    for perm in permissions {
        if perm.get("identifier").and_then(|v| v.as_str()) != Some("shell:allow-execute") {
            continue;
        }
        let allow = perm["allow"]
            .as_array()
            .expect("shell:allow-execute.allow is an array");
        return allow
            .iter()
            .filter_map(|entry| entry["cmd"].as_str().map(str::to_owned))
            .collect();
    }
    Vec::new()
}

fn permission_identifiers() -> Vec<String> {
    let parsed = parsed_capability();
    let permissions = parsed["permissions"]
        .as_array()
        .expect("permissions is an array");
    permissions
        .iter()
        .filter_map(|p| {
            // Permissions can be either a string or an object with `identifier`.
            if let Some(s) = p.as_str() {
                Some(s.to_string())
            } else {
                p["identifier"].as_str().map(str::to_owned)
            }
        })
        .collect()
}

#[test]
fn fs_scope_does_not_allow_ssh_or_etc_or_arbitrary_home_paths() {
    // The fs:scope allowlist must scope to the three trail paths only.
    // Any glob that would resolve `~/.ssh/`, `/etc/`, or `$HOME/**` is a
    // P1 security regression.
    let paths = fs_scope_paths();
    for path in &paths {
        assert!(
            path.contains(".trail/"),
            "fs:scope path '{path}' must include '.trail/'; got non-trail path"
        );
    }
    // Specifically check that no path could resolve to ~/.ssh/ or /etc/.
    for path in &paths {
        assert!(
            !path.contains(".ssh"),
            "fs:scope path '{path}' must NOT include .ssh"
        );
        assert!(
            !path.starts_with("/etc"),
            "fs:scope path '{path}' must NOT scope /etc"
        );
        assert!(
            !path.contains("**/*"),
            "fs:scope path '{path}' must NOT use catch-all globs"
        );
        // $HOME/** by itself is too broad — the only $HOME scope is
        // $HOME/.trail/**.
        if path.starts_with("$HOME/") {
            assert!(
                path.starts_with("$HOME/.trail/"),
                "fs:scope $HOME path '{path}' must be $HOME/.trail/-prefixed"
            );
        }
    }
}

#[test]
fn fs_scope_lists_exactly_three_trail_paths() {
    // Pin the exact set: $APPDATA/.trail/**, $HOME/.trail/**,
    // $RESOURCE/.trail/**. Any addition is a deliberate decision that
    // must update this test.
    let mut paths = fs_scope_paths();
    paths.sort();
    assert_eq!(
        paths,
        vec![
            "$APPDATA/.trail/**".to_string(),
            "$HOME/.trail/**".to_string(),
            "$RESOURCE/.trail/**".to_string(),
        ],
        "fs:scope must scope to exactly the three trail paths"
    );
}

#[test]
fn clipboard_read_text_permission_is_absent() {
    // The clipboard plugin's allowlisted permissions are NEVER granted.
    // The UI uses `navigator.clipboard.writeText` directly (web API,
    // not gated by Tauri), wrapped by App.tsx for the M3 defense.
    // Reading the clipboard would require `clipboard-manager:allow-read-text`
    // (or equivalent); it must be absent.
    let ids = permission_identifiers();
    for id in &ids {
        assert!(
            !id.contains("clipboard"),
            "no clipboard permission must be granted; found '{id}'"
        );
    }
}

#[test]
fn shell_allow_execute_lists_only_gh_subcommands() {
    // Every shell-allowed command MUST be a `gh` invocation. No bash,
    // sh, /bin/sh, /usr/bin/env, no `trail` (which spawns its OWN gh —
    // that subprocess is the cli_bridge surface, not the shell-allowlist
    // surface).
    let cmds = shell_allow_execute_cmds();
    assert!(!cmds.is_empty(), "shell:allow-execute must declare at least one command");
    for cmd in &cmds {
        assert_eq!(cmd, "gh", "shell:allow-execute cmd '{cmd}' must be 'gh' only");
    }
}

#[test]
fn shell_allow_execute_lists_exact_named_set() {
    // Cycle-3 C10 (PR #21): the kebab-prefix regex test below is a
    // structural shape check — it cannot detect the addition of a new
    // command name (e.g., a regression that adds `gh-pr-merge` or
    // `gh-issue-create` would still match the regex). The closed-set
    // assertion mirrors `fs_scope_lists_exactly_three_trail_paths` and
    // `shell_allow_open_lists_only_documented_https_urls` discipline:
    // the canonical set is sourced from capabilities/default.json and
    // any addition is a deliberate, code-reviewed change here.
    //
    // Canonical set as of cycle-3 (sorted):
    //   gh-api-pulls-get, gh-auth-status, gh-pr-comment-body-file,
    //   gh-pr-edit-body-file, gh-pr-list-json, gh-pr-view-json,
    //   gh-repo-view-json
    let mut names = shell_allow_execute_names();
    names.sort();
    let expected: Vec<String> = vec![
        "gh-api-pulls-get".to_string(),
        "gh-auth-status".to_string(),
        "gh-pr-comment-body-file".to_string(),
        "gh-pr-edit-body-file".to_string(),
        "gh-pr-list-json".to_string(),
        "gh-pr-view-json".to_string(),
        "gh-repo-view-json".to_string(),
    ];
    assert_eq!(
        names, expected,
        "shell:allow-execute named set drifted from the documented closed set; \
         either intentionally update this test alongside capabilities/default.json, \
         or revert the addition"
    );
}

#[test]
fn shell_allow_execute_names_are_kebab_prefixed() {
    // F9 fold (Sprint 6 — gh#13): the kebab-prefix shape pattern is the
    // contract for every name. Every entry must match `^gh-[a-z][a-z0-9-]*$`.
    //
    // Cycle-2 C5 (PR #21): non-empty assertion mirrors the discipline of
    // shell_allow_execute_lists_only_gh_subcommands at L197. Without it,
    // a regression that emptied the kebab-name list (e.g., refactor that
    // accidentally drops the literal vec, or a JSON field renamed) would
    // pass silently — the for-loop iterates 0 times. The non-empty check
    // is the structural twin of the gh-subcommand check.
    let names = shell_allow_execute_names();
    assert!(
        !names.is_empty(),
        "shell:allow-execute must declare at least one name"
    );
    let pattern = regex::Regex::new(r"^gh-[a-z][a-z0-9-]*$")
        .expect("kebab-prefix regex must compile");
    for name in &names {
        assert!(
            pattern.is_match(name),
            "shell:allow-execute name '{name}' must match ^gh-[a-z][a-z0-9-]*$"
        );
    }
}

#[test]
fn no_http_or_fetch_or_process_plugins_granted() {
    // The HTTP plugin (tauri-plugin-http), the process plugin
    // (tauri-plugin-process), and any "global" allow that would let
    // arbitrary commands or arbitrary URLs through must be absent.
    let ids = permission_identifiers();
    for id in &ids {
        // A few specific deny-list entries:
        for forbidden in [
            "http:",
            "fetch:",
            "process:",
            "shell:allow-spawn",
            "shell:allow-execute-globally",
        ] {
            assert!(
                !id.contains(forbidden),
                "permission '{id}' must NOT grant '{forbidden}'"
            );
        }
    }
}

#[test]
fn shell_allow_open_lists_only_documented_https_urls() {
    // F5 fold (Sprint 6): the shell:allow-open scope must list only
    // GitHub.com / cli.github.com URLs (the FirstRun screen + edge-flow
    // recovery prompts). Any other URL is a regression.
    //
    // Cycle-2 C8 (PR #21): the prior implementation was a prefix
    // membership check (`starts_with("https://github.com/")` OR
    // `starts_with("https://cli.github.com")`). That admits ANY URL
    // under those prefixes — e.g., `https://github.com/attacker/trail`
    // would have passed. The fix: assert the exact closed set against a
    // sorted literal vec, mirroring the structural discipline of
    // `fs_scope_lists_exactly_three_trail_paths`. Adding a 5th URL to
    // capabilities/default.json must require an explicit corresponding
    // edit here (and a code-review eye).
    let parsed = parsed_capability();
    let permissions = parsed["permissions"]
        .as_array()
        .expect("permissions is an array");
    for perm in permissions {
        if perm.get("identifier").and_then(|v| v.as_str()) != Some("shell:allow-open") {
            continue;
        }
        let allow = perm["allow"]
            .as_array()
            .expect("shell:allow-open.allow is an array");
        let mut actual_urls: Vec<String> = allow
            .iter()
            .map(|entry| {
                entry["url"]
                    .as_str()
                    .expect("shell:allow-open entry must have url")
                    .to_string()
            })
            .collect();
        actual_urls.sort();

        // Canonical closed set — sourced from
        // apps/ui/src-tauri/capabilities/default.json. Any change to
        // that file requires a corresponding edit here.
        let expected_urls: Vec<String> = vec![
            "https://cli.github.com".to_string(),
            "https://cli.github.com/".to_string(),
            "https://github.com/synaptiai/trail".to_string(),
            "https://github.com/synaptiai/trail#readme".to_string(),
        ];

        assert_eq!(
            actual_urls, expected_urls,
            "shell:allow-open URL set drifted from the documented closed set"
        );
        return;
    }
    panic!("no shell:allow-open permission found in capability JSON");
}

#[test]
fn capability_window_scope_is_main_only() {
    // The capability is scoped to the `main` window only — Trail v0.1
    // is a single-window app. Multi-window scope would broaden the
    // attack surface and must be a deliberate addition.
    let parsed = parsed_capability();
    let windows = parsed["windows"]
        .as_array()
        .expect("windows is an array");
    let names: Vec<&str> = windows.iter().filter_map(|w| w.as_str()).collect();
    assert_eq!(names, vec!["main"], "capability scope must be 'main' window only");
}

#[test]
fn cycle_4_5_w11_top_level_permissions_are_exact_closed_set() {
    // Cycle-4.5 W11 (PR #21): the prior tests checked the fs:* and
    // shell:allow-execute named subsets but NOT the four top-level
    // string permissions ("core:default", "core:event:default",
    // "core:event:allow-listen", "core:event:allow-unlisten") nor the
    // overall closed shape. A regression that added e.g.
    // "core:webview:allow-set-visible" or "shell:allow-spawn" would
    // pass the existing fs / shell-execute / clipboard / http
    // assertions while quietly broadening the runtime grant.
    //
    // This test mirrors the C11 / C8 / shell-allow-execute closed-set
    // discipline: sort the actual permission identifiers (string +
    // object identifier forms) and assert against a literal vec
    // sourced from capabilities/default.json. Any addition to the
    // capability JSON requires a deliberate corresponding edit here.
    //
    // Canonical set as of cycle-4.5 (sorted):
    //   core:default, core:event:allow-listen, core:event:allow-unlisten,
    //   core:event:default, fs:allow-read-dir, fs:allow-read-file,
    //   fs:allow-rename, fs:allow-write-file, fs:scope, shell:allow-execute,
    //   shell:allow-open
    let mut ids = permission_identifiers();
    ids.sort();
    let expected: Vec<String> = vec![
        "core:default".to_string(),
        "core:event:allow-listen".to_string(),
        "core:event:allow-unlisten".to_string(),
        "core:event:default".to_string(),
        "fs:allow-read-dir".to_string(),
        "fs:allow-read-file".to_string(),
        "fs:allow-rename".to_string(),
        "fs:allow-write-file".to_string(),
        "fs:scope".to_string(),
        "shell:allow-execute".to_string(),
        "shell:allow-open".to_string(),
    ];
    assert_eq!(
        ids, expected,
        "top-level capability permission set drifted from the documented \
         closed set; either intentionally update this test alongside \
         capabilities/default.json, or revert the addition. Specifically: \
         shell:allow-spawn, http:default, process:default, and any other \
         non-listed identifier are NEVER granted in v0.1."
    );
}

#[test]
fn fs_permissions_grant_only_documented_operations() {
    // Cycle-3 C11 (PR #21): replace the previous subset-membership +
    // minimum-three checks with a FULL closed-set assertion mirroring
    // `fs_scope_lists_exactly_three_trail_paths` discipline. The
    // subset version permitted any of the listed names but allowed
    // additional fs:* permissions to slip in if they happened to
    // match the prefix; the minimum-three check accepted any 3+
    // non-empty subset. Both gaps mean a regression that added
    // `fs:allow-remove` or `fs:allow-create` could pass — exactly
    // the threat the test was meant to catch.
    //
    // Canonical set as of cycle-3 (sorted):
    //   fs:allow-read-dir, fs:allow-read-file, fs:allow-rename,
    //   fs:allow-write-file, fs:scope
    let ids = permission_identifiers();
    let mut fs_ids: Vec<String> = ids
        .iter()
        .filter(|i| i.starts_with("fs:"))
        .cloned()
        .collect();
    fs_ids.sort();
    let expected: Vec<String> = vec![
        "fs:allow-read-dir".to_string(),
        "fs:allow-read-file".to_string(),
        "fs:allow-rename".to_string(),
        "fs:allow-write-file".to_string(),
        "fs:scope".to_string(),
    ];
    assert_eq!(
        fs_ids, expected,
        "fs:* permission set drifted from the documented closed set; \
         either intentionally update this test alongside capabilities/default.json, \
         or revert the addition. Specifically: fs:allow-remove / fs:allow-create / \
         fs:allow-set-permissions are NEVER granted in v0.1."
    );
}
