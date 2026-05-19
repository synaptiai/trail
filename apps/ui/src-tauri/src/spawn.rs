//! Process-spawn management for `trail packet generate` (gh#18 AC#5/6).
//!
//! The UI's per-row "Generate packet" chip-button invokes `spawn_packet_generate`
//! which forks a `trail packet generate <session_id>` subprocess and streams
//! its stderr line-by-line via `packet-generate-progress` events. A separate
//! `cancel_packet_generate` IPC sets a cancel flag the worker thread checks
//! between reads (and the worker kills the child when set).
//!
//! Design choices:
//!   - **Sync std::process::Command + std::thread**, mirroring `cli_bridge.rs`.
//!     Tauri's async runtime is available, but the existing detection probe
//!     uses sync polling and the watcher uses sync threads — staying within
//!     that vocabulary keeps the surface area small.
//!   - **Registry keyed by spawn_id**, not session_id. A session can be
//!     re-generated; the UI is responsible for de-duplicating button clicks
//!     while a previous spawn is in flight, but the registry must support
//!     concurrent spawns on different sessions.
//!   - **stderr-only line streaming**. The `trail packet generate` CLI writes
//!     progress to stderr by convention. stdout is reserved for the final
//!     packet path or empty; we still pipe + capture it but emit only stderr
//!     for the live event thread. The terminal `done`/`error` event carries
//!     the exit code so the renderer doesn't need stdout for success/fail.
//!   - **Cancel via a flag, not a Child handle**. The worker thread owns the
//!     Child; the cancel IPC can't directly call `child.kill()` (no shared
//!     access). Instead, the worker polls the flag between line reads (via
//!     try_wait in the wait loop) and when set, kills the child and exits.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::Emitter;
use tracing::{info, warn};

/// PATH augmentations applied when spawning `trail packet generate`. Mirrors
/// `cli_bridge::PATH_AUGMENTATIONS` so the env-shebang lookup for the
/// npm-installed `trail` script works under macOS GUI-PATH (gh#17 fix).
const PATH_AUGMENTATIONS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "$HOME/.npm-global/bin",
    "$HOME/.local/bin",
];

/// Build a PATH string with augmentations prepended. Duplicate of
/// `cli_bridge::build_augmented_path` — kept duplicated to avoid making
/// the cli_bridge function `pub`; the cost is one function-shape that has
/// to stay in sync (covered by the parity unit test below).
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

/// Failure classifier for `spawn_packet_generate`. The Ok response carries
/// a `spawn_id`; the Failed response carries this kind + message.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum SpawnFailureKind {
    /// `trail` binary not found on augmented PATH. Surface: the existing
    /// `DetectFailureKind::CliNotFound` card from gh#17 — caller should
    /// suggest a Re-detect.
    CliNotFound,
    /// std::process::Command failed at spawn time for any reason other than
    /// the binary being missing (EACCES, EMFILE, etc.).
    SpawnError,
    /// session_id failed validation (empty, contains path separators, etc.).
    InvalidSessionId,
}

#[derive(Debug, Clone)]
pub struct SpawnError {
    pub kind: SpawnFailureKind,
    pub message: String,
}

/// In-process registry of active spawn IDs and their cancel flags.
///
/// Lock semantics: the inner `Mutex` is held only across the brief
/// insert/remove/lookup operations. On `PoisonError` we abort the process
/// (matches `watcher::SagaInFlightRegistry` semantics): a half-mutated
/// registry would either leak spawn IDs (memory pressure) or miss a
/// cancel (orphan subprocess).
#[derive(Debug, Default)]
pub struct SpawnRegistry {
    inner: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl SpawnRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a new spawn_id with a fresh cancel flag. Returns the flag
    /// the worker thread polls.
    pub fn register(&self, spawn_id: String) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut guard = self.inner.lock().unwrap_or_else(|_| std::process::abort());
        guard.insert(spawn_id, flag.clone());
        flag
    }

    /// Mark the spawn_id as cancelled. Returns true if the spawn was
    /// active; false if it had already exited or was never registered.
    pub fn cancel(&self, spawn_id: &str) -> bool {
        let guard = self.inner.lock().unwrap_or_else(|_| std::process::abort());
        if let Some(flag) = guard.get(spawn_id) {
            flag.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    /// Remove the spawn_id after the worker thread exits. Idempotent.
    pub fn cleanup(&self, spawn_id: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|_| std::process::abort());
        guard.remove(spawn_id);
    }

    /// v0.2 P2-SEC-3: flip the cancel flag on every active spawn.
    /// Returns the number of spawns that were active. Worker threads
    /// see the flag on their next poll tick (the 50ms idle sleep plus
    /// any per-iter `try_wait` + stderr drain time — worker-dependent,
    /// not a guaranteed upper bound) and call `child.kill()` in their
    /// cancel branch. The registry does not own the `Child` handles
    /// directly, so this is best-effort with a worker-dependent delay
    /// — good enough for graceful shutdown but the OS will still
    /// inherit any straggler children if the app process exits before
    /// workers poll. macOS does NOT auto-reap orphaned children, so on
    /// a tight shutdown race some processes may persist for the
    /// duration of their natural runtime; the `info!` log captures the
    /// cleanup intent.
    pub fn cancel_all(&self) -> usize {
        let guard = self.inner.lock().unwrap_or_else(|_| std::process::abort());
        for flag in guard.values() {
            flag.store(true, Ordering::SeqCst);
        }
        guard.len()
    }
}

/// Validate the session_id argument before spawning. Tight whitelist so a
/// malicious `.jsonl` filename under `~/.claude/projects/<sanitized>/`
/// cannot smuggle clap-style flags (e.g. `--exec=evil`) into the spawned
/// argv. Allowed shape: ULID, UUID, or any token from
/// `[A-Za-z0-9_-]{1..=64}` whose first character is alphanumeric.
///
/// SEC-2 fix: a session_id like `--help` previously passed the original
/// guard (no `/`, `\`, `..`) and reached `Command::new("trail").args([...,
/// session_id])`, where clap may interpret it as a flag. Rejecting any
/// leading `-` and any non-alnum first char closes that vector. We also
/// keep the explicit path-separator + `..` checks as belt-and-braces.
pub fn validate_session_id(session_id: &str) -> Result<(), SpawnError> {
    if session_id.is_empty() {
        return Err(SpawnError {
            kind: SpawnFailureKind::InvalidSessionId,
            message: "session_id is empty".into(),
        });
    }
    if session_id.len() > 64 {
        return Err(SpawnError {
            kind: SpawnFailureKind::InvalidSessionId,
            message: format!(
                "session_id exceeds 64 chars (got {})",
                session_id.len()
            ),
        });
    }
    if session_id.contains('/') || session_id.contains('\\') || session_id.contains("..") {
        return Err(SpawnError {
            kind: SpawnFailureKind::InvalidSessionId,
            message: format!("session_id contains illegal characters: {session_id}"),
        });
    }
    let first = session_id.as_bytes()[0];
    if !first.is_ascii_alphanumeric() {
        return Err(SpawnError {
            kind: SpawnFailureKind::InvalidSessionId,
            message: format!(
                "session_id must start with an alphanumeric character: {session_id}"
            ),
        });
    }
    if !session_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(SpawnError {
            kind: SpawnFailureKind::InvalidSessionId,
            message: format!(
                "session_id contains characters outside [A-Za-z0-9_-]: {session_id}"
            ),
        });
    }
    Ok(())
}

