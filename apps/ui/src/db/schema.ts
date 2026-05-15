/**
 * Trail libSQL schema (B5 §7.1).
 *
 * 7 tables + 13 indexes + 2 audit-log triggers (append-only enforcement).
 *
 * Migration model (per PR #6 cycle-1 review F9):
 *   This file is the TS source-of-truth used by query code via drizzle-orm.
 *   The actual database initialisation is driven by the hand-rolled DDL in
 *   `migrations/0000_init.sql`, applied at boot by Sprint 2's libSQL boot
 *   path. The filename + meta/_journal.json conform to drizzle-kit's
 *   convention so a future move to drizzle-kit-generated migrations does
 *   not require renumbering. The `db:generate` npm script is deliberately
 *   absent in v0.1 (Sprint 1) — schema authoring runs through this TS file
 *   plus a manually-written DDL companion until the schema stabilises.
 *
 * Hash chain: see `audit-log-hash.ts` for the length-prefix wire format.
 */
import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const packets = sqliteTable(
  'packets',
  {
    packet_id: text('packet_id').primaryKey(),
    session_id: text('session_id').notNull(),
    parent_packet_id: text('parent_packet_id'),
    repo_path: text('repo_path').notNull(),
    captured_at: text('captured_at').notNull(),
    schema_version: text('schema_version').notNull(),
    yaml_path: text('yaml_path').notNull(),
    last_known_hash: text('last_known_hash'),
    libsql_dirty: integer('libsql_dirty').notNull().default(0),
    created_at: text('created_at').notNull().default(sql`(datetime('now'))`),
    updated_at: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    bySession: index('idx_packets_session').on(table.session_id),
    byCaptured: index('idx_packets_captured').on(table.captured_at),
    byParent: index('idx_packets_parent').on(table.parent_packet_id),
  }),
);

export const claims = sqliteTable(
  'claims',
  {
    claim_id: text('claim_id').primaryKey(),
    packet_id: text('packet_id')
      .notNull()
      .references(() => packets.packet_id, { onDelete: 'cascade' }),
    claim_text: text('claim_text').notNull(),
    synthesis_mode: text('synthesis_mode').notNull(),
    risk_level_agent: text('risk_level_agent').notNull(),
    risk_rationale_agent: text('risk_rationale_agent'),
    risk_level_creator_override: text('risk_level_creator_override'),
    risk_reason_creator_override: text('risk_reason_creator_override'),
    risk_creator_override_at: text('risk_creator_override_at'),
    risk_creator_override_by: text('risk_creator_override_by'),
    risk_level_reviewer_override: text('risk_level_reviewer_override'),
    risk_reason_reviewer_override: text('risk_reason_reviewer_override'),
    risk_reviewer_override_at: text('risk_reviewer_override_at'),
    risk_reviewer_override_by: text('risk_reviewer_override_by'),
    position: integer('position').notNull(),
  },
  (table) => ({
    byPacket: index('idx_claims_packet').on(table.packet_id, table.position),
  }),
);

export const claimEvidence = sqliteTable(
  'claim_evidence',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    claim_id: text('claim_id')
      .notNull()
      .references(() => claims.claim_id, { onDelete: 'cascade' }),
    evidence_type: text('evidence_type').notNull(),
    evidence_ref: text('evidence_ref').notNull(),
    evidence_payload: text('evidence_payload'),
    position: integer('position').notNull(),
  },
  (table) => ({
    byClaim: index('idx_evidence_claim').on(table.claim_id, table.position),
  }),
);

export const approvalTrail = sqliteTable(
  'approval_trail',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    packet_id: text('packet_id')
      .notNull()
      .references(() => packets.packet_id, { onDelete: 'cascade' }),
    claim_id: text('claim_id')
      .notNull()
      .references(() => claims.claim_id, { onDelete: 'cascade' }),
    decision: text('decision').notNull(),
    reason: text('reason'),
    decided_by: text('decided_by').notNull(),
    decided_at: text('decided_at').notNull(),
    position: integer('position').notNull(),
  },
  (table) => ({
    byPacket: index('idx_trail_packet').on(table.packet_id, table.position),
    byClaim: index('idx_trail_claim').on(table.claim_id, table.decided_at),
  }),
);

export const redactionAudit = sqliteTable(
  'redaction_audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    packet_id: text('packet_id')
      .notNull()
      .references(() => packets.packet_id, { onDelete: 'cascade' }),
    pattern_set_version: text('pattern_set_version').notNull(),
    pattern_id: text('pattern_id').notNull(),
    layer: integer('layer').notNull(),
    match_count: integer('match_count').notNull(),
    locations_summary: text('locations_summary'),
  },
  (table) => ({
    byPacket: index('idx_redact_packet').on(table.packet_id),
  }),
);

export const postedToPrHistory = sqliteTable(
  'posted_to_pr_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    packet_id: text('packet_id')
      .notNull()
      .references(() => packets.packet_id, { onDelete: 'cascade' }),
    pr_url: text('pr_url').notNull(),
    pr_number: integer('pr_number').notNull(),
    body_hash: text('body_hash').notNull(),
    posted_at: text('posted_at').notNull(),
    posted_by: text('posted_by').notNull(),
  },
  (table) => ({
    byPacket: index('idx_posted_packet').on(table.packet_id, table.posted_at),
  }),
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    event_type: text('event_type').notNull(),
    packet_id: text('packet_id').references(() => packets.packet_id),
    details: text('details').notNull(),
    prev_hash: text('prev_hash'),
    row_hash: text('row_hash').notNull(),
    occurred_at: text('occurred_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    byTime: index('idx_audit_time').on(table.occurred_at),
  }),
);

export const SCHEMA_DDL = {
  /**
   * Append-only triggers — Drizzle does not currently express SQLite triggers
   * via its DSL; we ship them as raw DDL alongside the migration.
   */
  triggers: [
    `CREATE TRIGGER IF NOT EXISTS audit_log_no_update
       BEFORE UPDATE ON audit_log
       BEGIN SELECT RAISE(FAIL, 'audit_log is append-only'); END;`,
    `CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
       BEFORE DELETE ON audit_log
       BEGIN SELECT RAISE(FAIL, 'audit_log is append-only'); END;`,
  ] as const,
} as const;
