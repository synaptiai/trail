import { test, expect, type Page } from '@playwright/test';

/**
 * Sprint 6 — performance budgets in CI gates (gh#13 AC-3).
 *
 * Pinned budgets (B3 §15.3):
 *   - open-packet           ≤ 200ms
 *   - trail timeline @1000  ≤ 300ms (covered by sidebar-stress.spec.ts)
 *   - decision optimistic   ≤ 100ms
 *   - decision durable      ≤ 200ms
 *   - modal open            ≤ 160ms
 *   - shiki cold            ≤ 250ms (covered by diff-hunk-perf.spec.ts)
 *   - shiki warm            ≤ 30ms  (covered by diff-hunk-perf.spec.ts)
 *
 * This spec covers the four budgets NOT already gated by other perf
 * specs:
 *
 *   1. open-packet — click a sidebar row and measure the time from the
 *      click to PacketView's first frame (the packet header + its
 *      claims rendering).
 *   2. modal-open — click the settings cog and measure the time from the
 *      click to the dialog being visible.
 *   3. decision-optimistic — keyboard-press `a` and measure the time to
 *      the optimistic UI flip (the focused claim's status badge updating).
 *   4. decision-durable — same path, but measure the wall-clock through
 *      to the audit_log_append IPC ack returning. The IPC mock resolves
 *      synchronously so this is the React-render + state-flush bound.
 *
 * Mode: browser (vite preview). Tauri mode skipped — same rationale as
 * sidebar-stress.spec.ts and diff-hunk-perf.spec.ts: the React-layer
 * perf is the always-on enforcement. Tauri-mode is the deeper gate run
 * manually before major releases.
 *
 * Harness slack vs strict measurement:
 *   - The "[strict]" assertion captures perf.now() inside the page,
 *     measured around the same DOM event the user perceives.
 *   - The "[wall]" assertion (Playwright's wall-clock) is permissive
 *     because Playwright + Chromium add 50-200ms of harness overhead.
 *   - CI fails on the [strict] gate. The [wall] gate exists for
 *     debugging — if [strict] passes but [wall] fails, that's harness
 *     flake, not a product regression.
 */

const OPEN_PACKET_BUDGET_MS = 200;
const MODAL_OPEN_BUDGET_MS = 160;
const DECISION_OPTIMISTIC_BUDGET_MS = 100;
const DECISION_DURABLE_BUDGET_MS = 200;

interface SidebarRow {
  packet_id: string;
  session_id: string;
  display_name: string;
  captured_at: string;
  low_count: number;
  med_count: number;
  high_count: number;
  crit_count: number;
  redaction_count: number;
  posted_to_pr_count: number;
}

// v0.1.1-schema-valid packet. Mirror of tests/unit/packet-loader.test.ts::
// MINIMAL_PACKET_YAML — keeps the perf-gate spec aligned with the
// canonical Ajv schema at schema/pr-change-packet.v0.1.1.schema.json.
//
// The previous fixture was a Sprint-2-era shape that pre-dated the v0.1.1
// strict-validation pipeline (it lacked packet_version, pr, task_intent,
// commands_run, test_evidence, provenance — all required by the schema).
// Ajv rejection surfaced as "Packet failed schema validation" in PacketView,
// the .packet-header never mounted, and the open-packet perf gate's
// MutationObserver hit its 5_000ms safety timeout instead of resolving with
// the actual render time.
const FIXTURE_PACKET_YAML = `
packet_version: 0.1.1
_meta:
  packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
  generated_at: '2026-05-09T12:00:00.000+00:00'
  generator:
    name: trail
    version: 0.1.0-dev
  schema_url: schema/pr-change-packet.v0.1.1.yml
  capture_method: post_hoc
  parent_packet_id: null
pr:
  provider: github
  repository: synaptiai/trail
  branch: feature/perf
  base_branch: origin/main
  pr_number: null
  author: test@example.com
task_intent:
  source_type: prompt
  source_ref: PROMPT-PERF
  summary: minimal packet for perf-gate E2E
  acceptance_criteria: []
agent_session:
  tool: claude-code
  model: claude-opus-4-7
  models:
  - claude-opus-4-7
  started_at: '2026-05-09T11:00:00.000+00:00'
  ended_at: '2026-05-09T11:30:00.000+00:00'
  session_id: 18e374b5-4eb9-424d-a3ff-a639d1c6fada
  transcript_summary: []
  prompts:
    initial: 'perf-gate fixture'
    followups: []
  redaction_metadata:
    pattern_set_version: 0.1.3
    redactions_applied: 0
    redactions_by_pattern: {}
    validation_errors: []
    skipped_files: []
diff_summary:
  base_sha: '0000000000000000000000000000000000000000'
  head_sha: '1111111111111111111111111111111111111111'
  files_changed: 1
  lines_added: 1
  lines_deleted: 0
  modules_touched: []
  semantic_changes:
  - id: DIFF-001
    description: Wrote /tmp/perf.ts (10 chars)
    files: ['/tmp/perf.ts']
    operation: write
    excerpts: []
commands_run: []
test_evidence:
  passed: []
  failed: []
  not_run: []
provenance:
  authorship:
    ai_generated_estimate: high
    human_modified_estimate: low
    method: post-hoc-transcript
  agent_touched_files:
  - /tmp/perf.ts
  human_touched_files: []
summary:
  claims:
  - id: CLAIM-001
    stable_id: aaaaaaaaaaaaaaaa
    text: Perf-gate fixture claim
    evidence_refs:
    - DIFF-001
    confidence: supported
    synthesis_mode: mechanical
    risk_classification:
      agent: { level: med, rationale: smoke }
      creator_override: { level: null, reason: null, at: null, by: null }
      reviewer_override: { level: null, reason: null, at: null, by: null }
  ungrounded_claim_count: 0
approval_trail: []
`;

