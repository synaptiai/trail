import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vitest performance config — runs the cold-render benchmark for the
 * 1000-packet timeline (gh#8 criterion 5). Separated from the main
 * `vitest.config.ts` so a regular `pnpm test` is not slowed by the
 * 1000-row render.
 *
 * Invoke via `pnpm test:perf`. The test asserts:
 *   - <TrailSidebar> mounts with 1000 packets in ≤300ms (cold render).
 *   - The virtualization renders ≤ 30 rows at any given scrollTop (the
 *     viewport + overscan).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['tests/perf/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/_helpers/setup.ts'],
    // Perf test takes ~1-2s on a warm CI; budget the test runner generously
    // to avoid a flake on the first cold compile.
    testTimeout: 60_000,
  },
});
