/**
 * Migration applier (TS reference, gh#8 criterion 6).
 *
 * The DESKTOP migration runner lives in Rust
 * (`apps/ui/src-tauri/src/migrations.rs`) and is the production code path —
 * desktop boot opens libSQL on the main thread before Tauri attaches the
 * webview, so the JS layer never sees an unmigrated DB.
 *
 * THIS file exists for two reasons:
 *
 *   1. **Tests.** Vitest runs in Node (happy-dom env) and can boot an
 *      in-memory libSQL instance via `@libsql/client` to exercise the
 *      query layer end-to-end without a Tauri shell. Those tests need a
 *      JS-callable applier.
 *
 *   2. **Future Wasm libSQL.** When the libSQL embedded engine ships a
 *      working Wasm port (currently in alpha at libsql/libsql-wasm), the
 *      desktop and the test harness can converge on a single JS migration
 *      runner. This file is the stub that gets promoted to production.
 *
 * Apply contract (mirrors Rust):
 *   - `BEGIN IMMEDIATE` per B6 P1 finding.
 *   - Bookkeeping table `_trail_migrations` records (version, applied_at,
 *     statements_hash) so re-runs are idempotent AND mutation is detected.
 *   - The migration content is `0000_init.sql` — embedded as a raw string
 *     here via Vite's `?raw` import suffix.
 */
import initMigrationSql from './migrations/0000_init.sql?raw';

export interface SqlExecutor {
  /** Execute a SQL string (no parameters). */
  execute(sql: string): Promise<unknown>;
  /** Execute a parameterised statement, return rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface ApplyResult {
  /** Count of newly-applied migrations (0 on a no-op re-run). */
  applied: number;
}

export class MigrationMutatedError extends Error {
  constructor(
    public readonly version: string,
    public readonly recordedHash: string,
    public readonly currentHash: string,
  ) {
    super(
      `migration ${version} mutated post-apply: recorded=${recordedHash} current=${currentHash}`,
    );
    this.name = 'MigrationMutatedError';
  }
}

const BOOKKEEPING_DDL = `CREATE TABLE IF NOT EXISTS _trail_migrations (
  version          TEXT PRIMARY KEY,
  applied_at       TEXT NOT NULL DEFAULT (datetime('now')),
  statements_hash  TEXT NOT NULL
);`;

export async function applyAll(executor: SqlExecutor): Promise<ApplyResult> {
  await executor.execute(BOOKKEEPING_DDL);
  let applied = 0;
  if (await maybeApply(executor, '0000_init', initMigrationSql)) applied += 1;
  return { applied };
}

async function maybeApply(
  executor: SqlExecutor,
  version: string,
  sql: string,
): Promise<boolean> {
  const currentHash = await sha256Hex(sql);
  const rows = await executor.query<{ statements_hash: string }>(
    'SELECT statements_hash FROM _trail_migrations WHERE version = ?',
    [version],
  );
  const recorded = rows[0]?.statements_hash;
  if (recorded != null) {
    if (recorded === currentHash) return false;
    throw new MigrationMutatedError(version, recorded, currentHash);
  }
  // BEGIN IMMEDIATE per B6 P1; the executor implementation is responsible
  // for translating "BEGIN IMMEDIATE" to the libSQL/SQLite equivalent.
  await executor.execute('BEGIN IMMEDIATE TRANSACTION');
  try {
    await executor.execute(sql);
    // F-CODE-3: belt + braces. The Rust runner uses parameterized binds
    // (migrations.rs:135). The TS executor's `execute()` interface is
    // SQL-only (no params); switching to parameters would require
    // extending the interface for callers we don't control. Instead we
    // pin the input shape via runtime assertions so the string-concat
    // path can NEVER carry user-controlled data, regardless of how the
    // applier is wired in the future.
    assertSafeMigrationVersion(version);
    assertSafeStatementsHash(currentHash);
    await executor.execute(
      `INSERT INTO _trail_migrations (version, statements_hash) VALUES ('${escapeSql(version)}', '${escapeSql(currentHash)}')`,
    );
    await executor.execute('COMMIT');
  } catch (err) {
    try {
      await executor.execute('ROLLBACK');
    } catch {
      /* swallow secondary error; surface the primary */
    }
    throw err;
  }
  return true;
}

/**
 * Defensive single-quote escape for the version + hash insert. Both values
 * are server-controlled (constants in this file + a SHA-256 hex digest)
 * AND validated by `assertSafe*` before reaching this function — but we
 * keep the escape so the string-concat path is correct regardless of
 * input shape (defence in depth).
 */
function escapeSql(s: string): string {
  return s.replace(/'/g, "''");
}

const MIGRATION_VERSION_RE = /^[0-9a-z][0-9a-z_]*$/;
const STATEMENTS_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Runtime guard for the migration version identifier. Only lowercase
 * alphanumerics + underscore are permitted; the value must start with a
 * digit or letter. This rejects anything that could carry SQL syntax
 * (quotes, semicolons, whitespace) before it reaches the string-concat
 * INSERT. The set of versions in this codebase is `0000_init`; future
 * additions follow `NNNN_<snake_case>`.
 */
function assertSafeMigrationVersion(version: string): void {
  if (!MIGRATION_VERSION_RE.test(version)) {
    throw new Error(
      `migration version must match ${MIGRATION_VERSION_RE} (got: ${JSON.stringify(version)})`,
    );
  }
}

/**
 * Runtime guard for the SHA-256 hex digest. Must be exactly 64 lowercase
 * hex chars — the canonical output of `crypto.subtle.digest('SHA-256')`.
 * This rejects anything that could carry SQL syntax before it reaches
 * the string-concat INSERT.
 */
function assertSafeStatementsHash(hash: string): void {
  if (!STATEMENTS_HASH_RE.test(hash)) {
    throw new Error(
      `statements_hash must match ${STATEMENTS_HASH_RE} (got: ${JSON.stringify(hash)})`,
    );
  }
}

async function sha256Hex(input: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return hex(new Uint8Array(buf));
  }
  // Node fallback (vitest env).
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

/**
 * Re-export the embedded SQL so tests can assert that the production code
 * path uses the SAME bytes as `apps/ui/src/db/migrations/0000_init.sql`
 * (cycle-2 N28 — single source of truth).
 */
export const INIT_MIGRATION_SQL = initMigrationSql;
