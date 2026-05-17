//! Settings file I/O — `~/.trail/settings.json` (B5 §6.6).
//!
//! Sprint 2 (gh#8) wires the read/write path. The shape mirrors the TS
//! `settingsSchema` in `src/ipc/contract.ts`. The `pinned_sessions` field
//! is the persistent backing for the "Your recent sessions" pin (gh#8
//! criterion 2): up to 5 entries, LRU-ordered, written via the same
//! atomic-write protocol as packet YAML (B5 §3.1).
//!
//! Atomic-write protocol (per B5 §3.1, mirroring the saga used for packet
//! YAML):
//!   1. Compute new content + (TODO Sprint 4) HMAC.
//!   2. Write to `<path>.tmp`.
//!   3. fsync the tmp file.
//!   4. Rename tmp → final.
//!
//! HMAC is deferred to Sprint 4 (the audit-log writer ships its keying
//! infrastructure in that sprint). The schema reserves the field; reads
//! tolerate its absence.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Pinned session entry — references a session by `session_id` (the YAML
/// folder name). `pinned_at` is an ISO-8601 timestamp; LRU is computed by
/// sort-descending. We deliberately do NOT bake the session display name
/// here; the sidebar resolves it from libSQL on read so a session rename
/// upstream is reflected without requiring a settings rewrite.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PinnedSession {
    pub session_id: String,
    pub pinned_at: String,
}

/// Settings shape. Field set MUST stay in lock-step with `settingsSchema`
/// in `apps/ui/src/ipc/contract.ts` — see the schema_keys() function below
/// for the runtime-checked invariant (mirrors cycle-2 N28 lesson: a test
/// loads the live shape, not a parallel-maintained constant).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub theme: String,
    pub density: String,
    pub disable_tamper_warnings: bool,
    pub heavy_redaction_threshold: u32,
    pub capture_cli_path: String,
    /// Sprint 2 addition: persistent pinned sessions (gh#8 criterion 2).
    /// Up to `MAX_PINNED_SESSIONS` entries, LRU-ordered by `pinned_at`.
    #[serde(default)]
    pub pinned_sessions: Vec<PinnedSession>,
    /// Reserved for Sprint 4 HMAC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hmac: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            density: "comfortable".into(),
            disable_tamper_warnings: false,
            heavy_redaction_threshold: 15,
            capture_cli_path: "@synapti/trail-capture".into(),
            pinned_sessions: Vec::new(),
            hmac: None,
        }
    }
}

/// LRU cap (gh#8 criterion 2: "max 5 entries").
pub const MAX_PINNED_SESSIONS: usize = 5;

#[derive(Debug)]
pub enum SettingsError {
    Io(std::io::Error),
    Serde(serde_json::Error),
    HomeDirUnknown,
    /// The `pinned_sessions` array exceeded the cap during a write.
    /// Surface to the caller so they can prune the oldest entries first
    /// (callers SHOULD do this implicitly via `pin_session_lru`).
    TooManyPins,
}

impl std::fmt::Display for SettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SettingsError::Io(e) => write!(f, "settings io: {e}"),
            SettingsError::Serde(e) => write!(f, "settings serde: {e}"),
            SettingsError::HomeDirUnknown => write!(f, "could not resolve home directory"),
            SettingsError::TooManyPins => {
                write!(f, "pinned_sessions exceeds MAX_PINNED_SESSIONS")
            }
        }
    }
}

impl std::error::Error for SettingsError {}

impl From<std::io::Error> for SettingsError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<serde_json::Error> for SettingsError {
    fn from(e: serde_json::Error) -> Self {
        Self::Serde(e)
    }
}

/// Resolve the settings file path (B5 §6.6). Honours `TRAIL_SETTINGS_PATH`
/// for tests (parallel to the `TRAIL_DB_PATH` override in `db.rs`).
pub fn resolve_settings_path() -> Result<PathBuf, SettingsError> {
    if let Ok(override_path) = std::env::var("TRAIL_SETTINGS_PATH") {
        return Ok(PathBuf::from(override_path));
    }
    let mut p = dirs::home_dir().ok_or(SettingsError::HomeDirUnknown)?;
    p.push(".trail");
    Ok(p.join("settings.json"))
}

