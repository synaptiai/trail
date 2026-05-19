//! Claude Code session enumeration (gh#18 AC#3).
//!
//! Walks `~/.claude/projects/<sanitized-cwd>/...` and surfaces each session
//! to the React layer with metadata: started_at, message_count, and a
//! cross-referenced packet_id when the session has been captured into
//! `.trail/sessions/<session_id>/packet-*.yml`.
//!
//! Two on-disk layouts both supported:
//!   Older: `~/.claude/projects/<sanitized>/<uuid>.jsonl`
//!   Newer: `~/.claude/projects/<sanitized>/<uuid>/<uuid>.jsonl` (nested)
//!
//! The enumeration walks both shapes. Session ID is the .jsonl filename
//! without the extension. `started_at` is parsed from the first JSON record
//! that carries a `timestamp` field (line-by-line, no full-file parse).
//! `message_count` is line count of the .jsonl.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

/// v0.2 P2-F4: cache `(path, mtime)` → `(started_at, message_count)` so
/// hot watcher events on `~/.claude/projects/` don't re-read every
/// .jsonl from byte 0 every time the React layer refetches
/// `list_claude_sessions`. Claude session files can reach 100+ MB
/// after long sessions; reading them all on every keystroke (the
/// debounce window collapses many writes to a single watcher event,
/// but the user typing actively still triggers regular refetches) is
/// the dominant cost of the Capture surface.
///
/// Trade-off: filesystems with second-precision mtime (some network
/// mounts) will serve a stale cached entry for within-second edits.
/// Acceptable here — the watcher event fires the refetch and the next
/// refetch after the second boundary picks up the change. For the
/// happy path (macOS APFS, Linux ext4 — both nanosecond-precision)
/// the cache is exact.
/// Fail-loud on `PoisonError` (matches `watcher::SagaInFlightRegistry`
/// at watcher.rs:28-40 and `spawn::SpawnRegistry`): a poisoned cache
/// mutex would silently degrade the warm-list path back to always-read,
/// turning the entire P2-F4 perf win into "Capture surface is slow and
/// nobody knows why." Crashing surfaces the corruption immediately;
/// the user re-launches Trail and the cache starts fresh.
#[derive(Debug, Default)]
pub struct JsonlMetadataCache {
    inner: Mutex<HashMap<PathBuf, CachedJsonlEntry>>,
    /// Test-only: counts how many times `read_or_load` had to fall
    /// through to `read_jsonl_metadata` (cache miss or stat failure).
    /// Used to pin "stable file is NOT re-read on the warm path".
    #[cfg(test)]
    miss_count: std::sync::atomic::AtomicUsize,
}

#[derive(Debug, Clone)]
struct CachedJsonlEntry {
    mtime_nanos: u128,
    started_at: Option<String>,
    message_count: u32,
}