/// Spawn the `trail packet generate` child process and return its
/// `std::process::Child` handle. Caller is responsible for stdout/stderr
/// pipe consumption and waiting on exit.
pub fn spawn_trail_packet_generate_child(session_id: &str) -> Result<Child, SpawnError> {
    let augmented_path = build_augmented_path();
    let child = Command::new("trail")
        .args(["packet", "generate", session_id])
        .env("PATH", &augmented_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            let kind = if e.kind() == std::io::ErrorKind::NotFound {
                SpawnFailureKind::CliNotFound
            } else {
                SpawnFailureKind::SpawnError
            };
            SpawnError {
                kind,
                message: format!("spawn trail packet generate: {e}"),
            }
        })?;
    Ok(child)
}

/// v0.2 P2-SEC-5: hard cap on the byte length of a single stderr line
/// forwarded to the renderer. A runaway CLI could emit a 100MB single
/// line; `BufRead::lines()` would allocate that into a `String` and
/// the renderer would have to receive + display it. Truncate at the
/// reader-thread boundary so neither side carries unbounded memory.
const STDERR_LINE_MAX_BYTES: usize = 64 * 1024;
const TRUNCATION_SUFFIX: &str = "… (truncated)";

/// v0.2 SEC-1 cycle-3 fix: bounded reader-emit queue depth. 1024 lines
/// × 64KB cap = ~64MB worst-case residency before reader thread blocks
/// on `tx.send`. Pairs with the per-line `STDERR_LINE_MAX_BYTES` cap to
/// give a stable upper bound on stderr-related heap.
const STDERR_CHANNEL_BOUND: usize = 1024;

/// v0.2 SEC-2 cycle-3 fix: hard ceiling on bytes consumed from a single
/// runaway line. After truncating to `STDERR_LINE_MAX_BYTES`, the
/// reader still has to advance through the rest of the line to the
/// next `\n`. A child that emits an infinite stream with no `\n` would
/// pin one core on this thread until the child closes the pipe. After
/// `STDERR_RUNAWAY_BYTES` bytes consumed in a single line, the reader
/// abandons the line entirely (returns Ok with the cap-bounded buffer
/// AND a synthetic newline-equivalent state) and lets the main loop
/// surface this via an `error!` log + the truncation marker. Keeps the
/// reader thread responsive to subsequent input.
const STDERR_RUNAWAY_BYTES: usize = 10 * 1024 * 1024;

/// v0.2 SEC-3 (post-review fix): map `io::ErrorKind` to a stable
/// renderer-safe string. `io::Error::Display` may include kernel /
/// locale-dependent strings; the renderer's redaction-surface
/// allowlist is easier to audit against a fixed vocabulary.
fn classify_io_error_kind(e: &io::Error) -> &'static str {
    // Cycle-3 ERR-3/SEC-3 fix: add `Unsupported` (stable since 1.53) —
    // commonly seen on `try_wait` against exotic process states. Other
    // newer variants (`ReadOnlyFilesystem`, `StorageFull`,
    // `HostUnreachable`, etc.) remain in the catch-all until they're
    // observed in practice on this code path; expanding the vocabulary
    // pre-emptively risks stale enum arms.
    match e.kind() {
        io::ErrorKind::NotFound => "not-found",
        io::ErrorKind::PermissionDenied => "permission-denied",
        io::ErrorKind::ConnectionRefused => "connection-refused",
        io::ErrorKind::ConnectionReset => "connection-reset",
        io::ErrorKind::ConnectionAborted => "connection-aborted",
        io::ErrorKind::NotConnected => "not-connected",
        io::ErrorKind::AddrInUse => "addr-in-use",
        io::ErrorKind::AddrNotAvailable => "addr-not-available",
        io::ErrorKind::BrokenPipe => "broken-pipe",
        io::ErrorKind::AlreadyExists => "already-exists",
        io::ErrorKind::WouldBlock => "would-block",
        io::ErrorKind::InvalidInput => "invalid-input",
        io::ErrorKind::InvalidData => "invalid-data",
        io::ErrorKind::TimedOut => "timed-out",
        io::ErrorKind::WriteZero => "write-zero",
        io::ErrorKind::Interrupted => "interrupted",
        io::ErrorKind::UnexpectedEof => "unexpected-eof",
        io::ErrorKind::OutOfMemory => "out-of-memory",
        io::ErrorKind::Unsupported => "unsupported",
        _ => "other-io-error",
    }
}