function seedRow(): SidebarRow {
  return {
    packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    session_id: '18e374b5-4eb9-424d-a3ff-a639d1c6fada',
    display_name: 'Perf fixture',
    captured_at: '2026-05-09T12:00:00+00:00',
    low_count: 0,
    med_count: 1,
    high_count: 0,
    crit_count: 0,
    redaction_count: 0,
    posted_to_pr_count: 0,
  };
}

async function installIpcMock(page: Page, opts: { packetYaml: string }): Promise<void> {
  await page.addInitScript(({ row, packetYaml }) => {
    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      query_trail: () => ({ packets: [row], next_cursor: undefined }),
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
      read_packet: () => ({
        // Hardcode the ULID — production invokes are wrapped as
        // `{ args: { packet_id } }` (v0.1.1 IPC wrapper-args contract), and
        // every other e2e spec hardcodes the same ULID rather than dig the
        // nested arg out. Aligns with the single-row fixture seedRow() emits.
        packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        schema_version: '0.1.1',
        yaml_text: packetYaml,
        yaml_path: '/test/perf-fixture.yml',
      }),
      save_decision: () => ({ ok: true, audit_seq: 1 }),
      append_approval_trail_entry: () => ({ ok: true, audit_seq: 1 }),
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
  }, { row: seedRow(), packetYaml: opts.packetYaml });
}

