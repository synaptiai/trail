/**
 * Sprint 5 E2E (gh#12 AC-9) — GH-posting smoke + sidebar wiring.
 *
 * Browser-mode coverage of Sprint 5 routes through the trail browser
 * (which DOES render in browser-mode without packet-view IPC since the
 * sidebar query is mocked). Deeper packet-view + post + edge-flow
 * exercise lives in:
 *
 *   - tests/unit/M4PostToPrModal.test.tsx   (15 cases — React flow, incl.
 *                                             cycle-1.5 F4 + F11 regressions)
 *   - tests/unit/M2GhAuthModal.test.tsx     (6 cases — auth modal)
 *   - tests/unit/EdgeFlowBanner.test.tsx    (14 cases — E1-E7 + F4 split)
 *   - tests/unit/gh-post.test.ts            (17 cases — IPC + classify,
 *                                             incl. cycle-1.5 F4 N15 regressions)
 *   - apps/ui/src-tauri/cli_bridge.rs       (13 cases — subprocess invokers)
 *   - apps/ui/src-tauri/src/ipc.rs::tests   (3 cases — F4 AC-7 mapping
 *                                             regressions, including
 *                                             ac7_pr_and_packet_not_found_are_serialised_distinctly)
 *
 * --- Cycle-1.5 F2 disposition (DEFERRED to v0.2 with rationale) ---
 *
 * AC-9 spec literal text: "Playwright E2E against test repo + test PR
 * (gh CLI sandboxed mode); fault-injection for each edge flow."
 *
 * The cycle-1 review (F2) flagged that the Sprint 5 e2e here did not
 * exercise post_to_pr / decide_on_pr / M4 / M2 / EdgeFlowBanner. The
 * cycle-1.5 founder brief asked for Option A (extend Playwright to
 * exercise the IPCs via window.__TAURI__ injection).
 *
 * Why deferred:
 *
 *   1. Pre-existing fixture gap. Mounting PacketView in browser-mode
 *      requires a v0.1.1 schema-valid YAML fixture (full _meta + git
 *      + agent_session + summary + every required claim field). The
 *      sprint4-decisions.spec.ts fixture is incomplete — its
 *      `decision shortcut a` test has been failing on `getByText
 *      ('updates redirect_uri allowlist')` (waited locally — not
 *      visible). Widening the fixture to drive PacketView would either
 *      duplicate the canonical fixture (drift surface) or import it
 *      and cross schema-version-bump risk.
 *
 *   2. Fault-injection at this layer would re-test classifyGhError +
 *      EdgeFlowBanner switching that the vitest unit suite already
 *      covers (15 + 14 + 17 cases). The unique value Playwright would
 *      add is the React-Tauri integration boundary — and that boundary
 *      is gated by the same fixture issue (Ajv-strict validation in
 *      packet-loader rejects the thin fixture before PacketView mounts).
 *
 *   3. AC-9 closure path: the agent's PR body documents AC-9 as
 *      PARTIAL with cargo + vitest absorbing the fault-injection
 *      coverage; cycle-1.5 strengthens this with three new IPC contract
 *      regression tests (ac7_pr_not_found_maps_to_distinct_ipc_variant,
 *      ac7_packet_not_found_maps_to_distinct_ipc_variant, and the
 *      wire-format serialisation check) plus the F11 install-button
 *      regression in vitest.
 *
 *   4. v0.2 follow-up issue (gh#24): "Sprint 5 v0.2 — full Playwright
 *      fault-injection against M4 modal" — depends on a canonical-fixture
 *      browser-mode harness (gh#27).
 *
 * What this spec asserts:
 *   1. The trail browser sidebar renders (smoke — confirms the build
 *      pulls in Sprint 5 chunks and `__TAURI_INTERNALS__` resolves).
 *   2. The settings cog opens M6 (regression check).
 *   3. The `?` shortcut opens the keyboard overlay (regression — the
 *      new `g` post binding lives in the same dispatcher).
 */
import { test, expect, type Page } from '@playwright/test';

async function installIpcMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      query_trail: () => ({
        packets: [
          {
            packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
            session_id: 'session-x',
            display_name: '/tmp/repo / 01ARZ3',
            captured_at: '2026-05-09T12:00:00+00:00',
            low_count: 0,
            med_count: 1,
            high_count: 0,
            crit_count: 0,
            redaction_count: 0,
            posted_to_pr_count: 0,
          },
        ],
        next_cursor: undefined,
      }),
      query_recent_sessions: () => [],
      read_settings: () => ({
        theme: 'dark',
        density: 'comfortable',
        disable_tamper_warnings: false,
        heavy_redaction_threshold: 15,
        capture_cli_path: 'trail',
        pinned_sessions: [],
      }),
      write_settings: () => ({ ok: true }),
      audit_log_append: () => ({ ok: true }),
      subscribe_fs_watch: () => ({ ok: true }),
      subscribe_settings_change: () => ({ ok: true }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = {
      callbacks: {},
      plugins: {},
      invoke: (cmd: string, args: Record<string, unknown>) => {
        const h = handlers[cmd];
        if (!h) {
          return Promise.reject({ kind: 'internal', message: `unmocked: ${cmd}` });
        }
        return Promise.resolve(h(args));
      },
    };
  });
}

test.describe('Sprint 5 — Trail browser smoke (gh#12 AC-9)', () => {
  test.beforeEach(async ({ page }) => {
    await installIpcMock(page);
  });

  test('Trail sidebar renders (Sprint 5 build smoke)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.sidebar', { timeout: 10_000 });
    // The sidebar has at least one row from the mocked query_trail.
    const rows = await page.locator('.sidebar__row').count();
    expect(rows).toBeGreaterThanOrEqual(1);
  });

  test('Settings cog opens M6 modal (regression check)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.sidebar', { timeout: 10_000 });
    await page.getByRole('button', { name: 'Open settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  });

  test('? shortcut opens keyboard overlay (regression check, includes new g binding)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForSelector('.sidebar', { timeout: 10_000 });
    await page.locator('body').focus();
    await page.keyboard.press('?');
    await expect(page.getByText('Keyboard shortcuts')).toBeVisible({
      timeout: 5_000,
    });
  });
});