impl JsonlMetadataCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `(started_at, message_count)` for `path`, serving from
    /// the cache when `(path, mtime)` matches a prior load. On stat
    /// failure or cache miss, falls back to `read_jsonl_metadata` and
    /// stores the result keyed by the observed mtime.
    ///
    /// v0.2 F2 (post-review fix): when `read_jsonl_metadata` returns
    /// `None` (file gone mid-walk, permission flip), the caller does
    /// NOT cache. This prevents the cache from memoizing a transient
    /// I/O failure as `(None, 0)` indistinguishable from a legit
    /// empty file.
    fn read_or_load(&self, path: &Path) -> (Option<String>, u32) {
        let mtime_nanos = fs::metadata(path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos());
        let Some(mtime) = mtime_nanos else {
            // No mtime → cannot cache. v0.2 ERR-3 (post-review): log at
            // `trace!` so an operator debugging a slow Capture surface
            // can `RUST_LOG=trail::sessions=trace` and identify which
            // files miss permanently.
            //
            // Cycle-3 (convention warning resolution): the `.unwrap_or`
            // here collapses the F2 Option signal (`None` = "open
            // failed") back into `(None, 0)`. That is intentional and
            // safe on this branch only — we already decided not to
            // cache because mtime was unavailable, so the
            // transient-failure-vs-empty-file distinction (which only
            // matters for caching decisions) is moot. The miss-path
            // below preserves the distinction by handling `None`
            // explicitly before the insert.
            #[cfg(test)]
            self.miss_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            tracing::trace!(
                target: "trail::sessions",
                path = %path.display(),
                "no mtime available; bypassing cache for this file"
            );
            return read_jsonl_metadata(path).unwrap_or((None, 0));
        };

        // Cache lookup — release the lock before the (potentially slow)
        // file read on miss. Match the rest of the codebase: abort on
        // poison rather than silently disabling the cache (see the
        // struct docstring for rationale).
        {
            let guard = self.inner.lock().unwrap_or_else(|_| std::process::abort());
            if let Some(entry) = guard.get(path) {
                if entry.mtime_nanos == mtime {
                    return (entry.started_at.clone(), entry.message_count);
                }
            }
        }

        #[cfg(test)]
        self.miss_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let Some((started_at, message_count)) = read_jsonl_metadata(path) else {
            // v0.2 F2 (post-review): transient I/O failure between
            // `metadata` and `File::open`. Skip caching and return the
            // empty-file fallback; the next call will re-stat and
            // re-attempt, eventually picking up the real content.
            tracing::trace!(
                target: "trail::sessions",
                path = %path.display(),
                "read_jsonl_metadata returned None; not caching transient failure"
            );
            return (None, 0);
        };
        let mut guard = self.inner.lock().unwrap_or_else(|_| std::process::abort());
        guard.insert(
            path.to_path_buf(),
            CachedJsonlEntry {
                mtime_nanos: mtime,
                started_at: started_at.clone(),
                message_count,
            },
        );
        (started_at, message_count)
    }

    #[cfg(test)]
    fn miss_count(&self) -> usize {
        self.miss_count.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// One Claude Code session row surfaced to the React layer.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClaudeSession {
    pub session_id: String,
    pub project_path: String,
    pub started_at: Option<String>,
    pub message_count: u32,
    pub packet_id: Option<String>,
}

/// Failure classifier — surfaced via `ListClaudeSessionsResponse::Failed`.
///
/// `EnumerationError` is part of the public wire contract for the
/// `list_claude_sessions` IPC: a future iteration that encounters a
/// catastrophic enumeration failure (e.g., walking a directory tree that
/// races with deletion mid-walk) needs to surface it without a wire-shape
/// change. The variant is intentionally unused in the current happy/sad
/// paths.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ListFailureKind {
    ProjectsDirNotFound,
    ProjectsDirUnreadable,
    #[allow(dead_code)]
    EnumerationError,
}

#[derive(Debug)]
pub struct ListError {
    pub kind: ListFailureKind,
    pub message: String,
}

/// Resolve the Claude Code projects root. Returns the `TRAIL_CLAUDE_PROJECTS_ROOT`
/// env-var override when set (used by tests for deterministic snapshots and
/// by power users on non-default install layouts); otherwise mirrors
/// `apps/capture/src/transcript/reader.ts::claudeProjectsRoot` and resolves
/// to `~/.claude/projects`.
pub fn claude_projects_root() -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("TRAIL_CLAUDE_PROJECTS_ROOT") {
        if !override_path.is_empty() {
            return Some(PathBuf::from(override_path));
        }
    }
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Convert the sanitized project directory name back to a path-ish display.
/// Claude Code names `~/.claude/projects/-Users-danielbentes-trail` from the
/// cwd `/Users/danielbentes/trail`; we surface the reverse for display.
/// Best-effort — the round-trip is lossy for paths that contain literal
/// dashes; the display string is informational only.
pub fn unsanitize_project_dir(sanitized: &str) -> String {
    if let Some(stripped) = sanitized.strip_prefix('-') {
        format!("/{}", stripped.replace('-', "/"))
    } else {
        sanitized.to_string()
    }
}

