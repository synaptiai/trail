//! CLI bridge — typed subprocess invocation of `@synapti/trail-capture` (gh#11
//! criterion 11; gh#12 Sprint 5).
//!
//! Sprint 4's decisions go through the in-Rust saga (B5 §3.1); the CLI
//! bridge is the mechanism for invoking the capture binary for:
//!
//!   - `version`: probe the installed capture CLI's version so the UI
//!     can warn on a schema-version mismatch (B5 §6.6).
//!   - `packet post`: Sprint 5 (gh#12 AC-3, AC-4) — invoke Phase 3b's
//!     `trail packet post` to sync the packet to a GitHub PR body.
//!   - `packet decide`: Sprint 5 (gh#12 AC-4) — reviewer J9 loop
//!     closure via `trail packet decide`.
//!
//! The bridge spawns the binary with argv (no shell-string interp),
//! a long timeout for network-bound operations (300s for post/decide,
//! 30s for version probe), and validates stderr keywords for E5 + E6
//! edge-flow detection. The post/decide commands are interactive by
//! default; the bridge always passes `--yes` to skip the confirm prompt
//! (the M4 modal performs the destination confirmation in-app per B6
//! P1 hardening, so the CLI's interactive prompt is bypassed).
//!
//! `capture_cli_path` from settings.json (B5 §6.6) is the path; default
//! is `@synapti/trail-capture` (resolved via PATH; the user can override to a
//! local node_modules/.bin/trail or an absolute path).

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use thiserror::Error;
use tracing::warn;

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("timeout after {0:?}")]
    Timeout(Duration),
    #[error("non-zero exit ({code}): {stderr}")]
    NonZeroExit { code: i32, stderr: String },
    #[error("invalid stdout: {0}")]
    InvalidStdout(String),
}

