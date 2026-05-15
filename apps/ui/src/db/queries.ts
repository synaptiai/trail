/**
 * Drizzle query helpers — Trail browser read path (gh#8 criteria 1, 6, 7).
 *
 * The actual SQL execution lives in Rust (`apps/ui/src-tauri/src/db.rs`)
 * because the Tauri runtime owns the libSQL connection. The TS-side query
 * helpers are:
 *   1. **Type contracts** for the rows we expect from `query_trail` /
 *      `query_recent_sessions` — kept in lock-step with the Rust struct
 *      definitions via the `*Schema` zod schemas in this file.
 *   2. **Drizzle SELECT builders** that emit the exact same SQL the Rust
 *      handler runs. These are NOT executed at runtime; they exist so:
 *        a) Static type-checking against `apps/ui/src/db/schema.ts` catches
 *           a column rename in either layer.
 *        b) A future move to a TS-driver libSQL (when the embedded library
 *           ships a Wasm port) lets the same query builders run on either
 *           side without rewriting.
 *
 * Both layers MUST agree on the wire shape (criterion 10 — no mocks/stubs).
 */
import { z } from 'zod';
import { and, desc, eq, gte, lte, like, or, sql } from 'drizzle-orm';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import { packets, claims, redactionAudit, postedToPrHistory } from './schema';
import type { RiskLevel, TrailFilter } from '@/ipc/contract';

// ---------------------------------------------------------------------------
// Wire shapes — MUST match Rust SidebarRow / RecentSession structs.
// ---------------------------------------------------------------------------

export const sidebarRowSchema = z.object({
  packet_id: z.string(),
  session_id: z.string(),
  display_name: z.string(),
  captured_at: z.string(),
  low_count: z.number().int().nonnegative(),
  med_count: z.number().int().nonnegative(),
  high_count: z.number().int().nonnegative(),
  crit_count: z.number().int().nonnegative(),
  redaction_count: z.number().int().nonnegative(),
  posted_to_pr_count: z.number().int().nonnegative(),
});
export type SidebarRow = z.infer<typeof sidebarRowSchema>;

export const recentSessionSchema = z.object({
  session_id: z.string(),
  latest_packet_id: z.string(),
  packet_count: z.number().int().positive(),
  latest_captured_at: z.string(),
});
export type RecentSession = z.infer<typeof recentSessionSchema>;

export const queryTrailResponseSchema = z.object({
  packets: z.array(sidebarRowSchema),
  next_cursor: z.string().optional(),
});
export type QueryTrailResponse = z.infer<typeof queryTrailResponseSchema>;

export const queryRecentSessionsResponseSchema = z.array(recentSessionSchema);
export type QueryRecentSessionsResponse = z.infer<typeof queryRecentSessionsResponseSchema>;

// ---------------------------------------------------------------------------
// Drizzle SELECT builders — type-checked against schema.ts.
//
// These build the SQL the Rust `db::query_trail` runs. They are static
// reference: a unit test asserts the shape of the WHERE clauses produced
// by the builder matches the column names + filter semantics the Rust
// handler implements (cycle-1 N15 lesson — verify the sidebar actually
// reads from libSQL, not just renders an empty list).
// ---------------------------------------------------------------------------

interface TrailQueryDescriptor {
  /** Filter clauses (post-typecheck) — composed for the WHERE / HAVING. */
  whereClauses: SQL[];
  havingClauses: SQL[];
  limit: number;
}

/**
 * Compute the WHERE / HAVING clauses for `query_trail` from a filter.
 * Returns a TrailQueryDescriptor; the caller composes the final SELECT.
 *
 * The risk-level filter sits on the HAVING clause (post-aggregation):
 * a packet matches if it has ≥1 claim at any of the selected levels. This
 * mirrors B4 §3.5 ("[risk: HIGH×3]" — chip shows count when set).
 */