/// Enumerate all sessions across all project dirs under
/// `~/.claude/projects/`. The caller supplies the trail sessions directory
/// for packet-cross-reference; in production this is `<repo>/.trail/sessions`
/// (or None when not running inside a Trail-enabled repo).
pub fn list_claude_sessions(
    projects_root: &Path,
    trail_sessions_root: Option<&Path>,
    metadata_cache: &JsonlMetadataCache,
) -> Result<Vec<ClaudeSession>, ListError> {
    if !projects_root.exists() {
        return Err(ListError {
            kind: ListFailureKind::ProjectsDirNotFound,
            message: format!("no Claude Code projects at {}", projects_root.display()),
        });
    }
    let project_entries = fs::read_dir(projects_root).map_err(|e| ListError {
        kind: ListFailureKind::ProjectsDirUnreadable,
        message: format!("read_dir failed: {e}"),
    })?;

    let mut out = Vec::new();
    for entry in project_entries.flatten() {
        let project_dir = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_dir() {
            continue;
        }
        let project_name = entry.file_name().to_string_lossy().into_owned();
        let display_path = unsanitize_project_dir(&project_name);
        collect_jsonl_sessions(&project_dir, &display_path, &mut out, 0, metadata_cache);
    }

    if let Some(trail_root) = trail_sessions_root {
        join_packet_ids(&mut out, trail_root);
    }

    // Sort newest first by started_at descending. Sessions without a
    // parseable timestamp sort to the end.
    out.sort_by(|a, b| match (&a.started_at, &b.started_at) {
        (Some(a_ts), Some(b_ts)) => b_ts.cmp(a_ts),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    Ok(out)
}

/// Recursively walk `dir` looking for `.jsonl` files. Depth-limited to
/// 2 levels to handle the older flat layout AND the newer nested layout
/// without runaway enumeration on a pathological tree.
fn collect_jsonl_sessions(
    dir: &Path,
    project_display: &str,
    out: &mut Vec<ClaudeSession>,
    depth: u8,
    metadata_cache: &JsonlMetadataCache,
) {
    if depth > 2 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            collect_jsonl_sessions(&path, project_display, out, depth + 1, metadata_cache);
            continue;
        }
        let Some(fname) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !fname.ends_with(".jsonl") {
            continue;
        }
        let session_id = fname.trim_end_matches(".jsonl").to_string();
        if session_id.is_empty() {
            continue;
        }
        let (started_at, message_count) = metadata_cache.read_or_load(&path);
        out.push(ClaudeSession {
            session_id,
            project_path: project_display.to_string(),
            started_at,
            message_count,
            packet_id: None,
        });
    }
}

/// Read a .jsonl line-by-line. Returns the first record's `timestamp`
/// field (when present) and the total line count. Returns `None` when
/// the file cannot be opened at all (deleted between stat and open;
/// permission flip mid-walk); callers MUST treat this as "do not
/// cache" — caching a transient I/O failure as `(None, 0)` would
/// memoize a non-fact and serve it under the observed mtime forever
/// (P2-F4 follow-up: F2 from review fan-out on PR #34).
fn read_jsonl_metadata(path: &Path) -> Option<(Option<String>, u32)> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut started_at: Option<String> = None;
    let mut count: u32 = 0;
    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        count = count.saturating_add(1);
        if started_at.is_none() {
            // Best-effort: pull "timestamp":"..." without a full JSON parse
            // to keep the enumeration fast on large session files.
            if let Some(ts) = extract_timestamp_field(&line) {
                started_at = Some(ts);
            }
        }
    }
    Some((started_at, count))
}

/// Pull `"timestamp":"<value>"` from a JSON line without parsing the
/// whole document. Returns the captured value, unescaped enough for
/// ISO-8601 display (we don't unescape backslash sequences — Claude
/// Code timestamps never contain them).
fn extract_timestamp_field(line: &str) -> Option<String> {
    let key = r#""timestamp":""#;
    let start = line.find(key)? + key.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Cross-reference packet IDs from `<trail_root>/<session_id>/packet-*.yml`.
/// The presence of any packet file marks the session as captured; we surface
/// the most-recent packet ID by filename order.
fn join_packet_ids(sessions: &mut [ClaudeSession], trail_root: &Path) {
    for session in sessions.iter_mut() {
        let session_dir = trail_root.join(&session.session_id);
        if !session_dir.is_dir() {
            continue;
        }
        let mut packets: Vec<String> = match fs::read_dir(&session_dir) {
            Ok(entries) => entries
                .flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if name.starts_with("packet-") && name.ends_with(".yml") {
                        Some(name)
                    } else {
                        None
                    }
                })
                .collect(),
            Err(_) => continue,
        };
        if packets.is_empty() {
            continue;
        }
        packets.sort();
        // Pull packet_id from the file's `_meta.packet_id` field. Falls back
        // to the filename stem so the UI still has something to render.
        let newest = packets.last().expect("non-empty by guard above");
        let path = session_dir.join(newest);
        session.packet_id = Some(read_packet_id_from_yaml(&path).unwrap_or_else(|| {
            newest.trim_start_matches("packet-").trim_end_matches(".yml").to_string()
        }));
    }
}

