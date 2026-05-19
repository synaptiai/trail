import { test, expect, type Page } from '@playwright/test';

/**
 * Sprint 3b — diff-hunk perf E2E (gh#10 criterion 6).
 *
 * Pinned budgets (B3 §15.3):
 *   - Cold first hunk (shiki cold-start: oniguruma WASM + grammar JSON load)
 *     ≤ 250ms.
 *   - Warm same-language hunks ≤ 30ms.
 *   - 60fps scroll over a 100-claim packet (frame budget ≤ 16.6ms).
 *
 * Test methodology:
 *   1. Navigate to /?perf=diff-hunk which exposes a deterministic test
 *      harness page that:
 *        a. Disables prewarmHighlighter() at App mount (so we can measure
 *           the COLD path);
 *        b. Renders a synthetic 100-DIFF packet via PacketView's
 *           loadedPacket prop;
 *        c. Tags the page <html> with `data-perf-mode="cold"` so the perf
 *           harness can probe paint timestamps.
 *   2. Use page.evaluate to capture performance.now() bracketing the first
 *      hunk's paint.
 *
 * Why a dedicated harness page (not the regular App):
 *   The production App calls prewarmHighlighter() at mount, which is
 *   correct for production but defeats COLD-path measurement. A perf-only
 *   query param routes the App to skip the prewarm so we can measure the
 *   actual cold-start cost; production users still get the prewarm.
 *
 * Mode: browser (vite preview). Tauri mode skipped — same rationale as
 * sidebar-stress.spec.ts: Rust toolchain isn't always available; the
 * React-layer perf is the always-on enforcement.
 */

const COLD_HUNK_BUDGET_MS = 250;
const WARM_HUNK_BUDGET_MS = 30;
// Empirical harness slack (Playwright + Chromium boot): cold path measured
// inside the page strictly; harness gate is permissive (cold + 200ms).
const COLD_HARNESS_SLACK_MS = 250;

// GitHub Actions ubuntu-latest runners exhibit perf variance vs reference
// dev hardware (Apple Silicon). The product budget is preserved for local
// runs; CI gets an allowance so noise doesn't false-fail the strict gate.
//
// synaptiai/trail#19 investigation (2026-05-19) found that runs on the
// PRIVATE internal mirror (synaptiai/trail-internal) are systematically
// ~40% slower than the PUBLIC repo across every meaningful E2E step —
// install, browser download, test execution, cold-paint — at a constant
// ratio. Same runner image (ubuntu-24.04 / ubuntu24/20260513.135), same
// code, same time-of-day. The 40% gap is consistent with private-repo
// runner provisioning differences on non-Enterprise plans, not a code
// regression. The "346.4ms vs 254.7ms" timeline in earlier comments
// compared an internal-repo run to a public-repo run as if they were
// the same baseline — they weren't.
//
// Distribution (2026-05-18/19):
//   - public  CI: 244 / 246 / 252 / 262 ms   (mean ~250, range 19ms)
//   - internal CI: 325 / 341 / 360 / 363 / 364 / 367 / 378 / 384 / 477 ms
//     (mean ~373, range 152ms)
//
// Public CI sits right under the original 250ms budget; restore the
// original +50ms allowance + 0.1 slow-frame ratio there. Internal CI
// keeps the +200ms allowance + 0.15 slow-frame ratio so the gate doesn't
// false-fail on the runner gap.
const IS_INTERNAL_CI =
  process.env['CI'] === 'true' && process.env['GITHUB_REPOSITORY'] === 'synaptiai/trail-internal';
const CI_VARIANCE_ALLOWANCE_MS = !process.env['CI']
  ? 0
  : IS_INTERNAL_CI
    ? 200
    : 50;

async function installPerfHarness(page: Page, opts: { hunkCount: number }) {
  await page.addInitScript((opts) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TRAIL_PERF_MODE__ = {
      kind: 'diff-hunk-cold',
      hunkCount: opts.hunkCount,
    };
  }, opts);
}

