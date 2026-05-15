//! libSQL/SQLite connection management for Trail (B5 §7.1).
//!
//! v0.1 uses rusqlite (bundled SQLite) as the local-only substrate; the
//! libSQL Rust client lands when its synchronous API stabilises. Sprint 2
//! (gh#8) wires the connection pool, query helpers for the trail browser,
//! and the migration applier.
//!
//! Concurrency model (per B5 §3.5):
//!   - Single-process, single-user. Tauri State holds ONE connection
//!     wrapped in a Mutex; all query handlers acquire it briefly.
//!   - libSQL concurrency-friendly mode (`PRAGMA journal_mode = WAL`)
//!     applied at boot so concurrent readers do not block the schema
//!     applier when it acquires the write lock via `BEGIN IMMEDIATE`.
//!
//! The DB path resolution (per B5 §6.6):
//!   - User home: `dirs::home_dir() + .trail/trail.db`
//!   - Test override: `TRAIL_DB_PATH` env var (consumed by integration tests
//!     so they hit a tempfile, not the real user DB).

use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::migrations;

#[derive(Debug)]
pub enum DbError {
    Sql(rusqlite::Error),
    Migration(migrations::MigrationError),
    Io(std::io::Error),
    /// `dirs::home_dir()` returned None (extremely rare; surfaces as a setup
    /// error, not a runtime crash).
    HomeDirUnknown,
    /// The connection mutex is poisoned (a thread panicked while holding
    /// it). Treat as fatal; the desktop process should restart. Today the
    /// poisoned path is handled inline at the call site via
    /// `watcher::abort_on_poison`, so this variant is never constructed —
    /// kept for symmetry with the rest of `DbError` and for v0.1.x when
    /// callers may surface a typed error instead of aborting
    /// (Phase 4 cycle-1 review F2-19).
    #[allow(dead_code)]
    Poisoned,
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbError::Sql(e) => write!(f, "sql error: {e}"),
            DbError::Migration(e) => write!(f, "migration error: {e}"),
            DbError::Io(e) => write!(f, "io error: {e}"),
            DbError::HomeDirUnknown => write!(f, "could not resolve user home directory"),
            DbError::Poisoned => write!(f, "db connection mutex poisoned"),
        }
    }
}

impl std::error::Error for DbError {}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> Self {
        DbError::Sql(e)
    }
}
impl From<migrations::MigrationError> for DbError {
    fn from(e: migrations::MigrationError) -> Self {
        DbError::Migration(e)
    }
}
impl From<std::io::Error> for DbError {
    fn from(e: std::io::Error) -> Self {
        DbError::Io(e)
    }
}

/// Tauri State holder for the singleton DB connection.
pub struct DbState(pub Mutex<Connection>);

impl DbState {
    pub fn new(conn: Connection) -> Self {
        Self(Mutex::new(conn))
    }
}

/// Resolve the DB path. Honours `TRAIL_DB_PATH` for tests; falls back to
/// `~/.trail/trail.db` per B5 §6.6.
pub fn resolve_db_path() -> Result<PathBuf, DbError> {
    if let Ok(override_path) = std::env::var("TRAIL_DB_PATH") {
        return Ok(PathBuf::from(override_path));
    }
    let mut p = dirs::home_dir().ok_or(DbError::HomeDirUnknown)?;
    p.push(".trail");
    Ok(p.join("trail.db"))
}

/// Open the connection, ensure the parent directory exists, set pragmas,
/// and apply migrations. Returns the ready-to-use connection.
pub fn open_and_migrate(path: &PathBuf) -> Result<Connection, DbError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut conn = Connection::open(path)?;
    // WAL allows concurrent readers while the migration applier holds the
    // write lock (per B5 §3.5 + §3.3 BEGIN IMMEDIATE rationale).
    // pragma_update returns Result; ignore any warning on first open of a
    // fresh DB where the journal mode is being set rather than queried.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    migrations::apply_all(&mut conn)?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Query helpers — read path for the Trail browser (gh#8 criteria 1, 6, 7).
// ---------------------------------------------------------------------------

/// One sidebar row. Mirrors the TS `SidebarRow` shape
/// (`apps/ui/src/db/queries.ts`). The four count columns are histogram
/// inputs for the row's risk indicator (B3 §4.3.1 — risk pigment).
#[derive(Debug, serde::Serialize, Clone)]
pub struct SidebarRow {
    pub packet_id: String,
    pub session_id: String,
    pub display_name: String,
    pub captured_at: String,
    pub low_count: i64,
    pub med_count: i64,
    pub high_count: i64,
    pub crit_count: i64,
    pub redaction_count: i64,
    pub posted_to_pr_count: i64,
}

/// Filter shape — mirrors `trailFilterSchema` in `src/ipc/contract.ts`.
#[derive(Debug, Clone, Default)]
pub struct TrailFilter {
    pub risk_levels: Option<Vec<String>>,
    pub captured_after: Option<String>,
    pub captured_before: Option<String>,
    pub has_redactions: Option<bool>,
    pub search: Option<String>,
}

