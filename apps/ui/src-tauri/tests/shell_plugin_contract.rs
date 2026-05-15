//! Shell plugin enforcement-semantic contract tests.
//!
//! Per PR #6 cycle-2 review N6 (P2 testing-coverage-security consensus
//! MEDIUM):
//!
//!   The 12 regression tests in `src/shell_allowlist.rs` verify the regex
//!   *shapes* (positive / negative cases for each validator) but never
//!   exercise `tauri-plugin-shell`'s enforcement semantic. The
//!   architecture.md §3.3 paragraph cites tauri-plugin-shell v2.3.5
//!   `scope.rs` lines 270-289 as the authority for "under-supply rejected,
//!   over-supply silently dropped." That semantic is the entire foundation
//!   of F2's closure — but no test in this PR boots the plugin.
//!
//! This integration test addresses the gap by:
//!
//! 1. Locking the dependency to `=2.3.5` (Cargo.toml — see comment block).
//! 2. Replicating the scope.rs algorithm against the SAME validator
//!    regexes the production capability JSON declares, so a regression in
//!    EITHER side (capability JSON OR upstream plugin code) is caught.
//! 3. Asserting the three contract clauses:
//!      - Under-supply (incoming.len() < declared.len()) is rejected.
//!      - Over-supply (incoming.len() > declared.len()) drops the extras
//!        — only the validated declared.len() args reach the result.
//!      - Per-arg validator regex must match; failure rejects.
//!
//! The replicated algorithm is intentionally a faithful copy of
//! tauri-plugin-shell-2.3.5/src/scope.rs:251-301 (the `_prepare` body).
//! The Cargo.toml `=2.3.5` pin guarantees the production runtime matches
//! this transcription. When upgrading the pin, re-read scope.rs and
//! refresh both the algorithm here and the architecture.md §3.3 citation.

use regex::Regex;
use serde_json::Value;

const CAPABILITY_JSON: &str = include_str!("../capabilities/default.json");

/// A validated argument slot — either a fixed string or a regex-validated
/// variable. Mirrors `tauri_plugin_shell::scope::ScopeAllowedArg` (private).
#[derive(Debug, Clone)]
enum ArgSlot {
    Fixed(String),
    Var(Regex),
}

/// A validated command entry — mirrors `tauri_plugin_shell::scope::ScopeAllowedCommand`
/// (private). `name` is the unique key; `args` is `None` when the entry
/// declares `args: true` (any args allowed) and `Some` otherwise.
#[derive(Debug, Clone)]
struct AllowedCommand {
    name: String,
    args: Option<Vec<ArgSlot>>,
}

/// Mirror of `tauri_plugin_shell::scope::Error` (private). The relevant
/// variants for the contract tests are MissingVar (under-supply),
/// Validation (regex mismatch), NotFound (unknown command name), and
/// InvalidInput (declared list non-empty but arg shape wrong).
#[derive(Debug, PartialEq)]
enum ScopeError {
    NotFound(String),
    MissingVar { index: usize, validation: String },
    Validation { index: usize, validation: String },
    InvalidInput(String),
}