impl BridgeError {
    /// Stable kebab-case discriminant used in the IPC error payload so the
    /// frontend can branch on the failure shape (display "binary not found"
    /// vs. "version probe timed out" vs. etc.) without parsing the message.
    pub fn kind(&self) -> &'static str {
        match self {
            BridgeError::Spawn(_) => "spawn",
            BridgeError::Timeout(_) => "timeout",
            BridgeError::NonZeroExit { .. } => "non-zero-exit",
            BridgeError::InvalidStdout(_) => "invalid-stdout",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CaptureVersion {
    /// e.g., "0.1.0-dev"
    pub version: String,
}

/// Spawn `<bin> --version` and parse the stdout. The capture CLI prints
/// the version string verbatim (commander.js convention), so we collect
/// the first line and trim whitespace.
///
/// Per gh#11 criterion 11 + 13 (no mocks): this IS the real subprocess
/// invocation — there is no fallback to py-reference because Phase 1's
/// `@synapti/trail-capture` is on main. If the binary is missing, return
/// `Spawn("...")` and the UI surfaces the error.
pub fn probe_capture_version(bin: &str) -> Result<CaptureVersion, BridgeError> {
    let argv = ["--version"];
    let timeout = Duration::from_secs(30);
    let mut child = Command::new(bin)
        .args(argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| BridgeError::Spawn(format!("{bin}: {e}")))?;

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|e| BridgeError::Spawn(format!("wait_with_output: {e}")))?;
                if !status.success() {
                    return Err(BridgeError::NonZeroExit {
                        code: status.code().unwrap_or(-1),
                        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                    });
                }
                let stdout = String::from_utf8_lossy(&output.stdout);
                let line = stdout.lines().next().unwrap_or("").trim();
                if line.is_empty() {
                    return Err(BridgeError::InvalidStdout(
                        "empty stdout from --version".into(),
                    ));
                }
                return Ok(CaptureVersion {
                    version: line.to_string(),
                });
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err(BridgeError::Timeout(timeout));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                return Err(BridgeError::Spawn(format!("try_wait: {e}")));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sprint 5 — `trail packet post` + `trail packet decide` subprocess invokers.
// ---------------------------------------------------------------------------
//
// These are the cli_bridge wrappers around Phase 3b's CLI surface. They
// do NOT re-implement gh API logic — Phase 3b (`apps/capture/src/post/`,
// `apps/capture/src/decide/`) owns that contract. The bridge merely:
//
//   1. Spawns the capture CLI with the right argv (always `--yes` —
//      the M4 modal performs destination confirmation in-app per B6 P1).
//   2. Captures stdout + stderr.
//   3. Maps the CLI's structured exit code (per Phase 3b's exit-codes.ts)
//      to a kebab-case `kind` for the UI's edge-flow Banner switch.
//
// The post/decide CLIs run subprocesses themselves (gh CLI for the actual
// network egress); the timeout here covers the entire chain so a hung gh
// auth flow or stalled HTTP request surfaces eventually rather than
// freezing the IPC indefinitely.

/// Phase 3b CLI exit codes (mirror of `apps/capture/src/exit-codes.ts`).
/// Centralised here so the kind mapping in `classify_packet_op_failure`
/// is auditable from one place.
const EXIT_OK: i32 = 0;
const EXIT_GENERIC: i32 = 1;
const EXIT_PACKET_NOT_FOUND: i32 = 2; // alias of EXIT_TRANSCRIPT_NOT_FOUND
const EXIT_AUTH: i32 = 3; // alias of EXIT_GIT_STATE
const EXIT_GH_MISSING: i32 = 4; // alias of EXIT_PATTERNS
const EXIT_VALIDATION: i32 = 5;
const EXIT_WRITE: i32 = 6;
const EXIT_NETWORK_OR_RATE_LIMIT: i32 = 7; // alias of EXIT_LLM_STRICT — both per cv-2
const EXIT_INVALID_ARGS: i32 = 8;
const EXIT_PR_NOT_FOUND: i32 = 9; // alias of EXIT_CONCURRENT

/// Stable kebab-case discriminant for packet-op (post/decide) failures.
/// Frontend Banner kinds branch on this verbatim. `kind()` mirrors the
/// pattern from Phase 3b's `GhErrorKind` so the UI's E1-E7 switch is one
/// match arm per kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PacketOpErrorKind {
    /// gh CLI not authenticated (E3 / E5 — gh auth expired).
    Auth,
    /// gh CLI not installed (E4 — `gh` absent on PATH).
    GhMissing,
    /// PR not found (distinct error per AC-7).
    PrNotFound,
    /// Network failure (E6) or rate-limit (403/429) — share exit 7 per cv-2;
    /// the message text disambiguates for the user.
    NetworkOrRateLimit,
    /// Packet YAML missing on disk (E1 corrupt-packet substitute when the
    /// packet path itself does not exist — distinct from parse-error).
    PacketNotFound,
    /// Schema validation failed (E1 — corrupt packet, schema mismatch).
    Validation,
    /// Local write failure (atomic-write rollback after PR landed).
    Write,
    /// User-supplied invalid arguments — programming error in the IPC
    /// caller; surfaces as `invalid-arguments` IpcError up-stack.
    InvalidArgs,
    /// Subprocess could not be spawned (E4 — capture CLI absent).
    Spawn,
    /// Timeout — the post/decide chain did not complete in N seconds.
    Timeout,
    /// Anything Phase 3b reports that we cannot map cleanly. Surfaces as
    /// a generic Banner with the raw stderr.
    Other,
}

impl PacketOpErrorKind {
    /// Stable kebab-case discriminant for the IPC payload.
    pub fn as_str(&self) -> &'static str {
        match self {
            PacketOpErrorKind::Auth => "auth",
            PacketOpErrorKind::GhMissing => "gh-missing",
            PacketOpErrorKind::PrNotFound => "pr-not-found",
            PacketOpErrorKind::NetworkOrRateLimit => "network-or-rate-limit",
            PacketOpErrorKind::PacketNotFound => "packet-not-found",
            PacketOpErrorKind::Validation => "validation",
            PacketOpErrorKind::Write => "write",
            PacketOpErrorKind::InvalidArgs => "invalid-args",
            PacketOpErrorKind::Spawn => "spawn",
            PacketOpErrorKind::Timeout => "timeout",
            PacketOpErrorKind::Other => "other",
        }
    }
}

/// Result of a successful `trail packet post` invocation. Phase 3b's
/// stderr emits `posted packet to <url> (body_hash <prefix>...)` on
/// success — we parse that line so the UI can display the PR URL +
/// body_hash prefix in the M4 confirmation toast.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PacketPostOutcome {
    pub pr_url: String,
    pub body_hash_prefix: String,
    /// Destination "owner/name#PR" — also emitted on stderr by Phase 3b
    /// post step 4 ("Posting to <dest> (<url>)"). The M4 modal already
    /// shows this pre-post; we surface it post-success too as confirm.
    pub destination: String,
}

/// Result of a successful `trail packet decide`. The CLI emits
/// `decision recorded: <claim> <decision>; comment + body posted to <url>`
/// on success.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PacketDecideOutcome {
    pub pr_url: String,
    pub claim_id: String,
    pub decision: String,
}