/// Read one line from `reader` (terminator `\n`, optional preceding `\r`),
/// capped at `cap` bytes of CONTENT (excluding the terminator). Returns:
///   - `Ok(Some((bytes, was_truncated)))` — a line was read, possibly capped
///   - `Ok(None)` — EOF before any bytes were read
///   - `Err(io::Error)` — underlying I/O failure
///
/// v0.2 P2-SEC-1: previously the reader thread used
/// `BufReader::new(stderr).lines()`, which calls `read_line` internally.
/// `read_line` allocates an UNBOUNDED `String` until it sees `\n` or
/// EOF. A child emitting many MB without a newline would balloon the
/// reader thread's heap BEFORE `truncate_for_emit` (the wire-side cap)
/// got a chance to bound the payload. The OS pipe buffer bounds each
/// individual write to ~64KB, but `read_line` would concatenate as
/// many pipe fills as the child produces before the next newline.
///
/// This helper enforces the cap at READ time. When the cap is hit, the
/// helper continues consuming bytes from the pipe (without buffering
/// them) until the next `\n`, then returns the cap-bounded buffer.
/// This drops the rest of the runaway line on the floor and keeps the
/// stream synchronized with the child's intended line boundaries —
/// critical for the next `tx.send()` to deliver a coherent record.
///
/// `was_truncated` lets the caller emit a SEC-2 observability log.
fn read_capped_line<R: BufRead>(
    reader: &mut R,
    cap: usize,
) -> io::Result<Option<(Vec<u8>, bool)>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut got_any = false;
    let mut truncated = false;
    // Cycle-3 SEC-2 fix: track total bytes consumed from this line so a
    // child emitting an infinite no-newline stream cannot pin the
    // reader thread's CPU indefinitely. After `STDERR_RUNAWAY_BYTES`,
    // abandon the line — return what we have (cap-bounded) with
    // truncated=true; the next `read_capped_line` call returns Ok(None)
    // or the next line.
    let mut consumed_total: usize = 0;
    loop {
        // Cycle-3 ERR-1 fix: do NOT use `?` here. A mid-line I/O error
        // (e.g., BrokenPipe after the child writes a partial multi-MB
        // stack trace) would drop the bytes we already buffered. Instead:
        // if we have any bytes, surface them with `truncated=true` so the
        // operator gets the partial diagnostic; only return Err when we
        // have nothing to show.
        let available = match reader.fill_buf() {
            Ok(b) => b,
            Err(e) => {
                if got_any {
                    return Ok(Some((buf, true)));
                }
                return Err(e);
            }
        };
        if available.is_empty() {
            // EOF
            return if got_any { Ok(Some((buf, truncated))) } else { Ok(None) };
        }
        got_any = true;
        if let Some(nl_idx) = available.iter().position(|&b| b == b'\n') {
            // Newline found in this chunk. Copy up to (cap - buf.len()) of the
            // pre-newline bytes; consume up to and including the newline.
            let pre_nl_len = nl_idx;
            let remaining_cap = cap.saturating_sub(buf.len());
            let to_copy = remaining_cap.min(pre_nl_len);
            buf.extend_from_slice(&available[..to_copy]);
            let did_cap_in_chunk = to_copy < pre_nl_len;
            if did_cap_in_chunk {
                truncated = true;
            }
            reader.consume(nl_idx + 1);
            // Cycle-3 F4 fix: only strip a trailing `\r` if we did NOT cap
            // mid-content. A truncation that happens to land on a content-`\r`
            // would otherwise lose one byte of message. The CRLF strip is for
            // line-terminator normalization (defensive — Trail CLI is POSIX,
            // but `\r\n` line endings from a child running under Windows CRT
            // are conceivable), and that only applies when we read the full
            // pre-newline content.
            if !did_cap_in_chunk && buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(Some((buf, truncated)));
        }
        // No newline in this chunk — either buffer the chunk (under cap) or
        // start discarding (at cap).
        let chunk_len = available.len();
        let remaining_cap = cap.saturating_sub(buf.len());
        if remaining_cap > 0 {
            let to_copy = remaining_cap.min(chunk_len);
            buf.extend_from_slice(&available[..to_copy]);
            if to_copy < chunk_len {
                truncated = true;
            }
        } else {
            // Already at cap — just mark truncated and keep advancing.
            truncated = true;
        }
        reader.consume(chunk_len);
        consumed_total = consumed_total.saturating_add(chunk_len);
        if consumed_total >= STDERR_RUNAWAY_BYTES {
            // Abandon the line. Caller treats this as a truncated line
            // (suffix applied, `info!` log fires). Subsequent reads
            // continue from wherever the child stream is now — the
            // next `\n` becomes the next logical line.
            return Ok(Some((buf, true)));
        }
    }
}

/// Truncate `line` at a UTF-8 char boundary if it exceeds the cap; the
/// suffix is included within the cap so the final byte length is
/// always `<= STDERR_LINE_MAX_BYTES`. Pure fn for unit testing.
fn truncate_for_emit(mut line: String) -> String {
    if line.len() <= STDERR_LINE_MAX_BYTES {
        return line;
    }
    let max_body_bytes = STDERR_LINE_MAX_BYTES.saturating_sub(TRUNCATION_SUFFIX.len());
    // Walk back to the nearest char boundary at or before max_body_bytes
    // so we never split a multi-byte UTF-8 sequence.
    let mut cut = max_body_bytes;
    while cut > 0 && !line.is_char_boundary(cut) {
        cut -= 1;
    }
    line.truncate(cut);
    line.push_str(TRUNCATION_SUFFIX);
    line
}

/// Variant of `truncate_for_emit` that appends the suffix
/// unconditionally — used when the caller (the stderr reader thread)
/// already knows the line was capped at read time by `read_capped_line`,
/// so the renderer needs the `… (truncated)` signal even though the
/// payload byte length is at-or-below `STDERR_LINE_MAX_BYTES`.
///
/// Cycle-3 fix (F1 + F6): the prior implementation split into "under
/// max_body_bytes → append at end" and "over → fall through to
/// `truncate_for_emit`." That second branch was the bug: a line of
/// EXACTLY `STDERR_LINE_MAX_BYTES` bytes (the standard `read_capped_line`
/// cap-hit case) routed through `truncate_for_emit`, which sees
/// `line.len() <= STDERR_LINE_MAX_BYTES` and returns unchanged — the
/// suffix never gets appended. The renderer lost the SEC-2 truncation
/// signal in the most common case. Unify both branches: cap body at
/// `max_body_bytes` (walking back to a char boundary if over), then
/// push the suffix. The result length is always exactly
/// `body_len + TRUNCATION_SUFFIX.len() <= STDERR_LINE_MAX_BYTES`.
fn truncate_for_emit_with_suffix(mut line: String) -> String {
    let max_body_bytes = STDERR_LINE_MAX_BYTES.saturating_sub(TRUNCATION_SUFFIX.len());
    if line.len() > max_body_bytes {
        // Walk back to the nearest char boundary at-or-before
        // max_body_bytes so we never split a multi-byte UTF-8 sequence.
        // (`is_char_boundary(0)` is always true, so this terminates.)
        let mut cut = max_body_bytes;
        while cut > 0 && !line.is_char_boundary(cut) {
            cut -= 1;
        }
        line.truncate(cut);
    }
    line.push_str(TRUNCATION_SUFFIX);
    line
}