const SIDEBAR_BASE_SQL: &str = "\
SELECT \
  p.packet_id, \
  p.session_id, \
  COALESCE(NULLIF(p.repo_path, ''), p.session_id) || ' / ' || substr(p.packet_id, 1, 6) AS display_name, \
  p.captured_at, \
  COALESCE(SUM(CASE WHEN COALESCE(c.risk_level_reviewer_override, c.risk_level_creator_override, c.risk_level_agent) = 'low'  THEN 1 ELSE 0 END), 0) AS low_count, \
  COALESCE(SUM(CASE WHEN COALESCE(c.risk_level_reviewer_override, c.risk_level_creator_override, c.risk_level_agent) = 'med'  THEN 1 ELSE 0 END), 0) AS med_count, \
  COALESCE(SUM(CASE WHEN COALESCE(c.risk_level_reviewer_override, c.risk_level_creator_override, c.risk_level_agent) = 'high' THEN 1 ELSE 0 END), 0) AS high_count, \
  COALESCE(SUM(CASE WHEN COALESCE(c.risk_level_reviewer_override, c.risk_level_creator_override, c.risk_level_agent) = 'crit' THEN 1 ELSE 0 END), 0) AS crit_count, \
  (SELECT COUNT(*) FROM redaction_audit r WHERE r.packet_id = p.packet_id) AS redaction_count, \
  (SELECT COUNT(*) FROM posted_to_pr_history h WHERE h.packet_id = p.packet_id) AS posted_to_pr_count \
FROM packets p \
LEFT JOIN claims c ON c.packet_id = p.packet_id";