test.describe('Sprint 6 — perf gates (gh#13 AC-3)', () => {
  test.beforeEach(async ({ page }) => {
    await installIpcMock(page, { packetYaml: FIXTURE_PACKET_YAML });
  });

  test('open-packet ≤ 200ms (sidebar click → PacketView first frame)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.sidebar', { timeout: 10_000 });
    const row = page.locator('.sidebar__row').first();
    await expect(row).toBeVisible();

    // Bracket the measurement strictly inside the page using performance.now()
    // so we capture only the React render time, not Playwright's click
    // round-trip.
    const elapsed = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        // Click the inner button — the onClick handler is on
        // `.sidebar__row-button` (TrailSidebar.tsx:661-662), not the
        // outer `.sidebar__row` container. A native HTMLElement.click()
        // dispatched on the parent does NOT propagate to the child's
        // React onClick (events bubble up, not down). Playwright's
        // page.locator(...).click() works on `.sidebar__row` because
        // it's a real mouse click at the row's coordinates and the
        // button fills the row visually — but our inline measurement
        // uses native .click(), which requires the exact handler target.
        const sidebarRow = document.querySelector('.sidebar__row-button');
        if (!sidebarRow) {
          resolve(-1);
          return;
        }
        const t0 = performance.now();
        // Use a MutationObserver targeted at the main content area; resolve
        // when PacketView's header lands in the DOM.
        const main = document.querySelector('#main-content');
        if (!main) {
          resolve(-1);
          return;
        }
        const observer = new MutationObserver(() => {
          if (main.querySelector('.packet-header, [data-packet-loaded]')) {
            observer.disconnect();
            resolve(performance.now() - t0);
          }
        });
        observer.observe(main, { childList: true, subtree: true });
        (sidebarRow as HTMLElement).click();
        // Safety timeout — if the observer never fires, resolve with a
        // big number so the assertion fails informatively.
        setTimeout(() => {
          observer.disconnect();
          resolve(performance.now() - t0);
        }, 5_000);
      });
    });

    // eslint-disable-next-line no-console
    console.log(`[perf] open-packet: ${elapsed.toFixed(1)}ms (budget ${OPEN_PACKET_BUDGET_MS}ms)`);
    // Cycle-1.5 F2: guard against silent-pass on broken click path.
    // If the sidebar row or #main-content goes missing, the page.evaluate
    // resolves with -1 and `-1 < 200` would trivially pass. The
    // toBeGreaterThan(0) gate ensures the measurement actually happened.
    expect(
      elapsed,
      `open-packet measurement did not capture (elapsed=${elapsed}) — likely missing sidebar row or #main-content`,
    ).toBeGreaterThan(0);
    expect(
      elapsed,
      `open-packet took ${elapsed.toFixed(1)}ms (budget ${OPEN_PACKET_BUDGET_MS}ms)`,
    ).toBeLessThan(OPEN_PACKET_BUDGET_MS);
  });

  test('modal-open ≤ 160ms (settings cog click → dialog visible)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.sidebar', { timeout: 10_000 });

    // Bracket inside the page so harness overhead is excluded.
    const elapsed = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        const cog = document.querySelector(
          'button[aria-label="Open settings"]',
        ) as HTMLButtonElement | null;
        if (!cog) {
          resolve(-1);
          return;
        }
        const t0 = performance.now();
        const observer = new MutationObserver(() => {
          const dialog = document.querySelector('div[role="dialog"]');
          if (dialog) {
            observer.disconnect();
            resolve(performance.now() - t0);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        cog.click();
        setTimeout(() => {
          observer.disconnect();
          resolve(performance.now() - t0);
        }, 5_000);
      });
    });

    // eslint-disable-next-line no-console
    console.log(`[perf] modal-open: ${elapsed.toFixed(1)}ms (budget ${MODAL_OPEN_BUDGET_MS}ms)`);
    // Cycle-1.5 F2: guard against silent-pass on broken click path.
    // If the settings cog goes missing, the page.evaluate resolves with -1
    // and `-1 < 160` would trivially pass. The toBeGreaterThan(0) gate
    // ensures the measurement actually happened.
    expect(
      elapsed,
      `modal-open measurement did not capture (elapsed=${elapsed}) — likely missing settings cog button`,
    ).toBeGreaterThan(0);
    expect(
      elapsed,
      `modal-open took ${elapsed.toFixed(1)}ms (budget ${MODAL_OPEN_BUDGET_MS}ms)`,
    ).toBeLessThan(MODAL_OPEN_BUDGET_MS);
  });

  test('decision optimistic ≤ 100ms / durable ≤ 200ms (a-key on focused claim)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForSelector('.sidebar', { timeout: 10_000 });
    // Open the packet first so the claim is focused.
    await page.locator('.sidebar__row').first().click();
    // Wait for the packet to load.
    await page.waitForSelector('.claim-row, [role="row"]', { timeout: 10_000 });

    // Focus the claim row by clicking it — keyboard shortcut `a` then
    // dispatches accept on the focused row. We measure two brackets:
    //   1. optimistic  — DOM update of the row's status (before IPC
    //      ack)
    //   2. durable     — same row's data-decision-persisted attribute
    //      (after the audit_log_append IPC resolves)
    const elapsed = await page.evaluate(() => {
      return new Promise<{ optimistic: number; durable: number }>((resolve) => {
        const claim = document.querySelector('.claim-row, [role="row"]') as
          | HTMLElement
          | null;
        if (!claim) {
          resolve({ optimistic: -1, durable: -1 });
          return;
        }
        claim.focus();
        let optimistic = -1;
        let durable = -1;
        const t0 = performance.now();
        const observer = new MutationObserver(() => {
          // Optimistic: the row gains a [data-decision] attribute.
          //
          // Cycle-3 C9 (PR #21): the previous fallback also accepted
          // a textContent regex match for /accepted|accept/i — so a
          // claim row whose markup happened to contain the word
          // "accept" anywhere (e.g., a button label, a tooltip, the
          // word "Acceptance" in copy) would mark optimistic before
          // the actual data-decision attribute landed. The DOM marker
          // contract (cycle-2 C2: data-decision wired through ClaimRow)
          // is the load-bearing signal; if it's not set, the gate
          // should fail visibly. Removing the textContent fallback
          // means a future regression that breaks the data-decision
          // wiring no longer hides behind copy-text coincidence.
          if (optimistic === -1) {
            const hasDecision =
              claim.hasAttribute('data-decision') ||
              claim.querySelector('[data-decision]');
            if (hasDecision) {
              optimistic = performance.now() - t0;
            }
          }
          // Durable: the row gains data-decision-persisted="true". The
          // attribute is set on the ClaimRow element itself (see
          // apps/ui/src/components/screens/ClaimRow.tsx:88), so we check
          // both `claim.getAttribute(...)` AND `querySelector` — mirroring
          // the dual check used for optimistic above. The previous logic
          // only queried descendants and silently never resolved durable.
          if (
            optimistic >= 0 &&
            (claim.getAttribute('data-decision-persisted') === 'true' ||
              claim.querySelector('[data-decision-persisted="true"]'))
          ) {
            durable = performance.now() - t0;
            observer.disconnect();
            resolve({ optimistic, durable });
          }
        });
        observer.observe(claim, { childList: true, subtree: true, attributes: true });
        // Synthetic keydown — the dispatcher classifies `a` as
        // decide(accept) and the React handler updates the row.
        const ev = new KeyboardEvent('keydown', { key: 'a', bubbles: true });
        document.dispatchEvent(ev);
        setTimeout(() => {
          observer.disconnect();
          // Cycle-2 C6 (PR #21): do NOT fall back to `durable = optimistic`.
          // The previous fallback caused a silent pass when the durable
          // mark never appeared — the assertion `durable < 200` would
          // trivially pass with the optimistic value (e.g., 12ms < 200ms).
          // Now: if the durable mark didn't appear, leave durable at -1
          // and let the outer assertion fail informatively. Real Chromium
          // flushes React commits well within the 3s window; if happy-dom
          // can't, we want the failure to surface, not be papered over.
          resolve({ optimistic, durable });
        }, 3_000);
      });
    });

    // eslint-disable-next-line no-console
    console.log(
      `[perf] decision optimistic: ${elapsed.optimistic.toFixed(1)}ms (budget ${DECISION_OPTIMISTIC_BUDGET_MS}ms) durable: ${elapsed.durable.toFixed(1)}ms (budget ${DECISION_DURABLE_BUDGET_MS}ms)`,
    );

    // The optimistic budget is the strict gate. If the row never gained
    // a decision attribute we fail informatively (elapsed = -1 → fails
    // the < check).
    expect(
      elapsed.optimistic,
      `decision optimistic took ${elapsed.optimistic.toFixed(1)}ms (budget ${DECISION_OPTIMISTIC_BUDGET_MS}ms)`,
    ).toBeGreaterThan(0);
    expect(
      elapsed.optimistic,
      `decision optimistic took ${elapsed.optimistic.toFixed(1)}ms (budget ${DECISION_OPTIMISTIC_BUDGET_MS}ms)`,
    ).toBeLessThan(DECISION_OPTIMISTIC_BUDGET_MS);
    // Cycle-2 C6 (PR #21): durable is also a strict gate. The previous
    // shape only checked `< 200` — with the page.evaluate fallback at
    // L349 (`if (durable === -1) durable = optimistic`), a durable mark
    // that never appeared would silently pass because the optimistic
    // value (e.g., 12ms) is well under 200. Both guards below close the
    // gap: durable must have been distinctly observed (not equal to the
    // optimistic fallback) AND it must be > 0 (i.e., it actually ran).
    // F2's pattern from open-packet/modal-open is mirrored here.
    expect(
      elapsed.durable,
      `decision durable mark never observed — fallback was applied (optimistic=${elapsed.optimistic.toFixed(1)}ms, durable=${elapsed.durable.toFixed(1)}ms)`,
    ).not.toBe(elapsed.optimistic);
    expect(
      elapsed.durable,
      `decision durable measurement did not capture (durable=${elapsed.durable})`,
    ).toBeGreaterThan(0);
    expect(
      elapsed.durable,
      `decision durable took ${elapsed.durable.toFixed(1)}ms (budget ${DECISION_DURABLE_BUDGET_MS}ms)`,
    ).toBeLessThan(DECISION_DURABLE_BUDGET_MS);
  });
});