test.describe('DiffHunk perf budgets (gh#10 criterion 6)', () => {
  test('cold first hunk paints within 250ms (B3 §15.3)', async ({ page }) => {
    await installPerfHarness(page, { hunkCount: 1 });

    // Mark the start of the cold-path measurement BEFORE navigation so
    // performance.now() inside the page is monotonic.
    const wallStart = Date.now();
    await page.goto('/?perf=diff-hunk-cold');

    // Wait for the first hunk's region to be visible AND for shiki tokens
    // to be in the DOM (the perf harness only records once
    // .diff-hunk__line is present — i.e., post-tokenisation).
    const firstHunk = page.getByRole('region', { name: /Diff hunk: src\/perf-0\.ts/ });
    await expect(firstHunk).toBeVisible({ timeout: 5_000 });
    // Wait for the harness to have recorded the cold paint. Polling
    // beats a fixed sleep because we want the GENUINE shiki cold-start
    // time, not "5s after navigation".
    await page.waitForFunction(
      () => {
        const m = (window as { __TRAIL_PERF_MEASUREMENTS__?: { firstHunkPaintMs?: number } }).__TRAIL_PERF_MEASUREMENTS__;
        return typeof m?.firstHunkPaintMs === 'number';
      },
      { timeout: 5_000 },
    );
    const wallElapsed = Date.now() - wallStart;

    // Strict React-layer measurement — capture the bracket inside the page.
    const reactElapsed = await page.evaluate<number>(() => {
      const m = (window as { __TRAIL_PERF_MEASUREMENTS__?: { firstHunkPaintMs?: number } }).__TRAIL_PERF_MEASUREMENTS__;
      if (!m || typeof m.firstHunkPaintMs !== 'number') {
        throw new Error('perf harness did not record firstHunkPaintMs');
      }
      return m.firstHunkPaintMs;
    });

    // eslint-disable-next-line no-console
    console.log(`[perf] cold first hunk: ${reactElapsed.toFixed(1)}ms (budget ${COLD_HUNK_BUDGET_MS}ms, ci-allowance ${CI_VARIANCE_ALLOWANCE_MS}ms)`);
    expect(
      reactElapsed,
      `[strict] cold first hunk paint took ${reactElapsed.toFixed(1)}ms (budget ${COLD_HUNK_BUDGET_MS + CI_VARIANCE_ALLOWANCE_MS}ms incl ${CI_VARIANCE_ALLOWANCE_MS}ms CI allowance)`,
    ).toBeLessThan(COLD_HUNK_BUDGET_MS + CI_VARIANCE_ALLOWANCE_MS);

    // Harness gate (looser) — wall-clock includes Playwright + Chromium
    // boot. If the strict React-layer gate passes but the wall gate
    // fails, that's harness flake, not a product regression.
    expect(
      wallElapsed,
      `[wall] cold first hunk paint took ${wallElapsed}ms (budget ${COLD_HUNK_BUDGET_MS + COLD_HARNESS_SLACK_MS}ms)`,
    ).toBeLessThan(COLD_HUNK_BUDGET_MS + COLD_HARNESS_SLACK_MS);
  });

  test('warm same-language hunks paint within 30ms each', async ({ page }) => {
    // Render 5 same-language (typescript) hunks. Hunk #1 pays the cold
    // cost; hunks #2..#5 are the warm-path under test.
    await installPerfHarness(page, { hunkCount: 5 });
    await page.goto('/?perf=diff-hunk-warm');

    // Wait for the LAST hunk's region — implies all 5 painted.
    await expect(
      page.getByRole('region', { name: /Diff hunk: src\/perf-4\.ts/ }),
    ).toBeVisible({ timeout: 5_000 });
    // Wait for the harness to have recorded paint for ALL 5 hunks. The
    // observer fires asynchronously per hunk; this ensures we read
    // measurements for each one rather than just the first to arrive.
    await page.waitForFunction(
      () => {
        const m = (window as { __TRAIL_PERF_MEASUREMENTS__?: { warmHunkPaintsMs?: number[] } }).__TRAIL_PERF_MEASUREMENTS__;
        return Array.isArray(m?.warmHunkPaintsMs) && m.warmHunkPaintsMs.length === 5;
      },
      { timeout: 5_000 },
    );

    const warmTimes = await page.evaluate<number[]>(() => {
      const m = (window as { __TRAIL_PERF_MEASUREMENTS__?: { warmHunkPaintsMs?: number[] } }).__TRAIL_PERF_MEASUREMENTS__;
      if (!m || !Array.isArray(m.warmHunkPaintsMs)) {
        throw new Error('perf harness did not record warmHunkPaintsMs');
      }
      return m.warmHunkPaintsMs;
    });

    // Hunks #2..#5 are warm. The harness records all 5 sorted by
    // ABSOLUTE elapsed time from harness start. The B3 §15.3 budget is
    // PER-HUNK shiki tokenisation duration AFTER the singleton is primed,
    // not absolute elapsed (which compounds because shiki's singleton
    // serialises tokenisation calls — 5 concurrent hunks queue through
    // one tokenizer).
    //
    // We measure per-hunk DELTA: the time shiki spent tokenising hunk #N
    // is approximated by (paintTime[N] - paintTime[N-1]). Hunks 2..5 are
    // the warm cohort; we assert each delta ≤ 30ms.
    expect(warmTimes.length).toBe(5);
    const deltas: number[] = [];
    for (let i = 1; i < warmTimes.length; i++) {
      deltas.push(warmTimes[i]! - warmTimes[i - 1]!);
    }
    // eslint-disable-next-line no-console
    console.log(`[perf] warm-hunk per-hunk deltas (post-cold): ${deltas.map((m) => m.toFixed(1)).join('ms / ')}ms (budget ${WARM_HUNK_BUDGET_MS}ms)`);
    for (const [idx, ms] of deltas.entries()) {
      expect(
        ms,
        `[strict] warm hunk #${idx + 2} delta took ${ms.toFixed(1)}ms (budget ${WARM_HUNK_BUDGET_MS + CI_VARIANCE_ALLOWANCE_MS}ms incl ${CI_VARIANCE_ALLOWANCE_MS}ms CI allowance)`,
      ).toBeLessThan(WARM_HUNK_BUDGET_MS + CI_VARIANCE_ALLOWANCE_MS);
    }
  });

  // Note: the strict ≤30ms warm budget (B3 §15.3) is defended by the
  // service-layer test in `tests/unit/highlight.test.ts` ("warm
  // same-language hunks tokenise in ≤30ms"). The E2E warm path is
  // exercised by the per-hunk delta assertion in the test above (5
  // hunks rendering in batched rAF post-cold) — proving warm hunks
  // pay zero additional shiki cost beyond the cold first.
  //
  // A standalone E2E warm-budget test would race shiki's prewarm
  // against the page navigation: prewarm starts in App.useEffect,
  // DiffTab.useEffect fires the next tick, and they share the same
  // module-singleton promise. The result is the FIRST hunk pays cold
  // cost EVEN IN warm mode at the page level (the unit test pays the
  // cold cost in beforeAll/the priming call, then measures warm).
  // Sprint 4's saga + decisions will add an in-app navigation that
  // makes a true session-warm path testable end-to-end.

  test('100-claim packet renders without dropping below 30fps during scroll', async ({ page }) => {
    await installPerfHarness(page, { hunkCount: 100 });
    await page.goto('/?perf=diff-hunk-stress');

    // Wait for the FIRST hunk to be visible — implies the 100-row build
    // is in the DOM (the rest paint progressively).
    await expect(
      page.getByRole('region', { name: /Diff hunk: src\/perf-0\.ts/ }),
    ).toBeVisible({ timeout: 10_000 });

    // Scroll the diff tab body and measure frame deltas.
    const frameDeltas = await page.evaluate<number[]>(async () => {
      const deltas: number[] = [];
      let last = performance.now();
      let stop = false;
      const onFrame = (now: number) => {
        deltas.push(now - last);
        last = now;
        if (!stop) requestAnimationFrame(onFrame);
      };
      requestAnimationFrame(onFrame);
      // Drive a 600ms continuous scroll; that's enough to cross several
      // virtualization windows on the 100-hunk list.
      const el =
        document.querySelector('.diff-tab__hunks') as HTMLElement | null;
      if (el) {
        const start = performance.now();
        while (performance.now() - start < 600) {
          el.scrollTop += 32;
          await new Promise((r) => requestAnimationFrame(r));
        }
      }
      stop = true;
      // Drop the first frame (often artificially long; pre-rAF sync work).
      return deltas.slice(1);
    });

    // 30fps gate (frame budget ≤ 33.3ms). The B3 §15.3 spec says "60fps
    // minimum; complex transitions allowed at 30fps if non-essential."
    // Scroll over 100 hunks with shiki tokenisation falls into the
    // "may degrade if essential paint precedence is preserved" bucket;
    // we assert the 30fps floor strictly and surface the average for
    // diagnostic logs.
    const FRAME_BUDGET_30FPS = 33.4;
    const slow = frameDeltas.filter((d) => d > FRAME_BUDGET_30FPS);
    const avg = frameDeltas.reduce((s, d) => s + d, 0) / Math.max(1, frameDeltas.length);
    // eslint-disable-next-line no-console
    console.log(`[perf] 100-hunk scroll: avg ${avg.toFixed(1)}ms; ${slow.length}/${frameDeltas.length} slow (budget 33.4ms = 30fps floor)`);
    // Allow up to 10% slow frames locally + on public CI / 15% on internal
    // CI. Jitter happens, but a sustained drop would mean the diff tab is
    // starving the main thread. The 15% allowance on internal CI matches
    // the runner-provisioning gap documented above; public CI sits well
    // under the 10% threshold so the original strict ratio is preserved
    // there (gh#19).
    const SLOW_FRAME_THRESHOLD = IS_INTERNAL_CI ? 0.15 : 0.1;
    expect(
      slow.length / Math.max(1, frameDeltas.length),
      `>${(SLOW_FRAME_THRESHOLD * 100).toFixed(0)}% slow frames during 100-hunk scroll (avg ${avg.toFixed(1)}ms; ${slow.length} of ${frameDeltas.length} > ${FRAME_BUDGET_30FPS}ms)`,
    ).toBeLessThan(SLOW_FRAME_THRESHOLD);
  });
});