/// Failure from a packet-op subprocess. `stderr` carries the full CLI
/// stderr for Banner display; `kind` is the discriminant.
#[derive(Debug, Clone, Error)]
#[error("packet op failed (kind={kind:?}, exit={exit_code:?}): {stderr}")]
pub struct PacketOpError {
    pub kind: PacketOpErrorKind,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

/// Map a (exit code, stderr) pair into a `PacketOpErrorKind`. Phase 3b's
/// CLI exit code is the primary signal; we fall back to keyword matching
/// on stderr for the few classes where exit codes alias (e.g. exit 7 =
/// network OR rate-limit; we always map to NetworkOrRateLimit but a
/// future enhancement could disambiguate).
fn classify_packet_op_failure(exit_code: i32, stderr: &str) -> PacketOpErrorKind {
    match exit_code {
        EXIT_OK => PacketOpErrorKind::Other, // shouldn't happen on the failure path
        EXIT_AUTH => PacketOpErrorKind::Auth,
        EXIT_GH_MISSING => PacketOpErrorKind::GhMissing,
        EXIT_PR_NOT_FOUND => PacketOpErrorKind::PrNotFound,
        EXIT_NETWORK_OR_RATE_LIMIT => PacketOpErrorKind::NetworkOrRateLimit,
        EXIT_PACKET_NOT_FOUND => PacketOpErrorKind::PacketNotFound,
        EXIT_VALIDATION => PacketOpErrorKind::Validation,
        EXIT_WRITE => PacketOpErrorKind::Write,
        EXIT_INVALID_ARGS => PacketOpErrorKind::InvalidArgs,
        EXIT_GENERIC => {
            // Phase 3b uses exit 1 as the generic catch-all; keyword-sniff
            // stderr to refine where possible. This complements the exit
            // code so a CLI that prints "no such file" but exits 1
            // surfaces as PacketNotFound rather than Other.
            let lower = stderr.to_lowercase();
            if lower.contains("packet not found") || lower.contains("no such file") {
                PacketOpErrorKind::PacketNotFound
            } else {
                PacketOpErrorKind::Other
            }
        }
        _ => PacketOpErrorKind::Other,
    }
}

/// Parse Phase 3b's success-line stderr. The post CLI emits:
///   `Posting to owner/name#PR (https://github.com/...)`
///   `posted packet to <url> (body_hash <16hex>...)`
/// and the decide CLI emits:
///   `decision recorded: <claim> <decision>; comment + body posted to <url>`
fn parse_post_outcome(stderr: &str) -> Option<PacketPostOutcome> {
    let mut destination = String::new();
    let mut pr_url = String::new();
    let mut body_hash_prefix = String::new();
    for line in stderr.lines() {
        if let Some(rest) = line.strip_prefix("Posting to ") {
            // "<owner>/<name>#<N> (<url>)"
            if let Some(open) = rest.find(" (") {
                destination = rest[..open].trim().to_string();
            } else {
                destination = rest.trim().to_string();
            }
        } else if let Some(rest) = line.strip_prefix("posted packet to ") {
            // "<url> (body_hash <prefix>…)"
            if let Some(open) = rest.find(" (body_hash ") {
                pr_url = rest[..open].trim().to_string();
                let after = &rest[open + " (body_hash ".len()..];
                if let Some(close) = after.find(|c: char| c == '\u{2026}' || c == ')') {
                    body_hash_prefix = after[..close].trim().to_string();
                }
            } else {
                pr_url = rest.trim().to_string();
            }
        }
    }
    if pr_url.is_empty() {
        return None;
    }
    Some(PacketPostOutcome {
        pr_url,
        body_hash_prefix,
        destination,
    })
}

fn parse_decide_outcome(stderr: &str) -> Option<PacketDecideOutcome> {
    for line in stderr.lines() {
        if let Some(rest) = line.strip_prefix("decision recorded: ") {
            // "<claim> <decision>; comment + body posted to <url>"
            let semi = rest.find(';')?;
            let head = rest[..semi].trim();
            let mut head_parts = head.splitn(2, ' ');
            let claim_id = head_parts.next()?.trim().to_string();
            let decision = head_parts.next()?.trim().to_string();
            let tail = &rest[semi + 1..];
            let url_marker = "posted to ";
            let url_idx = tail.find(url_marker)?;
            let pr_url = tail[url_idx + url_marker.len()..].trim().to_string();
            return Some(PacketDecideOutcome {
                pr_url,
                claim_id,
                decision,
            });
        }
    }
    None
}

/// Spawn a subprocess with argv, wait up to `timeout`, return stdout,
/// stderr, and exit status. Generic primitive that the post/decide
/// invokers compose. NEVER uses shell-string interp (no shell injection).
fn spawn_with_timeout(
    bin: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<(String, String, std::process::ExitStatus), BridgeError> {
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| BridgeError::Spawn(format!("{bin}: {e}")))?;

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|e| BridgeError::Spawn(format!("wait_with_output: {e}")))?;
                return Ok((
                    String::from_utf8_lossy(&output.stdout).into_owned(),
                    String::from_utf8_lossy(&output.stderr).into_owned(),
                    status,
                ));
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err(BridgeError::Timeout(timeout));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(BridgeError::Spawn(format!("try_wait: {e}"))),
        }
    }
}

