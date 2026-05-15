import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for Trail E2E (gh#8 criterion 5 + 8).
 *
 * Two test modes (toggle via `TRAIL_E2E_MODE` env var):
 *
 *   - **`browser`** (default; runs in CI without a Tauri binary):
 *     Boots `vite preview` against the production build and exercises
 *     the React UI with the IPC bridge mocked at the window-global
 *     level. The 1000-packet stress test seeds rows via the same
 *     mock harness used by `tests/perf/`, then asserts the strict
 *     300ms cold-render budget in real Chromium.
 *
 *   - **`tauri`** (TRAIL_E2E_MODE=tauri): Drives a built desktop
 *     binary via `tauri dev`. Exercises the FULL stack (libSQL +
 *     IPC + React) and verifies criterion 5 end-to-end. Requires the
 *     Tauri binary to compile — gated on a successful `cargo build`
 *     of `apps/ui/src-tauri/`.
 *
 * The split is deliberate: criterion 5 must be verified, but a
 * Playwright test that ALWAYS requires `cargo build` would gate every
 * PR on Rust toolchain availability. The `browser` mode is the
 * always-on enforcement; `tauri` mode is the deeper gate run by the
 * dedicated nightly CI job.
 */

const E2E_MODE = process.env['TRAIL_E2E_MODE'] ?? 'browser';
const PORT = process.env['TRAIL_E2E_PORT'] ?? '4173';

const baseConfig = {
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: process.env['CI'] ? 'github' : 'list',

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry' as const,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
};

export default defineConfig(
  E2E_MODE === 'browser'
    ? {
        ...baseConfig,
        // Spin up the production build via vite preview so the test runs
        // against minified output (matches what the Tauri shell loads in
        // release).
        webServer: {
          command: `pnpm vite preview --port ${PORT} --strictPort`,
          port: parseInt(PORT, 10),
          timeout: 120_000,
          reuseExistingServer: !process.env['CI'],
        },
      }
    : baseConfig,
);
