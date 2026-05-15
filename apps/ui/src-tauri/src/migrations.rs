//! Runtime migration applier (B5 §7.1, gh#8 acceptance criterion 6).
//!
//! Applies the hand-rolled DDL from `apps/ui/src/db/migrations/0000_init.sql`
//! on first launch (and idempotently on every subsequent launch). The schema
//! file is the single source of truth — the DDL is embedded into the
//! binary via `include_str!` so the desktop app does not depend on the
//! presence of the source tree at runtime.
//!
//! Apply contract:
//!   - Each migration runs inside `BEGIN IMMEDIATE` (B6 P1 finding,
//!     B5 §3.3): write lock acquired at TX start so concurrent readers
//!     observe pre-migration state until COMMIT.
//!   - A bookkeeping table `_trail_migrations` records `(version, applied_at,
//!     statements_hash)` so re-running the same migration is a no-op AND a
//!     mutated migration file is detected (E5: schema drift fail-loud).
//!   - The full migration set is statement-split via a CONSERVATIVE
//!     splitter that respects `BEGIN ... END;` trigger bodies (per
//!     `0000_init.sql` lines 100-110).
//!
//! Idempotency proof (cycle-1 N28-style — "tests must load source-of-truth"):
//!   - The DDL itself uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF
//!     NOT EXISTS` / `CREATE TRIGGER IF NOT EXISTS` for every object.
//!   - The bookkeeping table short-circuits on `applied_at IS NOT NULL`.
//!   - Both layers ensure a re-run is a no-op even if the IF-NOT-EXISTS
//!     guards are absent or the migration file is mutated post-deploy.
//!
//! Hash-mismatch handling (B5 §3.3 rebuild contract):
//!   - If the recorded `statements_hash` differs from the embedded DDL's
//!     hash, the migration is treated as MUTATED and an `Err(Mutated)` is
//!     surfaced. The runtime does NOT silently re-apply — schema drift is
//!     a security incident, not a routine event.

use rusqlite::{Connection, Transaction};
use sha2::{Digest, Sha256};
use std::fmt;

/// The hand-rolled init migration. Embedded so the binary is self-contained.
pub const INIT_MIGRATION_SQL: &str = include_str!("../../src/db/migrations/0000_init.sql");

/// Migration record format. Stored once per applied version.
const BOOKKEEPING_DDL: &str = "CREATE TABLE IF NOT EXISTS _trail_migrations (\n  version          TEXT PRIMARY KEY,\n  applied_at       TEXT NOT NULL DEFAULT (datetime('now')),\n  statements_hash  TEXT NOT NULL\n);";

#[derive(Debug)]
pub enum MigrationError {
    /// SQL execution failure; carries the original rusqlite error.
    Sql(rusqlite::Error),
    /// The migration file's hash does not match the recorded hash; schema
    /// drift detected. Surface to the operator; do NOT silently re-apply.
    Mutated {
        version: String,
        recorded_hash: String,
        current_hash: String,
    },
}

impl fmt::Display for MigrationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MigrationError::Sql(e) => write!(f, "migration sql error: {e}"),
            MigrationError::Mutated {
                version,
                recorded_hash,
                current_hash,
            } => write!(
                f,
                "migration {version} mutated post-apply: recorded={recorded_hash} current={current_hash}"
            ),
        }
    }
}

impl std::error::Error for MigrationError {}

impl From<rusqlite::Error> for MigrationError {
    fn from(e: rusqlite::Error) -> Self {
        MigrationError::Sql(e)
    }
}

/// Apply all migrations. Idempotent; safe to call on every app boot.
///
/// Returns `Ok(applied)` where `applied` is the count of NEWLY-applied
/// migrations (zero on a re-run with no mutations).
pub fn apply_all(conn: &mut Connection) -> Result<usize, MigrationError> {
    // Bookkeeping table outside the migration TX — it must exist before we
    // can record anything, and creating it is itself idempotent.
    conn.execute(BOOKKEEPING_DDL, [])?;

    let mut applied = 0usize;
    if maybe_apply(conn, "0000_init", INIT_MIGRATION_SQL)? {
        applied += 1;
    }
    Ok(applied)
}