/// Convert a generic `BridgeError` from the subprocess primitive into a
/// `PacketOpError`. Spawn failure → `Spawn`; timeout → `Timeout`;
/// non-zero exit → classified by exit code + stderr.
fn bridge_to_packet_err(err: BridgeError, stderr_so_far: String) -> PacketOpError {
    match err {
        BridgeError::Spawn(msg) => PacketOpError {
            kind: PacketOpErrorKind::Spawn,
            stderr: msg,
            exit_code: None,
        },
        BridgeError::Timeout(_) => PacketOpError {
            kind: PacketOpErrorKind::Timeout,
            stderr: stderr_so_far,
            exit_code: None,
        },
        BridgeError::NonZeroExit { code, stderr } => PacketOpError {
            kind: classify_packet_op_failure(code, &stderr),
            stderr,
            exit_code: Some(code),
        },
        BridgeError::InvalidStdout(msg) => PacketOpError {
            kind: PacketOpErrorKind::Other,
            stderr: msg,
            exit_code: None,
        },
    }
}

/// Default timeout for `trail packet post` + `trail packet decide`.
/// 300s covers the gh auth handshake + several PR API roundtrips at
/// pessimistic latency. The post path makes ~4 gh API calls (auth,
/// repo view, pr view, pr edit + body read); decide makes ~6.
pub const PACKET_OP_DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);

/// Invoke `trail packet post --packet <path> [--pr <N>] --yes [--posted-by <id>]`.
/// Returns the parsed success outcome on exit 0; structured `PacketOpError`
/// otherwise. The caller (IPC handler) translates the kind into the
/// matching `IpcError` variant so the M4 modal can surface the right
/// edge-flow Banner.
///
/// The bridge always passes `--yes` because the M4 modal performs
/// destination confirmation in-app (B6 P1 hardening).
pub fn invoke_packet_post(
    bin: &str,
    packet_path: &str,
    pr_number: Option<u32>,
    posted_by: &str,
    timeout: Duration,
) -> Result<PacketPostOutcome, PacketOpError> {
    let pr_str: String;
    let mut args: Vec<&str> = vec!["packet", "post", "--packet", packet_path, "--yes"];
    if let Some(n) = pr_number {
        pr_str = n.to_string();
        args.push("--pr");
        args.push(&pr_str);
    }
    if !posted_by.is_empty() {
        args.push("--posted-by");
        args.push(posted_by);
    }
    let (_stdout, stderr, status) = match spawn_with_timeout(bin, &args, timeout) {
        Ok(v) => v,
        Err(e) => {
            warn!(target: "trail::cli_bridge::post", error = %e, "spawn_with_timeout failed");
            return Err(bridge_to_packet_err(e, String::new()));
        }
    };
    if !status.success() {
        let code = status.code().unwrap_or(-1);
        return Err(PacketOpError {
            kind: classify_packet_op_failure(code, &stderr),
            stderr,
            exit_code: Some(code),
        });
    }
    // Parse the post-success line. If parsing fails (Phase 3b CLI changed
    // its output format), still return Ok with whatever we found — we
    // know the post succeeded because exit was 0.
    if let Some(outcome) = parse_post_outcome(&stderr) {
        return Ok(outcome);
    }
    warn!(target: "trail::cli_bridge::post", "post exited 0 but could not parse stderr; stderr={}", stderr);
    Ok(PacketPostOutcome {
        pr_url: String::new(),
        body_hash_prefix: String::new(),
        destination: String::new(),
    })
}

