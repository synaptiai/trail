import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * Schema source-of-truth: src/db/schema.ts.
 * Migrations land in src/db/migrations/ and are committed.
 * Dialect: SQLite — matches both better-sqlite3 (Node tests) and @libsql/client.
 *
 * v0.1 status (per PR #6 cycle-1 review F9): the migration in
 * `migrations/0000_init.sql` is HAND-ROLLED, not drizzle-kit-generated.
 * The filename + meta/_journal.json conform to drizzle-kit's convention so
 * a future migration to drizzle-kit-driven authoring does not require
 * renumbering or journal reconstruction. The `db:generate` npm script is
 * deliberately ABSENT in Sprint 1 — re-introduce it only after the schema
 * stabilises and a `drizzle-kit generate` round-trip emits a no-op diff.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'sqlite',
  verbose: true,
  strict: true,
});
