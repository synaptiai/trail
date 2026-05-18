/**
 * Vitest config for the wire-contract bridge test (gh#2 Phase 1).
 *
 * Separate from `vitest.config.ts` because the wire-contract suite has a
 * hard prerequisite: snapshots emitted by `cargo test --test
 * ipc_dispatch_smoke` in src-tauri/ must already exist at
 * `apps/ui/test-fixtures/wire-snapshots/`. Including this in the main
 * unit-test config would break `pnpm test` runs that have not regenerated
 * snapshots since the Rust side last changed.
 *
 * Run via `pnpm test:wire-roundtrip` (or `pnpm test:wire-roundtrip:full`
 * which chains `pnpm smoke:rust` first).
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/wire-contract/**/*.test.ts'],
  },
});