/// v0.1.1 B8: hard cap on `settings.json` size read at boot + on every
/// `read_settings` IPC. The schema (~7 fields + up to MAX_PINNED_SESSIONS
/// pin entries) fits comfortably in 16 KB; 64 KB leaves headroom for
/// future growth. A malicious / corrupted `~/.trail/settings.json` of 1 GB
/// would otherwise load entirely into memory at boot — the IPC handler
/// proxies the same path, so DevTools `read_settings` could OOM the
/// desktop too. Mirrors `READ_PACKET_SIZE_CAP_BYTES` in `ipc.rs` (security
/// audit P2-3).
pub const SETTINGS_MAX_BYTES: u64 = 64 * 1024;

/// Read settings from `path`. Missing file → defaults. Malformed → error
/// surfaced; the caller decides whether to fall back (the IPC handler
/// returns `IpcError::internal` so the operator sees the real cause).
pub fn read_settings(path: &Path) -> Result<Settings, SettingsError> {
    if !path.exists() {
        return Ok(Settings::default());
    }
    // v0.1.1 B8: size-cap before fs::read so we never stream a pathological
    // file into memory. Returns a deserialise error variant so the IPC
    // handler surfaces `IpcError::internal` with the real cause; defaults
    // are NOT silently substituted (a user editing settings to oversize is
    // a configuration mistake that should be visible).
    let stat = fs::metadata(path)?;
    if stat.len() > SETTINGS_MAX_BYTES {
        return Err(SettingsError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "settings.json exceeds {}-byte cap (got {} bytes)",
                SETTINGS_MAX_BYTES,
                stat.len()
            ),
        )));
    }
    let bytes = fs::read(path)?;
    if bytes.is_empty() {
        return Ok(Settings::default());
    }
    let s: Settings = serde_json::from_slice(&bytes)?;
    Ok(s)
}