/// Run the trail browser query. Returns up to `limit` rows, sorted by
/// `captured_at DESC`. The risk-level filter operates on the per-row
/// histogram: a packet matches if it has ≥1 claim at any selected level.
pub fn query_trail(
    conn: &Connection,
    filter: &TrailFilter,
    limit: i64,
) -> Result<Vec<SidebarRow>, DbError> {
    let mut sql = String::from(SIDEBAR_BASE_SQL);
    let mut where_clauses: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(after) = filter.captured_after.as_ref() {
        where_clauses.push("p.captured_at >= ?".into());
        params.push(Box::new(after.clone()));
    }
    if let Some(before) = filter.captured_before.as_ref() {
        where_clauses.push("p.captured_at <= ?".into());
        params.push(Box::new(before.clone()));
    }
    if filter.has_redactions == Some(true) {
        where_clauses
            .push("EXISTS (SELECT 1 FROM redaction_audit r WHERE r.packet_id = p.packet_id)".into());
    }
    if let Some(q) = filter.search.as_ref() {
        // F-CODE-1 + F-SEC-1: bind ONE param per `?` placeholder (the OR
        // arm has two), AND escape SQLite LIKE wildcards (`%`, `_`,
        // backslash itself) so a user typing `100%_complete` matches the
        // literal string, not the wildcard pattern. We use `\` as the
        // ESCAPE clause character; it must be escaped first so we don't
        // double-escape the literals we're about to introduce.
        let escaped = q.replace('\\', r"\\").replace('%', r"\%").replace('_', r"\_");
        let needle = format!("%{escaped}%");
        where_clauses.push(
            "(p.session_id LIKE ? ESCAPE '\\' OR p.repo_path LIKE ? ESCAPE '\\')".into(),
        );
        params.push(Box::new(needle.clone()));
        params.push(Box::new(needle));
    }
    if !where_clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&where_clauses.join(" AND "));
    }
    sql.push_str(" GROUP BY p.packet_id");
    if let Some(levels) = filter.risk_levels.as_ref().filter(|v| !v.is_empty()) {
        // Risk-level filter applies post-aggregation (HAVING) — a packet
        // matches when it has ≥1 claim at any of the selected levels.
        let mut having: Vec<&str> = Vec::new();
        for level in levels {
            match level.as_str() {
                "low" => having.push("low_count > 0"),
                "med" => having.push("med_count > 0"),
                "high" => having.push("high_count > 0"),
                "crit" => having.push("crit_count > 0"),
                _ => {} // unknown level silently ignored at this layer; IPC
                        // already validates via zod.
            }
        }
        if !having.is_empty() {
            sql.push_str(" HAVING (");
            sql.push_str(&having.join(" OR "));
            sql.push(')');
        }
    }
    sql.push_str(" ORDER BY p.captured_at DESC LIMIT ?");
    params.push(Box::new(limit));

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(param_refs), |row| {
        Ok(SidebarRow {
            packet_id: row.get(0)?,
            session_id: row.get(1)?,
            display_name: row.get(2)?,
            captured_at: row.get(3)?,
            low_count: row.get(4)?,
            med_count: row.get(5)?,
            high_count: row.get(6)?,
            crit_count: row.get(7)?,
            redaction_count: row.get(8)?,
            posted_to_pr_count: row.get(9)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Recent sessions: distinct session_id, sorted by latest packet,
/// capped at `limit`. Each row aggregates the session's packet count.
#[derive(Debug, serde::Serialize, Clone)]
pub struct RecentSession {
    pub session_id: String,
    pub latest_packet_id: String,
    pub packet_count: i64,
    pub latest_captured_at: String,
}

pub fn query_recent_sessions(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<RecentSession>, DbError> {
    let sql = "\
        SELECT \
          p.session_id, \
          p.packet_id AS latest_packet_id, \
          (SELECT COUNT(*) FROM packets p2 WHERE p2.session_id = p.session_id) AS packet_count, \
          p.captured_at AS latest_captured_at \
        FROM packets p \
        WHERE p.captured_at = (SELECT MAX(p3.captured_at) FROM packets p3 WHERE p3.session_id = p.session_id) \
        ORDER BY p.captured_at DESC \
        LIMIT ?";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([limit], |row| {
        Ok(RecentSession {
            session_id: row.get(0)?,
            latest_packet_id: row.get(1)?,
            packet_count: row.get(2)?,
            latest_captured_at: row.get(3)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Sprint 4 (gh#11 criterion 4): audit_log append + chain-hash. Mirrors the
// TS-side audit-log-hash.ts (length-prefix encoding so a literal '|' in
// `details` cannot be reinterpreted as a field boundary collision).
// ---------------------------------------------------------------------------

/// Length-prefix encode a single audit-log field per the wire format in
/// `apps/ui/src/db/audit-log-hash.ts`. Mirror character-for-character (F25
/// lesson) so the Rust + TS hashing functions produce identical outputs.
fn lp(value: Option<&str>) -> String {
    match value {
        None => "n:".into(),
        Some("") => "0:".into(),
        Some(s) => {
            let bytes = s.as_bytes().len();
            format!("{bytes}:{s}")
        }
    }
}

fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest.iter() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Compute the row_hash for a single audit_log row. The chain-hash links
/// rows so a deletion (which the SQLite triggers `audit_log_no_update` /
/// `audit_log_no_delete` BLOCK) would still surface via verifyChain on
/// next read.
pub fn compute_audit_row_hash(
    event_type: &str,
    packet_id: Option<&str>,
    details: &str,
    occurred_at: &str,
    prev_hash: Option<&str>,
) -> String {
    let input = format!(
        "{}{}{}{}{}",
        lp(Some(event_type)),
        lp(packet_id),
        lp(Some(details)),
        lp(Some(occurred_at)),
        lp(prev_hash)
    );
    sha256_hex(&input)
}

#[cfg(test)]
mod audit_hash_tests {
    use super::*;

    /// Cross-validate that the Rust port matches the TS audit-log-hash
    /// implementation byte-for-byte. The known-good hash on the right
    /// side was computed by running the equivalent inputs through the
    /// TS `computeRowHash` function (see audit-log-hash.ts) — captured
    /// at commit time so a future divergence (e.g., if someone edits
    /// the TS lp() but not the Rust lp()) surfaces here as a test
    /// failure, not as silent chain corruption.
    ///
    /// F25 lesson — port specs character-for-character. The lp()
    /// encoding is the most fragile primitive in the audit chain.
    // Intentional camelCase tail mirrors the TS identifier `computeRowHash`
    // so the cross-language parity test name remains discoverable on both
    // sides. The non_snake_case lint is otherwise informative.
    #[test]
    #[allow(non_snake_case)]
    fn rust_audit_row_hash_matches_ts_computeRowHash() {
        let input_event_type = "tamper_dismissed";
        let input_packet_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let input_details = "{}";
        let input_occurred_at = "2026-05-09T12:00:00.000Z";
        let input_prev_hash: Option<&str> = None;
        let got = compute_audit_row_hash(
            input_event_type,
            Some(input_packet_id),
            input_details,
            input_occurred_at,
            input_prev_hash,
        );
        // Computed via the TS reference implementation in
        // apps/ui/src/db/audit-log-hash.ts:
        //   input = "16:tamper_dismissed26:01ARZ3NDEKTSV4RRFFQ69G5FAV2:{}24:2026-05-09T12:00:00.000Zn:"
        //   sha256 = 8d4d6dfb35eadd433821acca83e6730876fdb9321eac5ff8764c6e4b28ee94ca
        assert_eq!(
            got,
            "8d4d6dfb35eadd433821acca83e6730876fdb9321eac5ff8764c6e4b28ee94ca"
        );
    }

    #[test]
    fn lp_distinguishes_null_from_empty_string() {
        // Substitution attack defense — null and empty must hash differently.
        assert_eq!(lp(None), "n:");
        assert_eq!(lp(Some("")), "0:");
        assert_ne!(lp(None), lp(Some("")));
    }

    #[test]
    fn lp_uses_byte_length_not_char_count() {
        // Multi-byte char: 'é' is 2 bytes in UTF-8.
        assert_eq!(lp(Some("é")), "2:é");
    }
}

/// Append a row to the audit_log table, computing prev_hash + row_hash.
/// The function is `&mut Connection` because it runs inside a write TX.
pub fn append_audit_log(
    conn: &mut Connection,
    event_type: &str,
    packet_id: Option<&str>,
    details: &str,
) -> Result<(), DbError> {
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let prev_hash: Option<String> = tx
        .query_row(
            "SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();
    let row_hash = compute_audit_row_hash(
        event_type,
        packet_id,
        details,
        &now,
        prev_hash.as_deref(),
    );
    tx.execute(
        "INSERT INTO audit_log (event_type, packet_id, details, prev_hash, row_hash, occurred_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![event_type, packet_id, details, prev_hash, row_hash, now],
    )?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Sprint 3a (gh#9 criterion 7): packet-by-id metadata lookup.
//
// `read_packet` resolves the on-disk YAML path for a given packet_id by
// reading from the `packets` table. The TS-side packet-loader then loads
// the file via the IPC response's yaml_text + Ajv-validates it.
// ---------------------------------------------------------------------------

/// One row from the `packets` table — the metadata `read_packet` resolves
/// to before returning the YAML content. Mirrors the TS `PacketMetaRow`
/// shape in `apps/ui/src/db/queries.ts`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PacketMetaRow {
    pub packet_id: String,
    pub session_id: String,
    pub yaml_path: String,
    pub schema_version: String,
    pub parent_packet_id: Option<String>,
}

/// Reverse-lookup a packet's ULID from its on-disk yaml_path (Sprint 4
/// cycle-1.5 F2 fix; gh#11 AC-4 closure for parse-error / missing
/// branches).
///
/// The watcher receives **absolute** paths from notify (e.g., the
/// fsevents/inotify backend canonicalizes); libSQL stores
/// **workspace-relative** paths (e.g., `.trail/sessions/sid/packet-1.yml`).
/// We therefore match in two passes:
///   1. Direct equality (handles the case where the desktop process
///      stores absolute paths in libSQL — defensive).
///   2. Suffix match (the canonical case): the stored relative path is
///      a suffix of the absolute path with a path-separator boundary so
///      `.trail/sessions/sid/packet-1.yml` does NOT spuriously match
///      `something/x.trail/sessions/sid/packet-1.yml`.
///
/// Returns `None` when no row matches; the caller (watcher) emits with
/// an empty packet_id and mismatch_type to fall through to the
/// "external write to a path Trail does not yet know about" surface.
pub fn select_packet_id_by_path(
    conn: &Connection,
    abs_path: &std::path::Path,
) -> Result<Option<String>, DbError> {
    let abs_str = abs_path.to_string_lossy().to_string();
    // Pass 1: direct match (defense-in-depth; storage layer may grow
    // absolute paths in a future migration).
    let mut stmt = conn.prepare(
        "SELECT packet_id FROM packets WHERE yaml_path = ?1 LIMIT 1",
    )?;
    let mut rows = stmt.query([&abs_str])?;
    if let Some(row) = rows.next()? {
        return Ok(Some(row.get(0)?));
    }
    drop(rows);
    drop(stmt);
    // Pass 2: suffix match. Pull all rows whose yaml_path is shorter
    // than abs_str and ends-with the stored path with a path-separator
    // boundary. We deliberately do NOT use SQL LIKE because the LIKE
    // wildcard escape rules differ across SQLite/libSQL builds; the
    // explicit Rust loop keeps semantics predictable.
    let mut stmt = conn.prepare("SELECT packet_id, yaml_path FROM packets")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let pid: String = row.get(0)?;
        let stored: String = row.get(1)?;
        if stored.is_empty() || stored.len() >= abs_str.len() {
            continue;
        }
        if abs_str.ends_with(&stored) {
            // Path-separator boundary: char preceding the suffix MUST
            // be `/` or `\` (Windows). This rejects pathological cases
            // like an unrelated path that incidentally ends with a
            // bytewise suffix of another packet's relative path.
            let boundary = abs_str.len() - stored.len();
            if boundary == 0 {
                return Ok(Some(pid));
            }
            let prev = abs_str.as_bytes()[boundary - 1];
            if prev == b'/' || prev == b'\\' {
                return Ok(Some(pid));
            }
        }
    }
    Ok(None)
}

/// Look up a packet's metadata by ULID. Returns `None` when the packet is
/// not present in the libSQL store; the caller (ipc::read_packet) maps
/// `None` to `IpcError::NotFound`.
pub fn select_packet_meta(
    conn: &Connection,
    packet_id: &str,
) -> Result<Option<PacketMetaRow>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT packet_id, session_id, yaml_path, schema_version, parent_packet_id \
         FROM packets WHERE packet_id = ?1 LIMIT 1",
    )?;
    let mut rows = stmt.query([packet_id])?;
    if let Some(row) = rows.next()? {
        let meta = PacketMetaRow {
            packet_id: row.get(0)?,
            session_id: row.get(1)?,
            yaml_path: row.get(2)?,
            schema_version: row.get(3)?,
            parent_packet_id: row.get::<_, Option<String>>(4)?,
        };
        Ok(Some(meta))
    } else {
        Ok(None)
    }
}

// ---------------------------------------------------------------------------
// Test-only seeding helpers
// ---------------------------------------------------------------------------

/// Generate `n` synthetic packets for stress testing. Used by Sprint 2's
/// 1000-packet timeline benchmark (gh#8 criterion 5). The seed is
/// deterministic: the same `n` produces the same packet IDs and timestamps.
///
/// Public so the Playwright E2E harness can call it via a dedicated IPC
/// command (see `src/ipc.rs::seed_stress_packets`). NOT exposed in
/// production builds — gated by `cfg(any(test, debug_assertions, feature =
/// "test-fixtures"))`.
#[cfg(any(test, debug_assertions, feature = "test-fixtures"))]
pub fn seed_stress_packets(conn: &mut Connection, n: usize) -> Result<(), DbError> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    {
        let mut packet_stmt = tx.prepare(
            "INSERT INTO packets (packet_id, session_id, repo_path, captured_at, schema_version, yaml_path) VALUES (?, ?, ?, ?, '0.1.1', ?)",
        )?;
        let mut claim_stmt = tx.prepare(
            "INSERT INTO claims (claim_id, packet_id, claim_text, synthesis_mode, risk_level_agent, position) VALUES (?, ?, ?, 'mechanical', ?, ?)",
        )?;
        let levels = ["low", "med", "high", "crit"];
        for i in 0..n {
            let packet_id = format!("01ARZ3NDEKTSV4RRFFQ69G{:04}", i);
            // 26-char ULID space; truncate/pad to 26 chars deterministically.
            let packet_id = if packet_id.len() >= 26 {
                packet_id[0..26].to_string()
            } else {
                format!("{packet_id:0>26}")
            };
            // 50 sessions across n packets so recent-sessions de-dup is
            // exercised. Same modulo distributes evenly.
            let session_id = format!("session-{:03}", i % 50);
            let repo_path = format!("/tmp/repo-{}", i % 10);
            // Synthetic timestamps — N seconds before now.
            let yaml_path = format!(".trail/sessions/{session_id}/packet-{i}.yml");
            let captured_at = format!("2026-01-01T00:00:00.{:06}Z", i);
            packet_stmt.execute([
                &packet_id as &dyn rusqlite::ToSql,
                &session_id,
                &repo_path,
                &captured_at,
                &yaml_path,
            ])?;
            // Each packet gets 4 claims, one per risk level — gives
            // realistic histogram distribution and ensures the risk filter
            // matches every packet.
            for (j, level) in levels.iter().enumerate() {
                let claim_id = format!("c-{packet_id}-{j}");
                let claim_text = format!("synthetic claim {j} for packet {i}");
                claim_stmt.execute(rusqlite::params![
                    claim_id,
                    packet_id,
                    claim_text,
                    level,
                    j as i64
                ])?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        migrations::apply_all(&mut c).unwrap();
        c
    }

    #[test]
    fn empty_db_returns_empty_results() {
        let c = fresh();
        let rows = query_trail(&c, &TrailFilter::default(), 50).unwrap();
        assert!(rows.is_empty());
        let sessions = query_recent_sessions(&c, 5).unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn seeded_db_returns_packets_and_claims() {
        let mut c = fresh();
        seed_stress_packets(&mut c, 10).unwrap();
        let rows = query_trail(&c, &TrailFilter::default(), 100).unwrap();
        assert_eq!(rows.len(), 10);
        // Each row should have one claim per level.
        for row in &rows {
            assert_eq!(row.low_count, 1, "row {:?}", row);
            assert_eq!(row.med_count, 1);
            assert_eq!(row.high_count, 1);
            assert_eq!(row.crit_count, 1);
        }
    }

    #[test]
    fn risk_filter_matches_only_selected_levels() {
        // F-CONV-2: drop the unused `mut`. rusqlite::Connection methods
        // (execute, prepare, query_row) take `&self`; `mut` is not needed
        // unless we reassign the binding itself.
        let c = fresh();
        // Insert one packet manually with only 'low' claims.
        c.execute(
            "INSERT INTO packets (packet_id, session_id, repo_path, captured_at, schema_version, yaml_path) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 's1', '/r', '2026-01-01T00:00:00Z', '0.1.1', '/tmp/x.yml')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO claims (claim_id, packet_id, claim_text, synthesis_mode, risk_level_agent, position) VALUES ('c1', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'x', 'mechanical', 'low', 0)",
            [],
        )
        .unwrap();

        // Filter for only 'crit' — should miss this packet.
        let rows = query_trail(
            &c,
            &TrailFilter {
                risk_levels: Some(vec!["crit".into()]),
                ..Default::default()
            },
            10,
        )
        .unwrap();
        assert!(rows.is_empty());

        // Filter for 'low' — should hit.
        let rows = query_trail(
            &c,
            &TrailFilter {
                risk_levels: Some(vec!["low".into()]),
                ..Default::default()
            },
            10,
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn time_window_filter_inclusive() {
        let mut c = fresh();
        seed_stress_packets(&mut c, 5).unwrap();
        // All seeded packets have prefix 2026-01-01T00:00:00.; an after
        // bound of 2025-12-31 keeps all; a before bound of 2025-12-31 drops all.
        let rows = query_trail(
            &c,
            &TrailFilter {
                captured_after: Some("2025-12-31T00:00:00Z".into()),
                ..Default::default()
            },
            10,
        )
        .unwrap();
        assert_eq!(rows.len(), 5);
        let rows = query_trail(
            &c,
            &TrailFilter {
                captured_before: Some("2025-12-31T00:00:00Z".into()),
                ..Default::default()
            },
            10,
        )
        .unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn has_redactions_filter() {
        let mut c = fresh();
        seed_stress_packets(&mut c, 3).unwrap();
        // Mark one packet as having redactions.
        let first_id: String = c
            .query_row("SELECT packet_id FROM packets ORDER BY captured_at DESC LIMIT 1", [], |r| r.get(0))
            .unwrap();
        c.execute(
            "INSERT INTO redaction_audit (packet_id, pattern_set_version, pattern_id, layer, match_count) VALUES (?1, '1.0', 'slack-token', 1, 2)",
            [&first_id],
        )
        .unwrap();
        let rows = query_trail(
            &c,
            &TrailFilter {
                has_redactions: Some(true),
                ..Default::default()
            },
            10,
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].packet_id, first_id);
        assert_eq!(rows[0].redaction_count, 1);
    }

    #[test]
    fn recent_sessions_dedupe_by_session_id() {
        let mut c = fresh();
        seed_stress_packets(&mut c, 100).unwrap();
        let sessions = query_recent_sessions(&c, 5).unwrap();
        assert_eq!(sessions.len(), 5);
        // 100 packets / 50 sessions = 2 packets per session.
        for s in &sessions {
            assert_eq!(s.packet_count, 2);
        }
    }

    /// Helper for search-filter tests: insert a packet with a chosen
    /// session_id + repo_path. Captured timestamp is incremented per call so
    /// ORDER BY captured_at DESC is deterministic.
    fn insert_packet(
        c: &Connection,
        packet_id: &str,
        session_id: &str,
        repo_path: &str,
        captured_at: &str,
    ) {
        c.execute(
            "INSERT INTO packets (packet_id, session_id, repo_path, captured_at, schema_version, yaml_path) \
             VALUES (?, ?, ?, ?, '0.1.1', ?)",
            rusqlite::params![
                packet_id,
                session_id,
                repo_path,
                captured_at,
                format!("/tmp/{packet_id}.yml"),
            ],
        )
        .unwrap();
    }

    /// F-CODE-1 regression test: the search filter must execute end-to-end
    /// (placeholder/param count must match) and return only matching rows.
    /// This test would have failed on the cycle-1 broken code where the
    /// filter emitted 2 `?` placeholders but bound only 1 parameter —
    /// rusqlite returns "Wrong number of parameters bound" before any row
    /// is yielded. Locks the contract: future regressions of the bind
    /// arity will trip here, NOT silently in production.
    #[test]
    fn search_filter_matches_session_or_repo() {
        let c = fresh();
        insert_packet(
            &c,
            "01ARZ3NDEKTSV4RRFFQ69G0001",
            "alpha-session",
            "/repos/normal",
            "2026-01-01T00:00:01Z",
        );
        insert_packet(
            &c,
            "01ARZ3NDEKTSV4RRFFQ69G0002",
            "beta-session",
            "/repos/alpha-repo",
            "2026-01-01T00:00:02Z",
        );
        insert_packet(
            &c,
            "01ARZ3NDEKTSV4RRFFQ69G0003",
            "gamma-session",
            "/repos/other",
            "2026-01-01T00:00:03Z",
        );

        // Search "alpha" hits #1 (session_id) AND #2 (repo_path); must NOT
        // hit #3.
        let rows = query_trail(
            &c,
            &TrailFilter {
                search: Some("alpha".into()),
                ..Default::default()
            },
            10,
        )
        .expect("search filter must execute (placeholder/param arity)");
        assert_eq!(rows.len(), 2, "search 'alpha' should hit 2 packets");
        let ids: Vec<&str> = rows.iter().map(|r| r.packet_id.as_str()).collect();
        assert!(ids.contains(&"01ARZ3NDEKTSV4RRFFQ69G0001"));
        assert!(ids.contains(&"01ARZ3NDEKTSV4RRFFQ69G0002"));
        assert!(!ids.contains(&"01ARZ3NDEKTSV4RRFFQ69G0003"));
    }

    /// F-CODE-1 regression test (single token only matches repo_path):
    /// independent verification that the OR-arm targeting repo_path is
    /// reached AND bound, not just session_id.
    #[test]
    fn search_filter_matches_repo_only_token() {
        let c = fresh();
        insert_packet(
            &c,
            "01ARZ3NDEKTSV4RRFFQ69G0010",
            "session-x",
            "/repos/billing-svc",
            "2026-01-01T00:00:01Z",
        );
        insert_packet(
            &c,
            "01ARZ3NDEKTSV4RRFFQ69G0011",
            "session-y",
            "/repos/auth-svc",
            "2026-01-01T00:00:02Z",
        );
        let rows = query_trail(
            &c,
            &TrailFilter {
                search: Some("billing".into()),
                ..Default::default()
            },
            10,
        )
        .expect("repo-only search must execute");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].packet_id, "01ARZ3NDEKTSV4RRFFQ69G0010");
    }

    /// F-CODE-1 regression test (search combined with another filter):
    /// proves the param sequence is correct when WHERE clauses pile up
    /// (after filter + redaction filter + search). Cycle-1 broke
    /// specifically because the `params.push()` arity was off-by-one;
    /// piling more parameters before/after exposes any cumulative
    /// off-by-one.
    #[test]
    fn search_filter_combines_with_other_filters() {
        let c = fresh();
        insert_packet(
            &c,
            "01ARZ3NDEKTSV4RRFFQ69G0020",
            "alpha-session-old",
            "/repos/foo",
            "2024-01-01T00:00:00Z",
        );
        insert_packet(
            &c,
            "01ARZ3NDEKTSV4RRFFQ69G0021",
            "alpha-session-new",
            "/repos/foo",
            "2026-06-01T00:00:00Z",
        );
        let rows = query_trail(
            &c,
            &TrailFilter {
                search: Some("alpha".into()),
                captured_after: Some("2026-01-01T00:00:00Z".into()),
                captured_before: Some("2026-12-31T00:00:00Z".into()),
                ..Default::default()
            },
            10,
        )
        .expect("search + time bounds must execute");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].packet_id, "01ARZ3NDEKTSV4RRFFQ69G0021");
    }

    /// F-SEC-1 regression test: LIKE wildcard chars (% and _) must be
    /// treated as DATA, not patterns. A user typing "100%_complete"
    /// should match repos literally containing that substring, not
    /// "everything starting with 100, then 0+ chars, then any single
    /// char, then complete".
    #[test]
    fn search_filter_escapes_like_wildcards() {
        let c = fresh();
        insert_packet(
            &c,
            "01ARZ3NDEKTSV4RRFFQ69G0030",
            "session-literal",
            "/repos/100%_complete",
            "2026-01-01T00:00:01Z",
        );
        insert_packet(
            &c,
            "01ARZ3NDEKTSV4RRFFQ69G0031",
            "session-decoy",
            "/repos/100abc_complete",
            "2026-01-01T00:00:02Z",
        );
        // Searching the literal "%_" must only match the literal — not
        // act as wildcards. If unescaped, the unescaped "%_" pattern would
        // ALSO match "/repos/100abc_complete" (% = "abc", _ = "_").
        let rows = query_trail(
            &c,
            &TrailFilter {
                search: Some("100%_complete".into()),
                ..Default::default()
            },
            10,
        )
        .expect("wildcard search must execute");
        assert_eq!(rows.len(), 1, "only literal-match row should hit");
        assert_eq!(rows[0].packet_id, "01ARZ3NDEKTSV4RRFFQ69G0030");
    }

    /// F-SEC-1 follow-up: searching the explicit escape character (`\`)
    /// must also work — the user's literal backslash should match a
    /// stored backslash.
    #[test]
    fn search_filter_escapes_backslash() {
        let c = fresh();
        insert_packet(
            &c,
            "01ARZ3NDEKTSV4RRFFQ69G0040",
            "session-bs",
            r"C:\repos\trail",
            "2026-01-01T00:00:01Z",
        );
        let rows = query_trail(
            &c,
            &TrailFilter {
                search: Some(r"\repos\".into()),
                ..Default::default()
            },
            10,
        )
        .expect("backslash search must execute");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].packet_id, "01ARZ3NDEKTSV4RRFFQ69G0040");
    }

    /// F-CODE-1 regression test: empty-string search is currently treated
    /// by the Rust handler as "Some(empty)" — should still execute (binds
    /// '%%' which matches everything). This test confirms NO param-arity
    /// error when search is bound. The TS layer drops empty/whitespace
    /// search before IPC; this test pins the Rust contract for the case
    /// a third-party caller passes an empty string.
    #[test]
    fn search_filter_empty_string_executes() {
        let c = fresh();
        insert_packet(
            &c,
            "01ARZ3NDEKTSV4RRFFQ69G0050",
            "any",
            "/r",
            "2026-01-01T00:00:01Z",
        );
        let rows = query_trail(
            &c,
            &TrailFilter {
                search: Some("".into()),
                ..Default::default()
            },
            10,
        )
        .expect("empty-string search must not raise param-arity error");
        // '%' LIKE '%%' matches all rows.
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn open_and_migrate_creates_db_and_schema() {
        let tmp = tempdir_for_test();
        let path = tmp.join("trail.db");
        let conn = open_and_migrate(&path).unwrap();
        let cnt: i64 = conn
            .query_row("SELECT COUNT(*) FROM packets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cnt, 0);
        // Re-open is idempotent.
        let conn2 = open_and_migrate(&path).unwrap();
        assert!(conn2.query_row("SELECT 1", [], |r| r.get::<_, i64>(0)).is_ok());
    }

    fn tempdir_for_test() -> PathBuf {
        let mut p = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("trail-db-test-{nanos}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    // -- Sprint 3a (gh#9 criterion 7): select_packet_meta -------------------

    #[test]
    fn select_packet_meta_returns_none_for_unknown_packet() {
        let c = fresh();
        let result = select_packet_meta(&c, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn select_packet_meta_returns_row_for_known_packet() {
        let c = fresh();
        c.execute(
            "INSERT INTO packets (packet_id, session_id, repo_path, captured_at, schema_version, yaml_path, parent_packet_id) \
             VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'session-001', '/r', '2026-05-09T00:00:00Z', '0.1.1', '.trail/sessions/session-001/packet-1.yml', NULL)",
            [],
        )
        .unwrap();
        let row = select_packet_meta(&c, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap().unwrap();
        assert_eq!(row.packet_id, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        assert_eq!(row.session_id, "session-001");
        assert_eq!(row.yaml_path, ".trail/sessions/session-001/packet-1.yml");
        assert_eq!(row.schema_version, "0.1.1");
        assert!(row.parent_packet_id.is_none());
    }

    #[test]
    fn select_packet_meta_preserves_parent_packet_id() {
        let c = fresh();
        // The schema does NOT enforce a FK on parent_packet_id (re-capture
        // chain may resolve to a packet on a different machine), but the
        // packets-table self-FK at FOREIGN KEYS=ON time would reject a
        // dangling parent on this DB. We insert both rows in order so the
        // chain is locally consistent.
        c.execute(
            "INSERT INTO packets (packet_id, session_id, repo_path, captured_at, schema_version, yaml_path, parent_packet_id) \
             VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAW', 'session-001', '/r', '2026-05-09T00:00:00Z', '0.1.1', '/tmp/p0.yml', NULL)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO packets (packet_id, session_id, repo_path, captured_at, schema_version, yaml_path, parent_packet_id) \
             VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'session-001', '/r', '2026-05-09T01:00:00Z', '0.1.1', '/tmp/p.yml', '01ARZ3NDEKTSV4RRFFQ69G5FAW')",
            [],
        )
        .unwrap();
        let row = select_packet_meta(&c, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap().unwrap();
        assert_eq!(
            row.parent_packet_id.as_deref(),
            Some("01ARZ3NDEKTSV4RRFFQ69G5FAW")
        );
    }

    // -- Sprint 4 cycle-1.5 F2: select_packet_id_by_path -------------------

    #[test]
    fn select_packet_id_by_path_suffix_match_succeeds() {
        let c = fresh();
        c.execute(
            "INSERT INTO packets (packet_id, session_id, repo_path, captured_at, schema_version, yaml_path) \
             VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'session-001', '/r', '2026-05-09T00:00:00Z', '0.1.1', '.trail/sessions/session-001/packet-1.yml')",
            [],
        )
        .unwrap();
        // Watcher hands an absolute path.
        let abs = std::path::PathBuf::from(
            "/Users/x/proj/.trail/sessions/session-001/packet-1.yml",
        );
        let pid = select_packet_id_by_path(&c, &abs).unwrap();
        assert_eq!(pid.as_deref(), Some("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
    }

    #[test]
    fn select_packet_id_by_path_direct_match_succeeds() {
        let c = fresh();
        c.execute(
            "INSERT INTO packets (packet_id, session_id, repo_path, captured_at, schema_version, yaml_path) \
             VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'session-001', '/r', '2026-05-09T00:00:00Z', '0.1.1', '/abs/path/packet-1.yml')",
            [],
        )
        .unwrap();
        let abs = std::path::PathBuf::from("/abs/path/packet-1.yml");
        let pid = select_packet_id_by_path(&c, &abs).unwrap();
        assert_eq!(pid.as_deref(), Some("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
    }

    #[test]
    fn select_packet_id_by_path_returns_none_for_unknown() {
        let c = fresh();
        let abs = std::path::PathBuf::from(
            "/some/arbitrary/path/that/is/not/in/db.yml",
        );
        let pid = select_packet_id_by_path(&c, &abs).unwrap();
        assert!(pid.is_none());
    }

    #[test]
    fn select_packet_id_by_path_rejects_pathological_byte_suffix() {
        // A row with yaml_path ".trail/sessions/sid/packet-1.yml" must NOT
        // match an absolute path that ends with that string but lacks a
        // path-separator boundary (e.g., a synthetic
        // "/some/x.trail/sessions/sid/packet-1.yml" where 'x' is the
        // boundary char). Without the boundary check, a strstr-style
        // suffix would falsely return the wrong packet_id.
        let c = fresh();
        c.execute(
            "INSERT INTO packets (packet_id, session_id, repo_path, captured_at, schema_version, yaml_path) \
             VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'session-001', '/r', '2026-05-09T00:00:00Z', '0.1.1', '.trail/sessions/sid/packet-1.yml')",
            [],
        )
        .unwrap();
        let abs = std::path::PathBuf::from(
            "/some/x.trail/sessions/sid/packet-1.yml",
        );
        let pid = select_packet_id_by_path(&c, &abs).unwrap();
        assert!(
            pid.is_none(),
            "byte-suffix without path-separator boundary must NOT match"
        );
    }

    // -----------------------------------------------------------------
    // Cycle-3 C3-S-TR-002: pin DbError::Poisoned Display message. The
    // variant is currently `#[allow(dead_code)]` (poisoned-mutex handling
    // lives inline at the call site via watcher::abort_on_poison), but
    // its Display template is operator-facing surface for when callers
    // start surfacing typed errors. A silent rewording would break log
    // greps and runbooks.
    // -----------------------------------------------------------------

    #[test]
    fn db_error_poisoned_display_pins_message_format() {
        let err = DbError::Poisoned;
        assert_eq!(err.to_string(), "db connection mutex poisoned");
    }
}
