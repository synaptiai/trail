// SQLite-backed StorageWriter. Best-effort writes per spec §3 step 10i.
// better-sqlite3 + drizzle-orm are optional dependencies — if missing (e.g., on
// platforms without prebuilt binaries), `createSqliteStorageWriter()` throws
// `StorageUnavailableError` and the caller falls back to NoopStorageWriter.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Claim, Packet } from "../packet/types.js";
import type { Evidence, RedactionAudit, StorageWriter } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS packets (
  packet_id TEXT PRIMARY KEY,
  parent_packet_id TEXT,
  session_id TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  packet_yaml TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT NOT NULL,
  packet_id TEXT NOT NULL,
  text TEXT NOT NULL,
  synthesis_mode TEXT NOT NULL,
  PRIMARY KEY (claim_id, packet_id)
);
CREATE TABLE IF NOT EXISTS evidence (
  packet_id TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (packet_id, ref_id)
);
CREATE TABLE IF NOT EXISTS redaction_audit (
  packet_id TEXT NOT NULL,
  pattern_set_version TEXT NOT NULL,
  pattern_set_origin TEXT NOT NULL,
  redactions_applied INTEGER NOT NULL,
  by_pattern_json TEXT NOT NULL,
  validation_errors_json TEXT NOT NULL,
  PRIMARY KEY (packet_id)
);
`;

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

export class SqliteStorageWriter implements StorageWriter {
  // The native sqlite handle is held opaquely to avoid hard-coupling our public
  // type surface to better-sqlite3 (an optional dependency).
  private readonly db: {
    pragma(s: string): unknown;
    exec(s: string): unknown;
    prepare(s: string): { run(...args: unknown[]): unknown };
    transaction<T extends () => void>(fn: T): T;
    close(): void;
  };

  private constructor(db: SqliteStorageWriter["db"]) {
    this.db = db;
  }

  static async create(dbPath: string): Promise<SqliteStorageWriter> {
    let DatabaseCtor: new (path: string) => SqliteStorageWriter["db"];
    try {
      const mod = await import("better-sqlite3");
      DatabaseCtor = (mod.default ?? mod) as new (path: string) => SqliteStorageWriter["db"];
    } catch (err) {
      throw new StorageUnavailableError(`better-sqlite3 not available: ${(err as Error).message}`);
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseCtor(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    return new SqliteStorageWriter(db);
  }

  async writePacket(
    packet: Packet,
    redactionAudit: RedactionAudit,
    claims: Claim[],
    evidence: Evidence[]
  ): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO packets (packet_id, parent_packet_id, session_id, generated_at, packet_yaml) VALUES (?, ?, ?, ?, ?)"
        )
        .run(
          packet._meta.packet_id,
          packet._meta.parent_packet_id,
          packet.agent_session.session_id,
          packet._meta.generated_at,
          ""
        );
      const claimStmt = this.db.prepare(
        "INSERT OR REPLACE INTO claims (claim_id, packet_id, text, synthesis_mode) VALUES (?, ?, ?, ?)"
      );
      for (const c of claims) {
        claimStmt.run(c.stable_id ?? c.id, packet._meta.packet_id, c.text, c.synthesis_mode);
      }
      const evStmt = this.db.prepare(
        "INSERT OR REPLACE INTO evidence (packet_id, ref_id, kind, payload_json) VALUES (?, ?, ?, ?)"
      );
      for (const e of evidence) {
        evStmt.run(packet._meta.packet_id, e.id, e.kind, JSON.stringify(e));
      }
      this.db
        .prepare(
          "INSERT OR REPLACE INTO redaction_audit (packet_id, pattern_set_version, pattern_set_origin, redactions_applied, by_pattern_json, validation_errors_json) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(
          packet._meta.packet_id,
          redactionAudit.pattern_set_version,
          redactionAudit.pattern_set_origin ?? "bundled",
          redactionAudit.redactions_applied,
          JSON.stringify(redactionAudit.redactions_by_pattern),
          JSON.stringify(redactionAudit.validation_errors)
        );
    });
    tx();
  }

  close(): void {
    this.db.close();
  }
}