export function buildTrailQuery(filter: TrailFilter, limit: number): TrailQueryDescriptor {
  const whereClauses: SQL[] = [];
  const havingClauses: SQL[] = [];

  if (filter.captured_after) {
    whereClauses.push(gte(packets.captured_at, filter.captured_after));
  }
  if (filter.captured_before) {
    whereClauses.push(lte(packets.captured_at, filter.captured_before));
  }
  if (filter.has_redactions === true) {
    whereClauses.push(
      sql`EXISTS (SELECT 1 FROM ${redactionAudit} r WHERE r.packet_id = ${packets.packet_id})`,
    );
  }
  if (filter.search && filter.search.trim().length > 0) {
    const needle = `%${filter.search.trim()}%`;
    const repoMatch = like(packets.repo_path, needle);
    const sessionMatch = like(packets.session_id, needle);
    const eitherMatch = or(repoMatch, sessionMatch);
    if (eitherMatch) whereClauses.push(eitherMatch);
  }

  if (filter.risk_levels && filter.risk_levels.length > 0) {
    const levelClauses: SQL[] = filter.risk_levels.map((level) => havingClauseForLevel(level));
    havingClauses.push(sql`(${joinClausesWithOr(levelClauses)})`);
  }

  return { whereClauses, havingClauses, limit };
}

function havingClauseForLevel(level: RiskLevel): SQL {
  // Mirrors Rust db.rs query_trail HAVING expressions (low_count > 0, etc.).
  // Encoded via raw sql`` because the count expressions are computed
  // SUM(CASE WHEN ...) not real columns.
  switch (level) {
    case 'low':
      return sql`SUM(CASE WHEN COALESCE(${claims.risk_level_reviewer_override}, ${claims.risk_level_creator_override}, ${claims.risk_level_agent}) = 'low' THEN 1 ELSE 0 END) > 0`;
    case 'med':
      return sql`SUM(CASE WHEN COALESCE(${claims.risk_level_reviewer_override}, ${claims.risk_level_creator_override}, ${claims.risk_level_agent}) = 'med' THEN 1 ELSE 0 END) > 0`;
    case 'high':
      return sql`SUM(CASE WHEN COALESCE(${claims.risk_level_reviewer_override}, ${claims.risk_level_creator_override}, ${claims.risk_level_agent}) = 'high' THEN 1 ELSE 0 END) > 0`;
    case 'crit':
      return sql`SUM(CASE WHEN COALESCE(${claims.risk_level_reviewer_override}, ${claims.risk_level_creator_override}, ${claims.risk_level_agent}) = 'crit' THEN 1 ELSE 0 END) > 0`;
  }
}

function joinClausesWithOr(parts: SQL[]): SQL {
  if (parts.length === 0) return sql`1=1`;
  if (parts.length === 1) return parts[0]!;
  // drizzle's or() takes a variadic list; fall back to manual concat.
  let acc: SQL = parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    acc = sql`${acc} OR ${parts[i]!}`;
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Pure helper — applied client-side over the rows returned by IPC.
// ---------------------------------------------------------------------------

/**
 * Determine the dominant risk level for a sidebar row.
 *
 * Priority: crit > high > med > low. Returns null if the row has no claims
 * (e.g., a freshly-captured packet that has not yet been classified).
 *
 * Used by `<TrailSidebar>` to render the row's risk pigment (B4 §3.2).
 */
export function dominantRisk(row: SidebarRow): RiskLevel | null {
  if (row.crit_count > 0) return 'crit';
  if (row.high_count > 0) return 'high';
  if (row.med_count > 0) return 'med';
  if (row.low_count > 0) return 'low';
  return null;
}

/**
 * Time-cluster a sidebar row by `captured_at`. Returns one of:
 *   today | yesterday | this-week | older
 *
 * Used by the sidebar to render the time-cluster dividers (B4 §3.1).
 */
export function timeCluster(
  capturedAtIso: string,
  now: Date = new Date(),
): 'today' | 'yesterday' | 'this-week' | 'older' {
  const captured = new Date(capturedAtIso);
  if (Number.isNaN(captured.getTime())) return 'older';
  const ms = now.getTime() - captured.getTime();
  const oneDay = 24 * 60 * 60 * 1000;
  // Local-day comparison: align both timestamps to local-day midnight.
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - 7);
  if (captured >= startOfToday) return 'today';
  if (captured >= startOfYesterday) return 'yesterday';
  if (captured >= startOfWeek) return 'this-week';
  // Fall through; ms used to keep the variable live for older buckets.
  void ms;
  void oneDay;
  return 'older';
}