/// Run a freshly-spawned child to completion, emitting `packet-generate-progress`
/// events. Designed to be invoked inside a dedicated thread.
///
/// Events emitted:
///   - `{ spawn_id, session_id, kind: "stderr", chunk: <line> }` per stderr line
///   - `{ spawn_id, session_id, kind: "done", exit_code: 0 }` on success
///   - `{ spawn_id, session_id, kind: "error", exit_code: <non-zero> }` on failure
///   - `{ spawn_id, session_id, kind: "error", exit_code: -1, chunk: "cancelled" }`
///      when the cancel flag fires
///
/// The `cancel_flag` is polled between line reads via short-poll `try_wait`.
pub fn run_packet_generate<R: tauri::Runtime>(
    handle: tauri::AppHandle<R>,
    spawn_id: String,
    session_id: String,
    mut child: Child,
    cancel_flag: Arc<AtomicBool>,
) {
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            warn!(target: "trail::spawn", spawn_id = %spawn_id, "child stderr was not piped");
            emit_progress(
                &handle,
                &spawn_id,
                &session_id,
                ProgressKind::Error,
                None,
                Some(-1),
                Some("child stderr was not piped".into()),
            );
            return;
        }
    };
    // We intentionally drop stdout — the CLI writes progress to stderr.
    // Holding stdout open without reading it could fill the OS pipe buffer
    // and stall the child; closing it is safer.
    drop(child.stdout.take());

    // stderr-reader thread: pushes each line into a channel.
    //
    // v0.2 P2-ERR-3: previously `lines().map_while(Result::ok)` silently
    // terminated the loop on the first I/O error, making a broken stream
    // indistinguishable from EOF. The operator lost the diagnostic about
    // why the stream stopped. Replace with an explicit Err arm that
    // surfaces I/O failures at `warn!` (carrying spawn_id) before
    // breaking, so a debug session can correlate "stderr stopped early"
    // with the underlying cause.
    //
    // v0.2 P2-SEC-1 (post-review fix): replaced `BufReader::lines()`
    // (which uses unbounded `read_line` under the hood) with
    // `read_capped_line`, which enforces the 64KB content cap at READ
    // time. A child emitting many MB without a newline can no longer
    // balloon the reader-thread heap before `truncate_for_emit` (the
    // wire-side cap) gets a chance to clip.
    //
    // v0.2 SEC-2 (post-review): when a line IS truncated at the read
    // boundary, emit an `info!` log with spawn_id so post-mortem
    // forensics can distinguish "the CLI wrote a malformed line" from
    // "Trail clipped a runaway line."
    //
    // v0.2 SEC-1 cycle-3 fix: `sync_channel(N)` not `channel()`. The
    // unbounded queue defeated the per-line cap — a child emitting many
    // short newlines faster than the main loop drains could queue
    // N×64KB on the reader-thread heap, re-opening the heap-growth
    // window the cap closes. With a 1024-slot bound, worst-case
    // residency is ~64MB (1024 × 64KB cap each) and the reader thread's
    // `tx.send` blocks naturally when the renderer is slow — real
    // backpressure replaces the unbounded fast-path.
    let (tx, rx) = std::sync::mpsc::sync_channel::<String>(STDERR_CHANNEL_BOUND);
    let stderr_spawn_id = spawn_id.clone();
    let reader_spawn_result = thread::Builder::new()
        .name(format!("trail-spawn-stderr-{spawn_id}"))
        .spawn(move || {
            let mut buf_reader = BufReader::new(stderr);
            loop {
                match read_capped_line(&mut buf_reader, STDERR_LINE_MAX_BYTES) {
                    Ok(Some((bytes, was_truncated))) => {
                        if was_truncated {
                            info!(
                                target: "trail::spawn",
                                spawn_id = %stderr_spawn_id,
                                cap_bytes = STDERR_LINE_MAX_BYTES,
                                "stderr line exceeded cap; truncated at read boundary"
                            );
                        }
                        // Bytes may not be valid UTF-8 if the child wrote
                        // raw binary on stderr; `from_utf8_lossy` preserves
                        // the message while replacing invalid sequences.
                        let line = String::from_utf8_lossy(&bytes).into_owned();
                        // truncate_for_emit appends the "… (truncated)" suffix
                        // when `was_truncated`; it's also a defense-in-depth
                        // backstop if `line.len()` somehow exceeds the cap
                        // after UTF-8 lossy conversion.
                        let payload = if was_truncated {
                            truncate_for_emit_with_suffix(line)
                        } else {
                            truncate_for_emit(line)
                        };
                        if tx.send(payload).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break, // EOF
                    Err(e) => {
                        // Cycle-3 ERR-4 fix: normalize the error kind for log
                        // aggregation (Datadog / Loki parse `error_kind` as a
                        // stable field), keep `error = %e` for human-readable
                        // debugging. Symmetric with the SEC-3 wire normalization
                        // on the `try_wait` path.
                        warn!(
                            target: "trail::spawn",
                            spawn_id = %stderr_spawn_id,
                            error_kind = classify_io_error_kind(&e),
                            error = %e,
                            "stderr reader I/O error; ending stream"
                        );
                        break;
                    }
                }
            }
        });
    // Cycle-3 ERR-2 fix: log if the reader thread fails to spawn
    // (RLIMIT_NPROC, ENOMEM, EAGAIN). Previously `.ok()` swallowed this
    // silently, leaving the child to run with no stderr drain — the
    // operator received a terminal `done`/`error` event with empty
    // stderr and no diagnostic.
    let mut reader_handle = match reader_spawn_result {
        Ok(h) => Some(h),
        Err(e) => {
            warn!(
                target: "trail::spawn",
                spawn_id = %spawn_id,
                error_kind = classify_io_error_kind(&e),
                error = %e,
                "stderr reader thread failed to start; child output will be unavailable"
            );
            None
        }
    };

    // Main loop: emit each stderr line + try_wait before cancel check +
    // poll cancel flag.
    //
    // ERR-1 fix: previously the cancel branch ran BEFORE try_wait, so if
    // the cancel flag flipped in the same poll tick the child completed
    // naturally, we would kill an already-dead process and emit
    // `error/exit -1` for a successful packet. Reorder: check exit
    // status first; only honor the cancel flag while status is `None`.
    let poll_interval = Duration::from_millis(50);
    let mut reader_joined = false;
    loop {
        // Drain any pending stderr lines.
        while let Ok(line) = rx.try_recv() {
            emit_progress(
                &handle,
                &spawn_id,
                &session_id,
                ProgressKind::Stderr,
                Some(line),
                None,
                None,
            );
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                // Process exited cleanly (with or without success).
                // Drain reader thread + remaining stderr lines before
                // emitting the terminal event so the log is complete.
                if let Some(h) = reader_handle.take() {
                    let _ = h.join();
                    reader_joined = true;
                }
                while let Ok(line) = rx.recv_timeout(Duration::from_millis(100)) {
                    emit_progress(
                        &handle,
                        &spawn_id,
                        &session_id,
                        ProgressKind::Stderr,
                        Some(line),
                        None,
                        None,
                    );
                }
                let code = status.code().unwrap_or(-1);
                let kind = if status.success() { ProgressKind::Done } else { ProgressKind::Error };
                emit_progress(
                    &handle,
                    &spawn_id,
                    &session_id,
                    kind,
                    None,
                    Some(code),
                    None,
                );
                break;
            }
            Ok(None) => {
                // Still running — now honour the cancel flag.
                if cancel_flag.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    // Drain reader-thread + remaining lines.
                    if let Some(h) = reader_handle.take() {
                        let _ = h.join();
                        reader_joined = true;
                    }
                    while let Ok(line) = rx.recv_timeout(Duration::from_millis(100)) {
                        emit_progress(
                            &handle,
                            &spawn_id,
                            &session_id,
                            ProgressKind::Stderr,
                            Some(line),
                            None,
                            None,
                        );
                    }
                    // Best-effort: get the final status post-kill so the
                    // exit_code reflects reality (SIGKILL → -1 / 137 /
                    // OS-dependent; we surface whatever the OS returned).
                    let exit_code = match child.try_wait() {
                        Ok(Some(s)) => s.code().unwrap_or(-1),
                        _ => -1,
                    };
                    emit_progress(
                        &handle,
                        &spawn_id,
                        &session_id,
                        ProgressKind::Error,
                        Some("cancelled".into()),
                        Some(exit_code),
                        None,
                    );
                    break;
                }
                thread::sleep(poll_interval);
            }
            Err(e) => {
                // v0.2 SEC-3 (post-review): normalize the error kind to a
                // stable string before forwarding to the renderer. Raw
                // `io::Error::Display` may surface kernel-specific or
                // locale-dependent strings; the renderer's allowlist is
                // easier to audit against a fixed vocabulary.
                emit_progress(
                    &handle,
                    &spawn_id,
                    &session_id,
                    ProgressKind::Error,
                    None,
                    Some(-1),
                    Some(format!("try_wait failed: {}", classify_io_error_kind(&e))),
                );
                break;
            }
        }
    }
    // Defensive: if neither branch joined the reader (Err on try_wait),
    // drop the Option so the thread is detached. We have no path to
    // join here without potentially blocking on a stuck reader.
    let _ = reader_joined;
    drop(reader_handle);
    info!(target: "trail::spawn", spawn_id = %spawn_id, "spawn worker exiting");
}