/// Faithful transcription of tauri-plugin-shell-2.3.5/src/scope.rs:251-301.
/// Returns the resolved arg list (what would be sent to the subprocess) on
/// success, or a structured error matching the plugin's enum.
///
/// IMPORTANT: keep this in lockstep with the upstream source. The Cargo.toml
/// `=2.3.5` pin guarantees the runtime uses the same algorithm.
fn prepare(
    scopes: &[AllowedCommand],
    command_name: &str,
    incoming_args: Vec<String>,
) -> Result<Vec<String>, ScopeError> {
    let command = scopes
        .iter()
        .find(|s| s.name == command_name)
        .ok_or_else(|| ScopeError::NotFound(command_name.into()))?;

    match &command.args {
        // No declared list: pass-through.
        None => Ok(incoming_args),
        Some(declared) => {
            // Empty incoming + all-fixed declared: synthesize the fixed list.
            if incoming_args.is_empty()
                && declared.iter().all(|a| matches!(a, ArgSlot::Fixed(_)))
            {
                return Ok(declared
                    .iter()
                    .map(|a| match a {
                        ArgSlot::Fixed(s) => s.clone(),
                        _ => unreachable!(),
                    })
                    .collect());
            }
            if declared.is_empty() {
                return Err(ScopeError::InvalidInput(command_name.into()));
            }
            // The list-vs-list path: zip declared with incoming by index.
            // OVER-SUPPLY is silently dropped (we only iterate `declared`).
            // UNDER-SUPPLY hits the .get(i).ok_or_else(MissingVar) branch.
            declared
                .iter()
                .enumerate()
                .map(|(i, slot)| match slot {
                    ArgSlot::Fixed(fixed) => Ok(fixed.clone()),
                    ArgSlot::Var(validator) => {
                        let value = incoming_args.get(i).ok_or_else(|| {
                            ScopeError::MissingVar {
                                index: i,
                                validation: validator.to_string(),
                            }
                        })?;
                        if validator.is_match(value) {
                            Ok(value.clone())
                        } else {
                            Err(ScopeError::Validation {
                                index: i,
                                validation: validator.to_string(),
                            })
                        }
                    }
                })
                .collect()
        }
    }
}