/**
 * Format a row's age relative to `now`. Examples: `2h`, `3 days`, `Apr 12`.
 * Mirrors B4 §3.2 ("Age: format `2h` / `1 day` / `3 days` / `Apr 12`").
 */
export function formatAge(capturedAtIso: string, now: Date = new Date()): string {
  const captured = new Date(capturedAtIso);
  if (Number.isNaN(captured.getTime())) return '—';
  const ms = now.getTime() - captured.getTime();
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (hours < 1) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days === 1) return `1 day`;
  if (days < 7) return `${days} days`;
  // Older — short month + day, en-US locale (no year for compactness).
  // Matches B4 §3.2's `Apr 12` example.
  return captured.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Sprint 3a (gh#9 criterion 7): packet-by-id metadata + path lookup.
//
// The Rust `read_packet` handler runs a SELECT on the `packets` table to
// resolve the on-disk YAML path before reading + returning the text. The
// TS reference shape mirrors that handler's row contract — same column
// names, same types — so a column rename in `schema.ts` would surface here
// at compile time (N28-style failure-mode preservation).
// ---------------------------------------------------------------------------

export const packetMetaRowSchema = z.object({
  packet_id: z.string().min(1),
  session_id: z.string().min(1),
  yaml_path: z.string().min(1),
  schema_version: z.string().min(1),
  parent_packet_id: z.string().nullable(),
});
export type PacketMetaRow = z.infer<typeof packetMetaRowSchema>;

/**
 * Reference Drizzle SELECT for `read_packet` — exercises the schema's
 * `packets` columns + the `parent_packet_id` re-capture chain pointer.
 * The Rust handler runs the structurally-equivalent SQL; this builder
 * exists so a schema rename surfaces here, not in silent IPC corruption.
 */
export const PACKET_META_DRIZZLE_SHAPE = {
  packetIdCol: packets.packet_id,
  sessionIdCol: packets.session_id,
  yamlPathCol: packets.yaml_path,
  schemaVersionCol: packets.schema_version,
  parentPacketIdCol: packets.parent_packet_id,
} as const;

// ---------------------------------------------------------------------------
// Drizzle reference SELECT — used only for parity testing.
// (Note: we expose this so a unit test can compare the produced SQL string
// against the Rust handler's hand-rolled SQL; both must reference the same
// columns.)
// ---------------------------------------------------------------------------

/**
 * Reference Drizzle SELECT for the trail browser. Exercises the schema
 * in `schema.ts` so a column rename surfaces here at compile-time.
 *
 * The Drizzle expression uses the same risk-priority COALESCE order as the
 * Rust handler (reviewer_override > creator_override > agent), so a unit
 * test asserting the produced SQL contains those column names catches
 * drift.
 */
export const TRAIL_QUERY_DRIZZLE_SHAPE = {
  packetIdCol: packets.packet_id,
  sessionIdCol: packets.session_id,
  capturedAtCol: packets.captured_at,
  riskAgentCol: claims.risk_level_agent,
  riskCreatorOverrideCol: claims.risk_level_creator_override,
  riskReviewerOverrideCol: claims.risk_level_reviewer_override,
  redactionTable: redactionAudit,
  postedTable: postedToPrHistory,
} as const;

// Re-export drizzle utilities so consumers do not import the full lib path.
export { and, desc, eq, like, or, sql };
export type { SQL, SQLWrapper };