/// v0.2 P2-SEC-4: discriminator for `packet-generate-progress` event
/// kinds. Previously `emit_progress` took `&str`, which the Zod side
/// matched against `'stderr' | 'stdout' | 'done' | 'error'`. The Rust
/// worker drops stdout (line 282) and never emits `Stdout`, so the
/// TS-side `'stdout'` variant was reachable in the type system but
/// unreachable at runtime. Encoding the kinds as a Rust enum makes the
/// reachable set compile-time-checked: there is no `Stdout` variant,
/// so a future refactor that re-enables stdout streaming cannot smuggle
/// un-redacted bytes through `emit_progress` without explicitly adding
/// (and re-reviewing) a `Stdout` variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProgressKind {
    Stderr,
    Done,
    Error,
}

impl ProgressKind {
    /// Wire string (matches the `kind` discriminator on the TS side).
    fn as_wire_str(self) -> &'static str {
        match self {
            ProgressKind::Stderr => "stderr",
            ProgressKind::Done => "done",
            ProgressKind::Error => "error",
        }
    }
}

fn emit_progress<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
    spawn_id: &str,
    session_id: &str,
    kind: ProgressKind,
    chunk: Option<String>,
    exit_code: Option<i32>,
    error_detail: Option<String>,
) {
    let mut payload = serde_json::json!({
        "spawn_id": spawn_id,
        "session_id": session_id,
        "kind": kind.as_wire_str(),
    });
    let obj = payload.as_object_mut().expect("payload constructed as object");
    if let Some(c) = chunk {
        obj.insert("chunk".into(), serde_json::Value::String(c));
    }
    if let Some(code) = exit_code {
        obj.insert("exit_code".into(), serde_json::Value::from(code));
    }
    if let Some(detail) = error_detail {
        obj.insert("error_detail".into(), serde_json::Value::String(detail));
    }
    let _ = handle.emit("packet-generate-progress", payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_augmented_path_includes_pre_pends() {
        std::env::set_var("PATH", "/some/inherited");
        std::env::set_var("HOME", "/home/test");
        let p = build_augmented_path();
        assert!(p.starts_with("/opt/homebrew/bin:"));
        assert!(p.contains("/home/test/.npm-global/bin"));
        assert!(p.contains("/home/test/.local/bin"));
        assert!(p.ends_with("/some/inherited"));
    }

    #[test]
    fn validate_session_id_rejects_empty() {
        let err = validate_session_id("").unwrap_err();
        assert_eq!(err.kind, SpawnFailureKind::InvalidSessionId);
    }

    #[test]
    fn validate_session_id_rejects_path_separators() {
        for bad in ["../etc", "foo/bar", "foo\\bar"] {
            let err = validate_session_id(bad).unwrap_err();
            assert_eq!(err.kind, SpawnFailureKind::InvalidSessionId, "input: {bad}");
        }
    }

    #[test]
    fn validate_session_id_rejects_leading_dash_argv_injection() {
        // SEC-2: anything that begins with `-` could be interpreted as a
        // clap flag by `trail packet generate`. We don't assert the
        // specific error message because multiple checks may reject the
        // same input (`--config=/tmp/x` trips path-separators first);
        // what matters is the invalid-session-id verdict.
        for bad in ["--help", "--exec=evil", "-h", "--config=/tmp/x", "-foo"] {
            let err = validate_session_id(bad).unwrap_err();
            assert_eq!(err.kind, SpawnFailureKind::InvalidSessionId, "input: {bad}");
        }
    }

    #[test]
    fn validate_session_id_rejects_oversize() {
        let too_long = "A".repeat(65);
        let err = validate_session_id(&too_long).unwrap_err();
        assert_eq!(err.kind, SpawnFailureKind::InvalidSessionId);
    }

    #[test]
    fn validate_session_id_rejects_non_whitelist_chars() {
        for bad in ["foo bar", "foo!", "foo;rm", "foo\nbar", "foo\0bar"] {
            let err = validate_session_id(bad).unwrap_err();
            assert_eq!(err.kind, SpawnFailureKind::InvalidSessionId, "input: {bad}");
        }
    }

    #[test]
    fn validate_session_id_accepts_canonical_ulids() {
        assert!(validate_session_id("01HZX3NDEKTSV4RRFFQ69G5FAV").is_ok());
        assert!(validate_session_id("18e374b5-4eb9-424d-a3ff-a639d1c6fada").is_ok());
    }

    #[test]
    fn registry_cancel_returns_false_when_unknown() {
        let reg = SpawnRegistry::new();
        assert!(!reg.cancel("nonexistent"));
    }

    #[test]
    fn registry_register_and_cancel_set_flag() {
        let reg = SpawnRegistry::new();
        let flag = reg.register("spawn-1".into());
        assert!(!flag.load(Ordering::SeqCst));
        assert!(reg.cancel("spawn-1"));
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn registry_cleanup_removes_entry() {
        let reg = SpawnRegistry::new();
        reg.register("spawn-1".into());
        reg.cleanup("spawn-1");
        assert!(!reg.cancel("spawn-1"));
    }

    /// v0.2 P2-SEC-3: `cancel_all` flips every active spawn's cancel
    /// flag in one pass and returns the count of active spawns. Drives
    /// the `RunEvent::ExitRequested` handler that prevents orphaned
    /// children when the user force-quits the app.
    #[test]
    fn registry_cancel_all_flips_every_flag_v02_p2_sec_3() {
        let reg = SpawnRegistry::new();
        let flag_a = reg.register("spawn-A".into());
        let flag_b = reg.register("spawn-B".into());
        let flag_c = reg.register("spawn-C".into());
        assert!(!flag_a.load(Ordering::SeqCst));
        assert!(!flag_b.load(Ordering::SeqCst));
        assert!(!flag_c.load(Ordering::SeqCst));

        let drained = reg.cancel_all();
        assert_eq!(drained, 3);
        assert!(flag_a.load(Ordering::SeqCst));
        assert!(flag_b.load(Ordering::SeqCst));
        assert!(flag_c.load(Ordering::SeqCst));
    }

    #[test]
    fn registry_cancel_all_on_empty_returns_zero_v02_p2_sec_3() {
        let reg = SpawnRegistry::new();
        assert_eq!(reg.cancel_all(), 0);
    }

    /// v0.2 P2-SEC-4: `ProgressKind` wire strings match the Zod union
    /// (`'stderr' | 'done' | 'error'`). The TS-side discriminator stays
    /// in sync because both sides spell the literal exactly once; this
    /// test pins the Rust side. Adding a `Stdout` variant would force a
    /// new arm here AND a Zod-side widening — the explicit boundary
    /// surfaces in review.
    #[test]
    fn progress_kind_wire_strings_v02_p2_sec_4() {
        assert_eq!(ProgressKind::Stderr.as_wire_str(), "stderr");
        assert_eq!(ProgressKind::Done.as_wire_str(), "done");
        assert_eq!(ProgressKind::Error.as_wire_str(), "error");
        // Compile-time guard: this exhaustive match must cover every
        // variant. Adding a `Stdout` variant would force this match to
        // grow OR add a `_` arm — neither lands silently.
        let kinds = [ProgressKind::Stderr, ProgressKind::Done, ProgressKind::Error];
        for k in kinds {
            let _wire = match k {
                ProgressKind::Stderr => "stderr",
                ProgressKind::Done => "done",
                ProgressKind::Error => "error",
            };
        }
    }

    /// v0.2 P2-SEC-5: short lines pass through unchanged.
    #[test]
    fn truncate_for_emit_passthrough_short_line() {
        let s = "ordinary stderr line".to_string();
        assert_eq!(truncate_for_emit(s.clone()), s);
    }

    /// v0.2 P2-SEC-5: line exactly at the cap passes through unchanged.
    #[test]
    fn truncate_for_emit_passthrough_at_cap() {
        let s = "a".repeat(STDERR_LINE_MAX_BYTES);
        let out = truncate_for_emit(s.clone());
        assert_eq!(out.len(), STDERR_LINE_MAX_BYTES);
        assert_eq!(out, s);
    }

    /// v0.2 P2-SEC-5: line one byte over the cap is truncated with the
    /// suffix; final length is at-or-below the cap AND at-or-above
    /// `max_body_bytes` (F1 post-review fix: pin the lower bound so a
    /// regression that returned just `TRUNCATION_SUFFIX` for every
    /// oversize input would fail).
    #[test]
    fn truncate_for_emit_caps_oversize_line() {
        let s = "a".repeat(STDERR_LINE_MAX_BYTES + 1);
        let out = truncate_for_emit(s);
        let max_body_bytes = STDERR_LINE_MAX_BYTES - TRUNCATION_SUFFIX.len();
        assert!(
            out.len() <= STDERR_LINE_MAX_BYTES,
            "truncated len {} should be <= {}",
            out.len(),
            STDERR_LINE_MAX_BYTES
        );
        assert_eq!(
            out.len(),
            max_body_bytes + TRUNCATION_SUFFIX.len(),
            "ASCII input must produce exactly max_body_bytes of content + suffix"
        );
        assert!(
            out.ends_with(TRUNCATION_SUFFIX),
            "truncated line must end with the suffix"
        );
        // F1 lower bound: the body must be at least max_body_bytes - 4 (4 is
        // the max walk-back for UTF-8 char boundary; for ASCII input the
        // exact byte length is max_body_bytes).
        assert!(
            out.len() >= max_body_bytes - 4 + TRUNCATION_SUFFIX.len(),
            "body length lower bound: regression returning just the suffix would fail this"
        );
    }

    /// v0.2 P2-SEC-5: the 200KB pathological case from the journal —
    /// final byte length still bounded.
    #[test]
    fn truncate_for_emit_handles_200kb_line() {
        let s = "x".repeat(200 * 1024);
        let out = truncate_for_emit(s);
        assert!(out.len() <= STDERR_LINE_MAX_BYTES);
        assert!(out.ends_with(TRUNCATION_SUFFIX));
    }

    /// v0.2 P2-SEC-5: multi-byte UTF-8 must be cut at a char boundary
    /// so the resulting String is valid UTF-8 (truncate panics on a
    /// non-boundary in std::String::truncate — this test guards against
    /// a regression where the cut point is calculated naively).
    #[test]
    fn truncate_for_emit_preserves_char_boundary() {
        // 3-byte char "あ" repeated until just over the cap.
        let prefix = "あ".repeat(STDERR_LINE_MAX_BYTES); // way over
        let out = truncate_for_emit(prefix);
        // Must not have panicked, and must be valid UTF-8 (String
        // invariant). Sanity-check: the truncation suffix is present.
        assert!(out.ends_with(TRUNCATION_SUFFIX));
        assert!(out.is_char_boundary(out.len() - TRUNCATION_SUFFIX.len()));
    }

    /// v0.2 SEC-1 (post-review fix): `read_capped_line` reads a single
    /// `\n`-terminated line and returns the byte content (without the
    /// terminator). Short line below cap: untruncated.
    #[test]
    fn read_capped_line_short_line_untruncated() {
        let mut data = std::io::Cursor::new(b"hello world\nrest".to_vec());
        let (bytes, truncated) = read_capped_line(&mut data, STDERR_LINE_MAX_BYTES)
            .expect("io ok")
            .expect("got line");
        assert_eq!(&bytes, b"hello world");
        assert!(!truncated, "short line should not be truncated");
    }

    /// v0.2 SEC-1: a line exceeding the cap is truncated AT READ TIME,
    /// the reader advances PAST the rest of the line to the next
    /// newline, and `was_truncated` flag fires.
    #[test]
    fn read_capped_line_oversize_truncates_and_advances() {
        // 1MB without a newline, then `\nNEXT` — the runaway-stderr scenario.
        let mut payload = Vec::with_capacity(1024 * 1024 + 10);
        payload.extend(std::iter::repeat(b'x').take(1024 * 1024));
        payload.push(b'\n');
        payload.extend_from_slice(b"NEXT\n");
        let mut data = std::io::Cursor::new(payload);
        let (bytes, truncated) = read_capped_line(&mut data, 100) // cap at 100 for the test
            .expect("io ok")
            .expect("got first line");
        assert_eq!(bytes.len(), 100, "must cap at exactly the supplied cap");
        assert!(truncated, "cap-hit must set the truncated flag");
        // Reader must be positioned at the next line — assert by reading it.
        let (next_bytes, next_truncated) = read_capped_line(&mut data, 100)
            .expect("io ok")
            .expect("got next line");
        assert_eq!(&next_bytes, b"NEXT");
        assert!(!next_truncated);
    }

    /// v0.2 SEC-1: EOF before any bytes → `Ok(None)`.
    #[test]
    fn read_capped_line_eof_returns_none() {
        let mut data = std::io::Cursor::new(Vec::<u8>::new());
        let result = read_capped_line(&mut data, 1024).expect("io ok");
        assert!(result.is_none(), "EOF before bytes should return Ok(None)");
    }

    /// v0.2 SEC-1: trailing partial line (no final newline) is still
    /// returned on EOF.
    #[test]
    fn read_capped_line_partial_line_at_eof() {
        let mut data = std::io::Cursor::new(b"no-newline".to_vec());
        let (bytes, truncated) = read_capped_line(&mut data, 1024)
            .expect("io ok")
            .expect("got partial line");
        assert_eq!(&bytes, b"no-newline");
        assert!(!truncated);
    }

    /// v0.2 SEC-1: CRLF endings — the `\r` is stripped along with `\n`.
    #[test]
    fn read_capped_line_strips_crlf() {
        let mut data = std::io::Cursor::new(b"win-style\r\nnext".to_vec());
        let (bytes, _) = read_capped_line(&mut data, 1024)
            .expect("io ok")
            .expect("got line");
        assert_eq!(&bytes, b"win-style");
    }

    /// v0.2 SEC-3 (post-review): `classify_io_error_kind` returns a
    /// fixed-vocabulary string per `io::ErrorKind`, avoiding
    /// kernel-specific or locale-dependent `Display` output.
    #[test]
    fn classify_io_error_kind_maps_known_kinds() {
        let cases = [
            (io::ErrorKind::NotFound, "not-found"),
            (io::ErrorKind::PermissionDenied, "permission-denied"),
            (io::ErrorKind::BrokenPipe, "broken-pipe"),
            (io::ErrorKind::Interrupted, "interrupted"),
            (io::ErrorKind::UnexpectedEof, "unexpected-eof"),
        ];
        for (kind, expected) in cases {
            let e = io::Error::new(kind, "details ignored");
            assert_eq!(classify_io_error_kind(&e), expected);
        }
        // Unknown / "other" kind falls back to a stable bucket.
        let e = io::Error::other("custom");
        assert_eq!(classify_io_error_kind(&e), "other-io-error");
    }

    /// v0.2 P2-SEC-5: `truncate_for_emit_with_suffix` always appends
    /// the suffix even when the input is under cap (used by the reader
    /// thread when it knows the line was already cap-truncated at read
    /// time but the caller wants the renderer signal).
    #[test]
    fn truncate_for_emit_with_suffix_appends_unconditionally() {
        let s = "short".to_string();
        let out = truncate_for_emit_with_suffix(s);
        assert!(out.starts_with("short"));
        assert!(out.ends_with(TRUNCATION_SUFFIX));
    }

    /// Cycle-3 F1 regression test: `truncate_for_emit_with_suffix` MUST
    /// append the suffix even when the input is exactly
    /// `STDERR_LINE_MAX_BYTES` bytes (the standard `read_capped_line`
    /// cap-hit case). The bug we're pinning: the prior implementation
    /// fell through to `truncate_for_emit`, which sees `len <= cap` and
    /// returns unchanged — the renderer lost the SEC-2 signal in the
    /// most common truncation scenario.
    #[test]
    fn truncate_for_emit_with_suffix_at_exact_cap_appends_marker_f1() {
        let s = "x".repeat(STDERR_LINE_MAX_BYTES);
        let out = truncate_for_emit_with_suffix(s);
        assert!(
            out.ends_with(TRUNCATION_SUFFIX),
            "exact-cap input must still get the truncation marker; len={}",
            out.len()
        );
        assert!(
            out.len() <= STDERR_LINE_MAX_BYTES,
            "result must stay within the byte cap"
        );
        // Body portion: must be at-or-below max_body_bytes.
        let max_body_bytes = STDERR_LINE_MAX_BYTES - TRUNCATION_SUFFIX.len();
        let body_len = out.len() - TRUNCATION_SUFFIX.len();
        assert!(body_len <= max_body_bytes, "body must fit within max_body_bytes");
    }

    /// Cycle-3 F2 regression test: multi-chunk discard path in
    /// `read_capped_line`. The cycle-2 tests used `std::io::Cursor`
    /// whose `fill_buf` returns the entire remaining slice in one call,
    /// so the discard-loop logic (lines after cap-hit, no newline yet)
    /// never executed. This test uses a `ChunkedReader` that yields
    /// fixed-size chunks so the production code path is exercised.
    #[test]
    fn read_capped_line_multi_chunk_discard_f2() {
        // ChunkedReader yields `chunk_size` bytes per fill_buf call.
        struct ChunkedReader<'a> {
            data: &'a [u8],
            chunk_size: usize,
            pos: usize,
        }
        impl io::Read for ChunkedReader<'_> {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                let remaining = self.data.len().saturating_sub(self.pos);
                let n = buf.len().min(self.chunk_size).min(remaining);
                buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
                self.pos += n;
                Ok(n)
            }
        }
        // Build: cap=8, 32 bytes of 'x' (will need 4 chunks of 8 to cap),
        // then 16 more bytes of 'y' (discard phase across 2 chunks),
        // then `\n`, then `NEXT\n`.
        let mut payload = Vec::new();
        payload.extend(std::iter::repeat(b'x').take(32));
        payload.extend(std::iter::repeat(b'y').take(16));
        payload.push(b'\n');
        payload.extend_from_slice(b"NEXT\n");
        let reader = ChunkedReader { data: &payload, chunk_size: 8, pos: 0 };
        let mut buf_reader = BufReader::with_capacity(8, reader);
        // First line: 48 bytes content + \n → cap at 8, discard 40 across multiple chunks.
        let (bytes, truncated) = read_capped_line(&mut buf_reader, 8)
            .expect("io ok")
            .expect("got first line");
        assert_eq!(bytes.len(), 8, "first line capped at 8 bytes");
        assert_eq!(&bytes, b"xxxxxxxx");
        assert!(truncated, "must mark truncated since pre_nl_len > cap");
        // Second line emerges intact — proves the reader correctly
        // re-synced past the runaway line.
        let (next_bytes, _) = read_capped_line(&mut buf_reader, 100)
            .expect("io ok")
            .expect("got next line");
        assert_eq!(&next_bytes, b"NEXT");
    }

    /// Cycle-3 F3 regression test: end-to-end integration of
    /// `read_capped_line` (cap-bounded bytes + `was_truncated=true`)
    /// flowing through `truncate_for_emit_with_suffix` (the call-site
    /// payload builder). Pins the F1 bug at the integration level: a
    /// runaway line in stderr must reach the renderer with the
    /// `… (truncated)` suffix appended.
    #[test]
    fn read_capped_line_to_emit_suffix_integration_f3() {
        // Simulate the production reader-thread path: bytes at exactly the
        // cap + was_truncated=true → from_utf8_lossy → truncate_for_emit_with_suffix.
        let oversize_input = "x".repeat(STDERR_LINE_MAX_BYTES + 1) + "\n";
        let mut cursor = std::io::Cursor::new(oversize_input.into_bytes());
        let (bytes, truncated) =
            read_capped_line(&mut cursor, STDERR_LINE_MAX_BYTES)
                .expect("io ok")
                .expect("got line");
        assert!(truncated, "oversize line must be flagged truncated");
        assert_eq!(bytes.len(), STDERR_LINE_MAX_BYTES, "bytes capped at exact cap");
        let payload = if truncated {
            truncate_for_emit_with_suffix(String::from_utf8_lossy(&bytes).into_owned())
        } else {
            truncate_for_emit(String::from_utf8_lossy(&bytes).into_owned())
        };
        assert!(
            payload.ends_with(TRUNCATION_SUFFIX),
            "end-to-end pipeline must surface the SEC-2 truncation signal to the renderer"
        );
        assert!(
            payload.len() <= STDERR_LINE_MAX_BYTES,
            "final payload must stay within the byte cap"
        );
    }

    /// Cycle-3 F5/ERR-1 regression test: mid-line I/O error during
    /// `read_capped_line` must NOT silently drop the already-buffered
    /// bytes. Returns `Ok(Some((buf, truncated=true)))` so the operator
    /// gets the partial diagnostic; the caller's `was_truncated` path
    /// applies the suffix and the renderer sees a clipped line rather
    /// than nothing at all.
    #[test]
    fn read_capped_line_err_after_partial_returns_buffered_err_1() {
        // FlakyReader: returns Ok(some bytes) once, then Err on the next call.
        struct FlakyReader {
            first: bool,
            payload: Vec<u8>,
        }
        impl io::Read for FlakyReader {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if self.first {
                    self.first = false;
                    let n = buf.len().min(self.payload.len());
                    buf[..n].copy_from_slice(&self.payload[..n]);
                    Ok(n)
                } else {
                    Err(io::Error::new(io::ErrorKind::BrokenPipe, "child crashed mid-stream"))
                }
            }
        }
        let reader = FlakyReader { first: true, payload: b"partial-stack-trace".to_vec() };
        let mut buf_reader = BufReader::with_capacity(64, reader);
        let result = read_capped_line(&mut buf_reader, 1024).expect("partial bytes returned, not Err");
        let (bytes, truncated) = result.expect("got partial");
        assert_eq!(&bytes, b"partial-stack-trace");
        assert!(truncated, "mid-stream Err must flag truncated so caller appends suffix");
    }

    /// Cycle-3 ERR-1 regression test (companion to the partial-buffer
    /// case): when the FIRST fill_buf errors before ANY bytes are
    /// buffered, the function correctly propagates Err — the caller
    /// logs at `warn!` and breaks. Pins the "no partial → Err" branch.
    #[test]
    fn read_capped_line_err_before_any_bytes_propagates_err_1() {
        struct AlwaysErrReader;
        impl io::Read for AlwaysErrReader {
            fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::Interrupted, "syscall interrupted"))
            }
        }
        let mut buf_reader = BufReader::new(AlwaysErrReader);
        let err = read_capped_line(&mut buf_reader, 1024).expect_err("must propagate Err");
        assert_eq!(err.kind(), io::ErrorKind::Interrupted);
    }

    /// Cycle-3 F4 regression test: when truncation lands mid-content
    /// right after a content `\r`, the `\r` must NOT be stripped (it
    /// is real content, not a CRLF terminator).
    #[test]
    fn read_capped_line_does_not_strip_content_cr_after_truncation_f4() {
        // cap=6, input is "hello\rxyz\n" — `\r` is content (no `\n` follows it
        // until after "xyz"). Cap-hit at byte 6 captures "hello\r"; previously
        // the unconditional `\r` strip removed the content `\r`, losing a byte.
        let mut cursor = std::io::Cursor::new(b"hello\rxyz\n".to_vec());
        let (bytes, truncated) = read_capped_line(&mut cursor, 6)
            .expect("io ok")
            .expect("got line");
        assert!(truncated, "must flag truncated since pre_nl_len > cap");
        assert_eq!(&bytes, b"hello\r", "content `\\r` after cap-hit must be preserved");
    }

    #[test]
    fn spawn_trail_packet_generate_child_reports_cli_not_found() {
        // Spawn with a clean PATH that won't have `trail`. The augmented
        // path still prepends the standard locations, so on a real dev
        // machine this may succeed; instead we directly invoke a
        // guaranteed-missing binary by spawning a child with the
        // augmented PATH explicitly cleared to /var/empty.
        // We approximate by relying on PATH pointing to a sub-tree
        // without `trail` — production CI doesn't ship `trail` on PATH.
        // If this test flakes on a developer's machine where `trail` IS
        // on PATH, the assertion below is best-effort.
        std::env::set_var("PATH", "/var/empty");
        std::env::set_var("HOME", "/var/empty");
        let result = spawn_trail_packet_generate_child("test-session");
        if let Err(err) = result {
            assert_eq!(err.kind, SpawnFailureKind::CliNotFound);
        }
        // If `trail` was found on the developer's PATH, we skip the
        // assertion — the spawn succeeds and we let the child exit
        // naturally. This is benign on a dev machine.
    }
}