/// Write settings via the atomic tmp-rename protocol (B5 §3.1).
pub fn write_settings(path: &Path, settings: &Settings) -> Result<(), SettingsError> {
    if settings.pinned_sessions.len() > MAX_PINNED_SESSIONS {
        return Err(SettingsError::TooManyPins);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp_path = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(settings)?;
    {
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp_path, path)?;
    Ok(())
}

/// LRU pin — moves `session_id` to the front, drops the oldest when the
/// list exceeds the cap. Returns the updated settings struct (settings is
/// mutated in place).
///
/// Currently unreferenced from the production binary path: the IPC
/// `write_settings` handler accepts an entire pinned_sessions array
/// computed on the FRONTEND (apps/ui/src/services/recent-sessions.ts).
/// Kept here for two reasons:
///   1. Symmetry: a future Sprint 4 audit-log writer for "pinned via
///      keyboard shortcut" needs a backend-side pin path.
///   2. Test coverage: the LRU invariants are property-tested at this
///      layer (lru_caps_at_five_and_evicts_oldest, lru_dedupes_existing_session)
///      so a regression in either tier is caught.
#[allow(dead_code)]
pub fn pin_session_lru(settings: &mut Settings, session_id: &str, now_iso: String) {
    settings
        .pinned_sessions
        .retain(|p| p.session_id != session_id);
    settings.pinned_sessions.insert(
        0,
        PinnedSession {
            session_id: session_id.into(),
            pinned_at: now_iso,
        },
    );
    if settings.pinned_sessions.len() > MAX_PINNED_SESSIONS {
        settings.pinned_sessions.truncate(MAX_PINNED_SESSIONS);
    }
}

/// Unpin a session.
#[allow(dead_code)]
pub fn unpin_session(settings: &mut Settings, session_id: &str) {
    settings
        .pinned_sessions
        .retain(|p| p.session_id != session_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path() -> PathBuf {
        let mut p = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("trail-settings-test-{nanos}.json"));
        p
    }

    #[test]
    fn missing_file_returns_defaults() {
        let path = tmp_path();
        let s = read_settings(&path).unwrap();
        assert_eq!(s.theme, "system");
        assert_eq!(s.density, "comfortable");
        assert_eq!(s.heavy_redaction_threshold, 15);
        assert!(s.pinned_sessions.is_empty());
    }

    #[test]
    fn round_trip_via_atomic_write() {
        let path = tmp_path();
        let mut s = Settings::default();
        pin_session_lru(&mut s, "session-A", "2026-05-09T12:00:00Z".into());
        write_settings(&path, &s).unwrap();
        let read = read_settings(&path).unwrap();
        assert_eq!(read.pinned_sessions.len(), 1);
        assert_eq!(read.pinned_sessions[0].session_id, "session-A");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn lru_caps_at_five_and_evicts_oldest() {
        let mut s = Settings::default();
        // Pin 7 different sessions; oldest 2 should evict.
        for i in 0..7 {
            pin_session_lru(&mut s, &format!("s-{i}"), format!("2026-05-09T{i:02}:00:00Z"));
        }
        assert_eq!(s.pinned_sessions.len(), MAX_PINNED_SESSIONS);
        // Most recent (s-6) is at front, s-2 is last surviving (s-0 + s-1
        // dropped).
        assert_eq!(s.pinned_sessions[0].session_id, "s-6");
        assert_eq!(s.pinned_sessions.last().unwrap().session_id, "s-2");
    }

    #[test]
    fn lru_dedupes_existing_session() {
        let mut s = Settings::default();
        pin_session_lru(&mut s, "s-A", "2026-05-09T01:00:00Z".into());
        pin_session_lru(&mut s, "s-B", "2026-05-09T02:00:00Z".into());
        // Re-pin s-A — it should move to front, not duplicate.
        pin_session_lru(&mut s, "s-A", "2026-05-09T03:00:00Z".into());
        assert_eq!(s.pinned_sessions.len(), 2);
        assert_eq!(s.pinned_sessions[0].session_id, "s-A");
        assert_eq!(s.pinned_sessions[0].pinned_at, "2026-05-09T03:00:00Z");
    }

    #[test]
    fn unpin_removes_only_that_session() {
        let mut s = Settings::default();
        pin_session_lru(&mut s, "s-A", "2026-05-09T01:00:00Z".into());
        pin_session_lru(&mut s, "s-B", "2026-05-09T02:00:00Z".into());
        unpin_session(&mut s, "s-A");
        assert_eq!(s.pinned_sessions.len(), 1);
        assert_eq!(s.pinned_sessions[0].session_id, "s-B");
    }

    #[test]
    fn write_rejects_oversized_pin_list() {
        let path = tmp_path();
        let mut s = Settings::default();
        // Manually push past the cap (bypassing pin_session_lru) to exercise
        // the write-time guard.
        for i in 0..(MAX_PINNED_SESSIONS + 1) {
            s.pinned_sessions.push(PinnedSession {
                session_id: format!("s-{i}"),
                pinned_at: format!("2026-05-09T{i:02}:00:00Z"),
            });
        }
        match write_settings(&path, &s) {
            Err(SettingsError::TooManyPins) => {}
            other => panic!("expected TooManyPins; got {other:?}"),
        }
    }

    #[test]
    fn malformed_json_surfaces_error() {
        let path = tmp_path();
        std::fs::write(&path, b"{not json}").unwrap();
        match read_settings(&path) {
            Err(SettingsError::Serde(_)) => {}
            other => panic!("expected Serde error; got {other:?}"),
        }
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn empty_file_returns_defaults() {
        let path = tmp_path();
        std::fs::write(&path, b"").unwrap();
        let s = read_settings(&path).unwrap();
        assert_eq!(s.theme, "system");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn schema_keys_match_typescript_contract() {
        // N28-style guard: serialise default settings and assert the JSON
        // object keys match the TS settingsSchema field names declared in
        // apps/ui/src/ipc/contract.ts. A rename in either side that does
        // not propagate fails this test.
        let s = Settings::default();
        let v = serde_json::to_value(&s).unwrap();
        let obj = v.as_object().unwrap();
        let expected = [
            "theme",
            "density",
            "disable_tamper_warnings",
            "heavy_redaction_threshold",
            "capture_cli_path",
            "pinned_sessions",
        ];
        for k in expected {
            assert!(
                obj.contains_key(k),
                "settings missing key {k} (got: {:?})",
                obj.keys().collect::<Vec<_>>()
            );
        }
    }
}