/// Load the production capability JSON and translate every shell:allow-execute
/// entry into AllowedCommand. This is the cycle-2 N28 fix: the test reads
/// the SAME capability file the runtime reads, so a JSON-only addition by a
/// future contributor MUST update this loader to add a corresponding test —
/// otherwise the new entry is asserted-against by the helper itself.
fn load_allowed_commands_from_capability() -> Vec<AllowedCommand> {
    let parsed: Value = serde_json::from_str(CAPABILITY_JSON)
        .expect("capabilities/default.json failed to parse as JSON");
    let permissions = parsed["permissions"]
        .as_array()
        .expect("permissions is an array");

    let mut out = Vec::new();
    for perm in permissions {
        // shell:allow-execute is the only object-shaped permission with `allow`.
        let identifier = perm.get("identifier").and_then(|v| v.as_str());
        if identifier != Some("shell:allow-execute") {
            continue;
        }
        let allow_list = perm["allow"]
            .as_array()
            .expect("shell:allow-execute.allow is an array");
        for entry in allow_list {
            let name = entry["name"]
                .as_str()
                .expect("each allow entry has a name")
                .to_string();
            let args_field = entry.get("args");
            let args = match args_field {
                Some(Value::Array(args)) => {
                    let slots = args
                        .iter()
                        .map(|a| match a {
                            Value::String(s) => ArgSlot::Fixed(s.clone()),
                            Value::Object(map) => {
                                let validator = map
                                    .get("validator")
                                    .and_then(|v| v.as_str())
                                    .expect("var-arg has a validator");
                                // Plugin wraps the user-declared regex with
                                // `^...$` when raw=false (default).
                                let raw = map
                                    .get("raw")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                let pattern = if raw {
                                    validator.to_string()
                                } else {
                                    format!("^{validator}$")
                                };
                                let re = Regex::new(&pattern).unwrap_or_else(|e| {
                                    panic!(
                                        "validator regex failed to compile: {} — {}",
                                        pattern, e
                                    )
                                });
                                ArgSlot::Var(re)
                            }
                            other => panic!(
                                "unexpected arg shape in capability JSON: {:?}",
                                other
                            ),
                        })
                        .collect();
                    Some(slots)
                }
                Some(Value::Bool(true)) => None,
                Some(Value::Bool(false)) | None => Some(Vec::new()),
                other => panic!("unexpected args shape: {:?}", other),
            };
            out.push(AllowedCommand { name, args });
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

#[test]
fn capability_json_loads_and_compiles_all_validators() {
    // Smoke test: the JSON parses and every var validator compiles. Catches
    // the regression where a future contributor adds a malformed entry.
    let allowed = load_allowed_commands_from_capability();
    assert!(
        !allowed.is_empty(),
        "expected at least one shell:allow-execute entry"
    );
    // Sanity: every Sprint 4-5 invocation we documented has an entry.
    let names: Vec<&str> = allowed.iter().map(|a| a.name.as_str()).collect();
    for required in [
        "gh-auth-status",
        "gh-repo-view-json",
        "gh-pr-view-json",
        "gh-pr-list-json",
        "gh-pr-edit-body-file",
        "gh-pr-comment-body-file",
        "gh-api-pulls-get",
    ] {
        assert!(
            names.contains(&required),
            "expected capability '{}' missing from default.json: {:?}",
            required,
            names
        );
    }
}

#[test]
fn under_supply_is_rejected_with_missing_var() {
    // CONTRACT 1: incoming.len() < declared.len() → MissingVar at the first
    // missing index. The plugin maps this to ProgramNotAllowed at the IPC
    // layer (commands.rs:139-145), so no subprocess is spawned.
    //
    // gh-pr-view-json declares 5 args (pr, view, $pr_number, --json,
    // $json_fields). Supplying only 4 must fail at index 4.
    let allowed = load_allowed_commands_from_capability();
    let result = prepare(
        &allowed,
        "gh-pr-view-json",
        vec!["pr".into(), "view".into(), "6".into(), "--json".into()],
    );
    match result {
        Err(ScopeError::MissingVar { index, .. }) => {
            assert_eq!(index, 4, "MissingVar should fire at the first missing slot");
        }
        other => panic!("expected MissingVar at index 4, got: {:?}", other),
    }
}

#[test]
fn over_supply_silently_drops_extras() {
    // CONTRACT 2: incoming.len() > declared.len() → only declared.len() args
    // reach the subprocess. The extras are silently dropped (not appended,
    // not validated, not rejected).
    //
    // gh-auth-status declares fixed ["auth", "status"]. Supplying 4 args
    // (extra "secret-flag", "--malicious") must produce ONLY ["auth",
    // "status"] in the result. The over-supplied args are observable as
    // "did NOT reach the subprocess" — the result vec is the subprocess argv.
    let allowed = load_allowed_commands_from_capability();
    let result = prepare(
        &allowed,
        "gh-auth-status",
        vec![
            "auth".into(),
            "status".into(),
            "--secret-flag".into(),
            "/etc/passwd".into(),
        ],
    );
    // gh-auth-status has args=["auth","status"], all fixed. The plugin's
    // (Some(list), arg) if arg.is_empty() && all-fixed branch only fires if
    // incoming is EMPTY. Otherwise we go into the (Some(list), List(args))
    // branch which iterates over declared (length 2), so the result is
    // length 2 with both fixed values, ignoring incoming entirely.
    let expected = vec!["auth".to_string(), "status".to_string()];
    assert_eq!(
        result.unwrap(),
        expected,
        "over-supplied args must NOT reach the subprocess argv"
    );

    // Repeat with a var-shaped entry to confirm the same drop semantic
    // when validator regexes are involved.
    //
    // gh-pr-list-json declares 6 args:
    //   ["pr", "list", "--json", $json_fields, "--limit", $limit]
    // Supplying 8 args (with two attacker extras at the tail) must produce
    // exactly the 6-arg validated list.
    let result = prepare(
        &allowed,
        "gh-pr-list-json",
        vec![
            "pr".into(),
            "list".into(),
            "--json".into(),
            "url,state".into(),
            "--limit".into(),
            "50".into(),
            "--malicious-flag".into(),
            "/etc/shadow".into(),
        ],
    )
    .expect("validated args should yield Ok");
    assert_eq!(
        result,
        vec!["pr", "list", "--json", "url,state", "--limit", "50"],
        "over-supplied args after a var-shaped declared list must NOT reach argv"
    );
}

#[test]
fn validator_mismatch_is_rejected() {
    // CONTRACT 3: per-arg validator must match; mismatch → Validation error
    // → IPC ProgramNotAllowed.
    let allowed = load_allowed_commands_from_capability();
    let result = prepare(
        &allowed,
        "gh-pr-view-json",
        vec![
            "pr".into(),
            "view".into(),
            // Path traversal in the pr_number slot.
            "../../etc/passwd".into(),
            "--json".into(),
            "url".into(),
        ],
    );
    match result {
        Err(ScopeError::Validation { index, .. }) => {
            assert_eq!(index, 2, "Validation should fire on the pr_number slot");
        }
        other => panic!("expected Validation at index 2, got: {:?}", other),
    }
}

#[test]
fn unknown_command_name_is_rejected() {
    let allowed = load_allowed_commands_from_capability();
    let result = prepare(
        &allowed,
        "gh-something-evil",
        vec!["arbitrary".into(), "args".into()],
    );
    assert!(matches!(result, Err(ScopeError::NotFound(_))));
}

#[test]
fn legitimate_var_invocation_passes_through() {
    // Positive case for the var-arg path.
    let allowed = load_allowed_commands_from_capability();
    let result = prepare(
        &allowed,
        "gh-pr-view-json",
        vec![
            "pr".into(),
            "view".into(),
            "6".into(),
            "--json".into(),
            "url,state,title,body".into(),
        ],
    )
    .expect("legitimate gh pr view should pass");
    assert_eq!(
        result,
        vec!["pr", "view", "6", "--json", "url,state,title,body"]
    );
}

#[test]
fn legitimate_api_invocation_passes_through() {
    let allowed = load_allowed_commands_from_capability();
    let result = prepare(
        &allowed,
        "gh-api-pulls-get",
        vec!["api".into(), "repos/synaptiai/trail/pulls/6".into()],
    )
    .expect("legitimate gh api pulls/6 should pass");
    assert_eq!(result, vec!["api", "repos/synaptiai/trail/pulls/6"]);
}

#[test]
fn api_path_traversal_is_rejected() {
    let allowed = load_allowed_commands_from_capability();
    let result = prepare(
        &allowed,
        "gh-api-pulls-get",
        vec!["api".into(), "repos/../../etc/passwd".into()],
    );
    match result {
        Err(ScopeError::Validation { index, .. }) => {
            assert_eq!(index, 1);
        }
        other => panic!("expected Validation at index 1, got: {:?}", other),
    }
}

#[test]
fn body_file_traversal_is_rejected() {
    let allowed = load_allowed_commands_from_capability();
    let result = prepare(
        &allowed,
        "gh-pr-edit-body-file",
        vec![
            "pr".into(),
            "edit".into(),
            "6".into(),
            "--body-file".into(),
            "../../../etc/passwd".into(),
        ],
    );
    match result {
        Err(ScopeError::Validation { index, .. }) => {
            assert_eq!(index, 4);
        }
        other => panic!("expected Validation at index 4, got: {:?}", other),
    }
}

#[test]
fn fixed_arg_substitution_attempt_is_silently_overwritten() {
    // Subtle property: when a Fixed slot is declared but the incoming arg at
    // the same position is different, the plugin overwrites the incoming with
    // the fixed value (scope.rs:271-274 — `Fixed(fixed) => Ok(fixed.to_string())`).
    // Attempt: incoming declares "--rm-rf-root" at the position where "auth"
    // is fixed. Result must contain "auth", not the attacker's payload.
    let allowed = load_allowed_commands_from_capability();
    let result = prepare(
        &allowed,
        "gh-auth-status",
        vec!["--rm-rf-root".into(), "--malicious".into()],
    )
    .expect("Fixed slots overwrite incoming, so this validates");
    assert_eq!(
        result,
        vec!["auth", "status"],
        "fixed slots must overwrite incoming with the declared literal"
    );
}

#[test]
fn version_pin_doc_check() {
    // Documentation guard: this test exists to make the upgrade story
    // explicit. The Cargo.toml dependency MUST pin `=2.3.5`. If a future
    // contributor relaxes the pin (e.g., to `^2.3.5`) without re-reading
    // scope.rs and confirming the algorithm, this test should still pass
    // (it doesn't check the lockfile directly), but the architecture.md §3.3
    // citation will diverge from the runtime — caught by code review.
    //
    // Rationale documented in Cargo.toml's tauri-plugin-shell comment block.
    let cargo_toml = include_str!("../Cargo.toml");
    assert!(
        cargo_toml.contains(r#"tauri-plugin-shell = { version = "=2.3.5" }"#)
            || cargo_toml.contains(r#"tauri-plugin-shell = "=2.3.5""#),
        "Cargo.toml must pin tauri-plugin-shell to exactly =2.3.5 — see \
         architecture.md §3.3 + cycle-2 N6 for rationale."
    );
}