/// Invoke `trail packet decide --packet <p> [--pr <N>] --claim <c>
/// --decision <d> [--reason <r>] [--by <b>]`.
pub fn invoke_packet_decide(
    bin: &str,
    packet_path: &str,
    pr_number: Option<u32>,
    claim: &str,
    decision: &str,
    reason: Option<&str>,
    by: &str,
    timeout: Duration,
) -> Result<PacketDecideOutcome, PacketOpError> {
    let pr_str: String;
    let mut args: Vec<&str> = vec![
        "packet",
        "decide",
        "--packet",
        packet_path,
        "--claim",
        claim,
        "--decision",
        decision,
    ];
    if let Some(n) = pr_number {
        pr_str = n.to_string();
        args.push("--pr");
        args.push(&pr_str);
    }
    if let Some(r) = reason {
        args.push("--reason");
        args.push(r);
    }
    if !by.is_empty() {
        args.push("--by");
        args.push(by);
    }
    let (_stdout, stderr, status) = match spawn_with_timeout(bin, &args, timeout) {
        Ok(v) => v,
        Err(e) => {
            warn!(target: "trail::cli_bridge::decide", error = %e, "spawn_with_timeout failed");
            return Err(bridge_to_packet_err(e, String::new()));
        }
    };
    if !status.success() {
        let code = status.code().unwrap_or(-1);
        return Err(PacketOpError {
            kind: classify_packet_op_failure(code, &stderr),
            stderr,
            exit_code: Some(code),
        });
    }
    if let Some(outcome) = parse_decide_outcome(&stderr) {
        return Ok(outcome);
    }
    warn!(target: "trail::cli_bridge::decide", "decide exited 0 but could not parse stderr; stderr={}", stderr);
    Ok(PacketDecideOutcome {
        pr_url: String::new(),
        claim_id: claim.to_string(),
        decision: decision.to_string(),
    })
}