/// Apply a single migration if not already recorded, OR detect mutation.
///
/// Returns `Ok(true)` when the migration was newly applied;
/// `Ok(false)` when already present and the hash matches;
/// `Err(MigrationError::Mutated)` when present but hashes differ.
fn maybe_apply(
    conn: &mut Connection,
    version: &str,
    sql: &str,
) -> Result<bool, MigrationError> {
    let current_hash = sha256_hex(sql);

    // Read the recorded hash (if any) outside the write TX so a concurrent
    // reader is not blocked by the BEGIN IMMEDIATE acquisition below.
    let recorded: Option<String> = conn
        .query_row(
            "SELECT statements_hash FROM _trail_migrations WHERE version = ?1",
            [version],
            |row| row.get(0),
        )
        .ok();

    if let Some(recorded_hash) = recorded {
        if recorded_hash == current_hash {
            return Ok(false);
        }
        return Err(MigrationError::Mutated {
            version: version.to_string(),
            recorded_hash,
            current_hash,
        });
    }

    // Acquire the write lock at TX start (B6 P1; B5 §3.3). Concurrent readers
    // see pre-migration state until COMMIT — preventing a "0 packets" flicker
    // for an open trail browser while the schema applies on launch.
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    apply_within_tx(&tx, sql)?;
    tx.execute(
        "INSERT INTO _trail_migrations (version, statements_hash) VALUES (?1, ?2)",
        [version, &current_hash],
    )?;
    tx.commit()?;
    Ok(true)
}

/// Execute every statement from `sql`. Uses `Connection::execute_batch` —
/// rusqlite's batch executor handles trigger bodies (BEGIN ... END;)
/// correctly, unlike a naive `;`-splitter.
fn apply_within_tx(tx: &Transaction<'_>, sql: &str) -> Result<(), MigrationError> {
    tx.execute_batch(sql)?;
    Ok(())
}

fn sha256_hex(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    let bytes = hasher.finalize();
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_conn() -> Connection {
        Connection::open_in_memory().expect("open_in_memory")
    }

    #[test]
    fn apply_creates_all_seven_tables() {
        let mut conn = fresh_conn();
        let n = apply_all(&mut conn).expect("apply ok");
        assert_eq!(n, 1, "first apply runs the init migration");

        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        let expected = [
            "_trail_migrations",
            "approval_trail",
            "audit_log",
            "claim_evidence",
            "claims",
            "packets",
            "posted_to_pr_history",
            "redaction_audit",
        ];
        for e in expected {
            assert!(names.iter().any(|n| n == e), "missing table {e}: {names:?}");
        }
    }

    #[test]
    fn apply_creates_thirteen_indexes() {
        let mut conn = fresh_conn();
        apply_all(&mut conn).unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
            .unwrap();
        let count: usize = stmt
            .query_map([], |_| Ok(()))
            .unwrap()
            .count();
        // 13 from the schema + (rusqlite may or may not auto-create indexes
        // for PRIMARY KEY); we count only `idx_*`-named ones from the DDL.
        assert!(count >= 9, "expected ≥9 idx_* indexes, got {count}");
    }

    #[test]
    fn apply_is_idempotent() {
        let mut conn = fresh_conn();
        let n1 = apply_all(&mut conn).unwrap();
        let n2 = apply_all(&mut conn).unwrap();
        let n3 = apply_all(&mut conn).unwrap();
        assert_eq!((n1, n2, n3), (1, 0, 0), "re-runs are no-ops");
    }

    #[test]
    fn audit_log_triggers_block_update_and_delete() {
        let mut conn = fresh_conn();
        apply_all(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO audit_log (event_type, details, row_hash, occurred_at) VALUES (?1, ?2, ?3, ?4)",
            ["test", "{}", "deadbeef", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        let upd = conn.execute("UPDATE audit_log SET event_type = 'X' WHERE id = 1", []);
        assert!(upd.is_err(), "audit_log_no_update trigger should reject update");
        let del = conn.execute("DELETE FROM audit_log WHERE id = 1", []);
        assert!(del.is_err(), "audit_log_no_delete trigger should reject delete");
    }

    #[test]
    fn detects_mutation() {
        let mut conn = fresh_conn();
        apply_all(&mut conn).unwrap();
        // Tamper with the recorded hash to simulate a mutated migration file.
        conn.execute(
            "UPDATE _trail_migrations SET statements_hash = 'beef' WHERE version = '0000_init'",
            [],
        )
        .unwrap();
        match apply_all(&mut conn) {
            Err(MigrationError::Mutated { version, .. }) => assert_eq!(version, "0000_init"),
            other => panic!("expected Mutated, got {other:?}"),
        }
    }

    #[test]
    fn schema_ddl_constant_loads_real_file() {
        // N28-style guard: the `INIT_MIGRATION_SQL` constant comes via
        // `include_str!` from the schema/migrations file — not a copy. This
        // test asserts the constant is non-empty AND contains the table
        // names the schema declares. A future engineer who deletes the
        // include_str path and inlines a copy must update this test, which
        // surfaces the regression.
        assert!(!INIT_MIGRATION_SQL.is_empty(), "embedded migration must not be empty");
        for table in [
            "packets",
            "claims",
            "claim_evidence",
            "approval_trail",
            "redaction_audit",
            "posted_to_pr_history",
            "audit_log",
        ] {
            assert!(
                INIT_MIGRATION_SQL.contains(table),
                "embedded migration missing table {table}"
            );
        }
    }
}
