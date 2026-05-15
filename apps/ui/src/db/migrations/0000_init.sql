-- Trail v0.1 — initial libSQL schema
-- B5 §7.1: 7 tables, 13 indexes, 2 audit-log triggers.
-- Hand-rolled (not drizzle-kit-generated) — see drizzle.config.ts comment
-- and src/db/schema.ts header for the migration-model rationale.
-- This file is committed; subsequent migrations live in the same directory
-- and are tracked in `meta/_journal.json` per drizzle-kit's convention.

CREATE TABLE IF NOT EXISTS packets (
  packet_id          TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  parent_packet_id   TEXT REFERENCES packets(packet_id),
  repo_path          TEXT NOT NULL,
  captured_at        TEXT NOT NULL,
  schema_version     TEXT NOT NULL,
  yaml_path          TEXT NOT NULL,
  last_known_hash    TEXT,
  libsql_dirty       INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_packets_session  ON packets(session_id);
CREATE INDEX IF NOT EXISTS idx_packets_captured ON packets(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_packets_parent   ON packets(parent_packet_id);

CREATE TABLE IF NOT EXISTS claims (
  claim_id                              TEXT PRIMARY KEY,
  packet_id                             TEXT NOT NULL REFERENCES packets(packet_id) ON DELETE CASCADE,
  claim_text                            TEXT NOT NULL,
  synthesis_mode                        TEXT NOT NULL,
  risk_level_agent                      TEXT NOT NULL,
  risk_rationale_agent                  TEXT,
  risk_level_creator_override           TEXT,
  risk_reason_creator_override          TEXT,
  risk_creator_override_at              TEXT,
  risk_creator_override_by              TEXT,
  risk_level_reviewer_override          TEXT,
  risk_reason_reviewer_override         TEXT,
  risk_reviewer_override_at             TEXT,
  risk_reviewer_override_by             TEXT,
  position                              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_packet ON claims(packet_id, position);

CREATE TABLE IF NOT EXISTS claim_evidence (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id          TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  evidence_type     TEXT NOT NULL,
  evidence_ref      TEXT NOT NULL,
  evidence_payload  TEXT,
  position          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_claim ON claim_evidence(claim_id, position);

CREATE TABLE IF NOT EXISTS approval_trail (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  packet_id    TEXT NOT NULL REFERENCES packets(packet_id) ON DELETE CASCADE,
  claim_id     TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  decision     TEXT NOT NULL,
  reason       TEXT,
  decided_by   TEXT NOT NULL,
  decided_at   TEXT NOT NULL,
  position     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trail_packet ON approval_trail(packet_id, position);
CREATE INDEX IF NOT EXISTS idx_trail_claim  ON approval_trail(claim_id, decided_at);

CREATE TABLE IF NOT EXISTS redaction_audit (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  packet_id              TEXT NOT NULL REFERENCES packets(packet_id) ON DELETE CASCADE,
  pattern_set_version    TEXT NOT NULL,
  pattern_id             TEXT NOT NULL,
  layer                  INTEGER NOT NULL,
  match_count            INTEGER NOT NULL,
  locations_summary      TEXT
);
CREATE INDEX IF NOT EXISTS idx_redact_packet ON redaction_audit(packet_id);

CREATE TABLE IF NOT EXISTS posted_to_pr_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  packet_id   TEXT NOT NULL REFERENCES packets(packet_id) ON DELETE CASCADE,
  pr_url      TEXT NOT NULL,
  pr_number   INTEGER NOT NULL,
  body_hash   TEXT NOT NULL,
  posted_at   TEXT NOT NULL,
  posted_by   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posted_packet ON posted_to_pr_history(packet_id, posted_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT NOT NULL,
  packet_id    TEXT REFERENCES packets(packet_id),
  details      TEXT NOT NULL,
  prev_hash    TEXT,
  row_hash     TEXT NOT NULL,
  occurred_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(occurred_at DESC);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(FAIL, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(FAIL, 'audit_log is append-only');
END;