fn read_packet_id_from_yaml(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let value: serde_yaml::Value = serde_yaml::from_slice(&bytes).ok()?;
    value
        .get("_meta")?
        .get("packet_id")?
        .as_str()
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn unsanitize_round_trips_canonical_paths() {
        assert_eq!(
            unsanitize_project_dir("-Users-danielbentes-trail"),
            "/Users/danielbentes/trail"
        );
        assert_eq!(unsanitize_project_dir("nodash"), "nodash");
    }

    #[test]
    fn extract_timestamp_field_pulls_iso_string() {
        let line = r#"{"type":"user","timestamp":"2026-05-19T10:00:00Z","message":{}}"#;
        assert_eq!(
            extract_timestamp_field(line),
            Some("2026-05-19T10:00:00Z".into())
        );
        assert!(extract_timestamp_field("{}").is_none());
    }

    #[test]
    fn list_returns_projects_dir_not_found_when_missing() {
        let tmp = tempdir().unwrap();
        let missing = tmp.path().join("no-such-claude-projects");
        let cache = JsonlMetadataCache::new();
        let err = list_claude_sessions(&missing, None, &cache).unwrap_err();
        assert_eq!(err.kind, ListFailureKind::ProjectsDirNotFound);
    }

    #[test]
    fn list_enumerates_flat_layout_sessions() {
        let tmp = tempdir().unwrap();
        let project = tmp.path().join("-Users-test-repo");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl"),
            r#"{"timestamp":"2026-05-19T10:00:00Z"}
{"timestamp":"2026-05-19T10:00:01Z"}
{"timestamp":"2026-05-19T10:00:02Z"}
"#,
        )
        .unwrap();

        let cache = JsonlMetadataCache::new();
        let sessions = list_claude_sessions(tmp.path(), None, &cache).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        assert_eq!(sessions[0].project_path, "/Users/test/repo");
        assert_eq!(
            sessions[0].started_at,
            Some("2026-05-19T10:00:00Z".into())
        );
        assert_eq!(sessions[0].message_count, 3);
        assert_eq!(sessions[0].packet_id, None);
    }

    #[test]
    fn list_enumerates_nested_layout_sessions() {
        let tmp = tempdir().unwrap();
        let project = tmp.path().join("-Users-test-repo");
        let nested = project.join("uuid-dir");
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            nested.join("session-uuid.jsonl"),
            r#"{"timestamp":"2026-05-18T09:00:00Z"}"#,
        )
        .unwrap();

        let cache = JsonlMetadataCache::new();
        let sessions = list_claude_sessions(tmp.path(), None, &cache).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "session-uuid");
        assert_eq!(sessions[0].message_count, 1);
    }

    #[test]
    fn list_joins_packet_ids_from_trail_sessions_dir() {
        let tmp = tempdir().unwrap();
        let project = tmp.path().join(".claude").join("projects").join("-test-x");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("sess-1.jsonl"),
            r#"{"timestamp":"2026-05-19T10:00:00Z"}"#,
        )
        .unwrap();

        let trail_sessions = tmp.path().join(".trail").join("sessions").join("sess-1");
        fs::create_dir_all(&trail_sessions).unwrap();
        fs::write(
            trail_sessions.join("packet-1.yml"),
            "_meta:\n  packet_id: 01HZX-PACKET-ULID\napproval_trail: []\n",
        )
        .unwrap();

        let cache = JsonlMetadataCache::new();
        let sessions = list_claude_sessions(
            &tmp.path().join(".claude").join("projects"),
            Some(&tmp.path().join(".trail").join("sessions")),
            &cache,
        )
        .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].packet_id, Some("01HZX-PACKET-ULID".into()));
    }

    #[test]
    fn list_sorts_newest_first() {
        let tmp = tempdir().unwrap();
        let project = tmp.path().join("-test");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("older.jsonl"),
            r#"{"timestamp":"2026-05-18T10:00:00Z"}"#,
        )
        .unwrap();
        fs::write(
            project.join("newer.jsonl"),
            r#"{"timestamp":"2026-05-19T10:00:00Z"}"#,
        )
        .unwrap();
        fs::write(
            project.join("no-timestamp.jsonl"),
            r#"{"type":"user"}"#,
        )
        .unwrap();

        let cache = JsonlMetadataCache::new();
        let sessions = list_claude_sessions(tmp.path(), None, &cache).unwrap();
        assert_eq!(sessions.len(), 3);
        assert_eq!(sessions[0].session_id, "newer");
        assert_eq!(sessions[1].session_id, "older");
        assert_eq!(sessions[2].session_id, "no-timestamp");
    }

    /// v0.2 P2-F4: warm-path re-enumeration must NOT re-read jsonl files
    /// whose mtime is unchanged. Asserted via the cache's miss_count: the
    /// first pass hits the disk for every file; the second pass with the
    /// same cache hits the cache for every file.
    #[test]
    fn cache_skips_reread_on_stable_mtime_v02_p2_f4() {
        let tmp = tempdir().unwrap();
        let project = tmp.path().join("-test");
        fs::create_dir_all(&project).unwrap();
        for i in 0..10 {
            fs::write(
                project.join(format!("sess-{i}.jsonl")),
                format!(r#"{{"timestamp":"2026-05-19T10:00:0{i}Z"}}"#),
            )
            .unwrap();
        }

        let cache = JsonlMetadataCache::new();
        let _first = list_claude_sessions(tmp.path(), None, &cache).unwrap();
        let misses_after_cold_pass = cache.miss_count();
        assert_eq!(
            misses_after_cold_pass, 10,
            "cold pass should miss for all 10 files"
        );

        // Warm pass with same cache, no file mutations.
        let _second = list_claude_sessions(tmp.path(), None, &cache).unwrap();
        assert_eq!(
            cache.miss_count(),
            misses_after_cold_pass,
            "warm pass should add zero misses — every file served from cache"
        );
    }

    /// v0.2 P2-F4: when a file's mtime changes, the cache MUST re-read
    /// it so updated message_count + started_at are reflected.
    #[test]
    fn cache_reloads_when_mtime_changes_v02_p2_f4() {
        let tmp = tempdir().unwrap();
        let project = tmp.path().join("-test");
        fs::create_dir_all(&project).unwrap();
        let session_path = project.join("sess.jsonl");
        fs::write(
            &session_path,
            r#"{"timestamp":"2026-05-19T10:00:00Z"}"#,
        )
        .unwrap();

        let cache = JsonlMetadataCache::new();
        let first = list_claude_sessions(tmp.path(), None, &cache).unwrap();
        assert_eq!(first[0].message_count, 1);
        let cold_misses = cache.miss_count();

        // Sleep ≥1ms then rewrite with a longer body so the OS bumps
        // mtime. On filesystems with second-precision mtime, this is
        // accepted as a known limitation (see cache docstring).
        std::thread::sleep(std::time::Duration::from_millis(15));
        fs::write(
            &session_path,
            "{\"timestamp\":\"2026-05-19T10:00:00Z\"}\n{\"timestamp\":\"2026-05-19T10:00:01Z\"}\n",
        )
        .unwrap();

        let second = list_claude_sessions(tmp.path(), None, &cache).unwrap();
        // If the cache correctly invalidated, message_count is now 2.
        // If mtime resolution was too coarse (second-precision FS), the
        // cache may serve stale; this test runs on the standard tempdir
        // backend (APFS / ext4 / tmpfs) which all have ≤ms resolution,
        // so the assertion holds in CI.
        assert_eq!(second[0].message_count, 2);
        assert!(
            cache.miss_count() > cold_misses,
            "mtime change must trigger at least one extra miss"
        );
    }
}