/// Validate that `bin` resolves to a runnable command. Used by the UI's
/// settings panel to gate the "save" of a custom `capture_cli_path`. We
/// run a quick `--version` probe; non-success → reject the path.
pub fn validate_capture_cli_path(bin_or_path: &str) -> Result<CaptureVersion, BridgeError> {
    // Lightweight path-existence check when looks like an absolute path,
    // before paying the spawn cost.
    if bin_or_path.starts_with('/') || bin_or_path.starts_with('.') {
        if !Path::new(bin_or_path).exists() {
            return Err(BridgeError::Spawn(format!(
                "no such file: {bin_or_path}"
            )));
        }
    }
    let result = probe_capture_version(bin_or_path);
    if let Err(ref e) = result {
        warn!(target: "trail::cli_bridge", path = %bin_or_path, error = %e, "capture CLI probe failed");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cycle-1.5 F10 (P3): the cargo tests below use POSIX utilities
    // (echo / true / false / /nonexistent) to exercise the generic
    // subprocess primitives. End-to-end coverage of "UI → Tauri →
    // cli_bridge → @synapti/trail-capture --version" requires a Playwright
    // harness that points `capture_cli_path` at a node script
    // emitting "0.1.0-dev"; that's deferred to the Playwright spec
    // suite. The vitest M6SettingsModal-cli-bridge.test.tsx
    // integration test (Sprint 4 cycle-1.5 F3 fix) covers the React
    // pathway end-to-end with a mocked Tauri bridge — which jointly
    // close AC-11 modulo the real-binary subprocess test.

    /// Write a minimal POSIX shell-script fixture under tmp/ that we
    /// can pass to `probe_capture_version` (via its first argv) for a
    /// portable subprocess test. GNU coreutils on Linux interprets
    /// `--version` flags on `echo` and `true` (printing version banners),
    /// which broke the prior fixture-by-builtin approach on CI runners.
    /// A handcrafted shell script avoids that platform variance.
    fn write_test_script(body: &str) -> std::path::PathBuf {
        use std::fs::{self, File};
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("trail-cli-bridge-test-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("create_dir_all");
        // Use a per-test file name so concurrent tests don't collide.
        // Counter is process-local; each test gets a fresh script.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path = dir.join(format!("script-{n}.sh"));
        {
            let mut f = File::create(&path).expect("create script");
            writeln!(f, "#!/bin/sh").unwrap();
            f.write_all(body.as_bytes()).unwrap();
            f.write_all(b"\n").unwrap();
            f.sync_all().expect("sync_all");
            // Explicit scope-drop closes the file handle before we set
            // execute permissions and spawn. Without this, parallel cargo
            // test threads can hit ETXTBSY ("Text file busy") when a
            // sibling test attempts to exec the script while THIS thread's
            // File handle is still open. Observed flake: PR #21 cycle-1
            // CI run 25613777334.
        }
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
        path
    }

    /// Not a fake — invokes a REAL subprocess (a handcrafted shell script
    /// that emits a known version line). We deliberately do NOT mock
    /// `Command`; the bridge must work on a real subprocess (gh#11
    /// criterion 13). The handcrafted script avoids Linux/BSD divergence
    /// on builtins like `echo` / `true` (Sprint 5 fix: GNU coreutils on
    /// CI runners interprets `--version` and prints a version banner,
    /// breaking the prior `probe_capture_version("echo")` fixture).
    #[test]
    fn probe_returns_first_line_of_stdout() {
        let script = write_test_script("printf '0.1.0-dev\\n'");
        let result = probe_capture_version(&script.to_string_lossy());
        assert!(
            result.is_ok(),
            "real subprocess invocation must succeed: {result:?}"
        );
        let version = result.unwrap();
        assert_eq!(version.version, "0.1.0-dev");
    }

    #[test]
    fn probe_returns_spawn_error_on_missing_binary() {
        let result = probe_capture_version("/nonexistent/binary/that/cannot/exist");
        match result {
            Err(BridgeError::Spawn(_)) => {}
            other => panic!("expected Spawn error, got {other:?}"),
        }
    }

    #[test]
    fn probe_rejects_empty_stdout() {
        // Script exits 0 with no stdout; bridge must return InvalidStdout.
        // (Sprint 5 fix: GNU `true --version` on Linux emits a banner;
        // a handcrafted no-output script is platform-portable.)
        let script = write_test_script("exit 0");
        let result = probe_capture_version(&script.to_string_lossy());
        match result {
            Err(BridgeError::InvalidStdout(_)) => {}
            other => panic!("expected InvalidStdout error, got {other:?}"),
        }
    }

    #[test]
    fn probe_rejects_non_zero_exit() {
        // Script exits 1 with no output; bridge must return NonZeroExit.
        let script = write_test_script("exit 1");
        let result = probe_capture_version(&script.to_string_lossy());
        match result {
            Err(BridgeError::NonZeroExit { code, .. }) => {
                assert_eq!(code, 1);
            }
            other => panic!("expected NonZeroExit, got {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_absent_absolute_path() {
        let result = validate_capture_cli_path("/nonexistent/binary/that/cannot/exist");
        match result {
            Err(BridgeError::Spawn(_)) => {}
            other => panic!("expected Spawn error for absent path, got {other:?}"),
        }
    }

    // ----- Sprint 5 (gh#12) — packet post + decide subprocess invokers ------

    #[test]
    fn classify_maps_each_phase3b_exit_code() {
        // Each Phase 3b exit code maps to exactly one PacketOpErrorKind.
        // Drift between this map and apps/capture/src/exit-codes.ts is a
        // SECURITY-relevant correctness issue: a misclassified auth-fail
        // would surface as "network error" and prompt the user to retry
        // when they should be running `gh auth login` instead.
        assert_eq!(classify_packet_op_failure(2, ""), PacketOpErrorKind::PacketNotFound);
        assert_eq!(classify_packet_op_failure(3, ""), PacketOpErrorKind::Auth);
        assert_eq!(classify_packet_op_failure(4, ""), PacketOpErrorKind::GhMissing);
        assert_eq!(classify_packet_op_failure(5, ""), PacketOpErrorKind::Validation);
        assert_eq!(classify_packet_op_failure(6, ""), PacketOpErrorKind::Write);
        assert_eq!(
            classify_packet_op_failure(7, ""),
            PacketOpErrorKind::NetworkOrRateLimit
        );
        assert_eq!(classify_packet_op_failure(8, ""), PacketOpErrorKind::InvalidArgs);
        assert_eq!(classify_packet_op_failure(9, ""), PacketOpErrorKind::PrNotFound);
    }

    #[test]
    fn classify_exit_1_with_packet_not_found_keyword_refines_to_packet_not_found() {
        // Phase 3b's "no such file" / "packet not found" stderr lines
        // come back with exit 1 (generic) in some code paths; the
        // keyword-sniffing branch refines the classification so the
        // M4 modal can show the right edge-flow Banner (E1 corrupt
        // packet vs E5 gh auth expired).
        let kind = classify_packet_op_failure(1, "error: packet not found: /tmp/missing.yml");
        assert_eq!(kind, PacketOpErrorKind::PacketNotFound);
        let kind2 = classify_packet_op_failure(1, "ENOENT: no such file");
        assert_eq!(kind2, PacketOpErrorKind::PacketNotFound);
    }

    #[test]
    fn classify_exit_1_unknown_falls_back_to_other() {
        let kind = classify_packet_op_failure(1, "something weird happened");
        assert_eq!(kind, PacketOpErrorKind::Other);
    }

    #[test]
    fn kind_str_round_trips_for_all_variants() {
        // The kind str is the IPC discriminant; if we add a variant
        // without a string mapping it would be UB-ish (silent default).
        let all = [
            PacketOpErrorKind::Auth,
            PacketOpErrorKind::GhMissing,
            PacketOpErrorKind::PrNotFound,
            PacketOpErrorKind::NetworkOrRateLimit,
            PacketOpErrorKind::PacketNotFound,
            PacketOpErrorKind::Validation,
            PacketOpErrorKind::Write,
            PacketOpErrorKind::InvalidArgs,
            PacketOpErrorKind::Spawn,
            PacketOpErrorKind::Timeout,
            PacketOpErrorKind::Other,
        ];
        for v in &all {
            let s = v.as_str();
            assert!(!s.is_empty());
            assert!(s.chars().all(|c| c.is_ascii_lowercase() || c == '-'));
        }
    }

    #[test]
    fn parse_post_outcome_extracts_url_and_body_hash() {
        // Mirrors Phase 3b post/index.ts's stderr emission verbatim.
        let stderr = "Posting to synaptiai/trail#432 (https://github.com/synaptiai/trail/pull/432)\nposted packet to https://github.com/synaptiai/trail/pull/432 (body_hash 0123456789abcdef\u{2026})\n";
        let outcome = parse_post_outcome(stderr).expect("must parse");
        assert_eq!(outcome.destination, "synaptiai/trail#432");
        assert_eq!(
            outcome.pr_url,
            "https://github.com/synaptiai/trail/pull/432"
        );
        assert_eq!(outcome.body_hash_prefix, "0123456789abcdef");
    }

    #[test]
    fn parse_post_outcome_returns_none_when_post_line_absent() {
        let stderr = "no post happened here\n";
        assert!(parse_post_outcome(stderr).is_none());
    }

    #[test]
    fn parse_decide_outcome_extracts_claim_decision_url() {
        let stderr = "decision recorded: CLAIM-001 block; comment + body posted to https://github.com/synaptiai/trail/pull/432\n";
        let outcome = parse_decide_outcome(stderr).expect("must parse");
        assert_eq!(outcome.claim_id, "CLAIM-001");
        assert_eq!(outcome.decision, "block");
        assert_eq!(
            outcome.pr_url,
            "https://github.com/synaptiai/trail/pull/432"
        );
    }

    #[test]
    fn parse_decide_outcome_handles_stable_id_claim() {
        let stderr = "decision recorded: 0123456789abcdef accept; comment + body posted to https://example.com/pr/1\n";
        let outcome = parse_decide_outcome(stderr).expect("must parse");
        assert_eq!(outcome.claim_id, "0123456789abcdef");
        assert_eq!(outcome.decision, "accept");
    }

    #[test]
    fn parse_decide_outcome_returns_none_when_format_mismatch() {
        assert!(parse_decide_outcome("nothing here\n").is_none());
        assert!(parse_decide_outcome("decision recorded: only-one-token\n").is_none());
    }

    #[test]
    fn invoke_packet_post_returns_spawn_error_on_missing_binary() {
        let result = invoke_packet_post(
            "/nonexistent/binary/cannot-exist",
            "/tmp/packet.yml",
            None,
            "tester",
            Duration::from_secs(2),
        );
        let err = result.expect_err("spawn must fail for absent binary");
        assert_eq!(err.kind, PacketOpErrorKind::Spawn);
    }

    #[test]
    fn invoke_packet_decide_returns_spawn_error_on_missing_binary() {
        let result = invoke_packet_decide(
            "/nonexistent/binary/cannot-exist",
            "/tmp/packet.yml",
            None,
            "CLAIM-001",
            "block",
            Some("breaks build"),
            "tester",
            Duration::from_secs(2),
        );
        let err = result.expect_err("spawn must fail for absent binary");
        assert_eq!(err.kind, PacketOpErrorKind::Spawn);
    }

    #[test]
    fn invoke_packet_post_classifies_non_zero_exit() {
        // `false` exits 1 with no stderr; classification falls through to
        // Other (no keyword match). The kind discriminant is what the IPC
        // layer surfaces; the exit code is captured for evidence.
        let result = invoke_packet_post(
            "false",
            "/tmp/packet.yml",
            None,
            "tester",
            Duration::from_secs(2),
        );
        let err = result.expect_err("false must report non-zero exit");
        assert_eq!(err.kind, PacketOpErrorKind::Other);
        assert_eq!(err.exit_code, Some(1));
    }

    #[test]
    fn spawn_with_timeout_returns_timeout_on_long_running_subprocess() {
        // `sleep 5` is too long for a 200ms timeout; the bridge must kill
        // the child and return Timeout. Verifies the gh hangup safety
        // net for a stalled `gh auth login` etc.
        let result = spawn_with_timeout("sleep", &["5"], Duration::from_millis(200));
        match result {
            Err(BridgeError::Timeout(_)) => {}
            other => panic!("expected Timeout, got {other:?}"),
        }
    }

    // --- Sprint 6 (gh#13 AC-4 F5 fold): pin Phase 3b exit-7 → kind mapping.
    //
    // The classifier maps exit codes 1:1 to PacketOpErrorKind. Exit 7
    // (NETWORK_OR_RATE_LIMIT) is the shared bucket for both genuine
    // network failures and HTTP 403/429 rate-limit responses; the Rust
    // classifier returns NetworkOrRateLimit purely on the exit code,
    // regardless of stderr content. The UI then disambiguates via stderr
    // keyword sniffing in `apps/ui/src/services/gh-post.ts::classifyGhError`
    // for affordance-level messaging ("wait + retry" vs "check connection").
    //
    // CYCLE-1.5 F4 (PR #21): the four tests below are NAMED for the stderr
    // keyword shape the UI consumes, but their assertion power is the
    // exit-code-pinning of NetworkOrRateLimit — they would all pass with
    // empty stderr. Tests retained because pinning the exit-7 → kind map
    // for representative real-world stderr fragments is the contract the
    // UI relies on; the names below document the stderr fragments that
    // the UI's classifyGhError sniffs, so a future renumber of EXIT_*
    // constants can't silently break the UI's affordance branching.

    #[test]
    fn classify_packet_op_failure_exit_7_pins_network_or_rate_limit_for_rate_limit_stderr() {
        let kind = classify_packet_op_failure(EXIT_NETWORK_OR_RATE_LIMIT, "rate limit exceeded");
        assert_eq!(kind, PacketOpErrorKind::NetworkOrRateLimit);
    }

    #[test]
    fn classify_packet_op_failure_exit_7_pins_network_or_rate_limit_for_http_403_stderr() {
        // GitHub returns HTTP 403 with stderr like "API rate limit exceeded for ...".
        let kind =
            classify_packet_op_failure(EXIT_NETWORK_OR_RATE_LIMIT, "HTTP 403: API rate limit");
        assert_eq!(kind, PacketOpErrorKind::NetworkOrRateLimit);
    }

    #[test]
    fn classify_packet_op_failure_exit_7_pins_network_or_rate_limit_for_http_429_stderr() {
        // GitHub also returns HTTP 429 for secondary rate limits.
        let kind = classify_packet_op_failure(
            EXIT_NETWORK_OR_RATE_LIMIT,
            "HTTP 429 Too Many Requests",
        );
        assert_eq!(kind, PacketOpErrorKind::NetworkOrRateLimit);
    }

    #[test]
    fn classify_packet_op_failure_exit_7_pins_network_or_rate_limit_independent_of_stderr() {
        // The exit code alone is sufficient — rate-limit-specific stderr
        // is the UI's affordance for showing a "wait + retry" message,
        // but the Rust classifier doesn't gate on it. This test makes
        // that exit-code-only contract explicit (vs the three above
        // which document the representative stderr fragments).
        let kind = classify_packet_op_failure(EXIT_NETWORK_OR_RATE_LIMIT, "connection refused");
        assert_eq!(kind, PacketOpErrorKind::NetworkOrRateLimit);
    }

    #[test]
    fn classify_packet_op_failure_exit_1_with_no_such_file_keyword_is_packet_not_found() {
        // Exit 1 is the catch-all; the keyword sniff refines for "no
        // such file" → PacketNotFound (a known kind) rather than
        // Other. Documented in the function's body comment.
        let kind = classify_packet_op_failure(
            EXIT_GENERIC,
            "Error: ENOENT: no such file or directory",
        );
        assert_eq!(kind, PacketOpErrorKind::PacketNotFound);
    }

    #[test]
    fn classify_packet_op_failure_exit_1_with_packet_not_found_keyword_is_packet_not_found() {
        let kind = classify_packet_op_failure(EXIT_GENERIC, "packet not found at /tmp/x.yml");
        assert_eq!(kind, PacketOpErrorKind::PacketNotFound);
    }

    #[test]
    fn classify_packet_op_failure_exit_1_with_other_keyword_falls_through_to_other() {
        let kind = classify_packet_op_failure(EXIT_GENERIC, "unexpected error: yaml parse");
        assert_eq!(kind, PacketOpErrorKind::Other);
    }
}
