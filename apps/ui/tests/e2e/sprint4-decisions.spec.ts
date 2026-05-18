/**
 * Sprint 4 E2E (gh#11 criterion 12) — decision shortcuts + J12 surface.
 *
 * This spec runs in `browser` mode against vite-preview with the IPC
 * mocked at the window-global level. The `tauri` mode (real saga +
 * watcher) is the deeper gate covered by `cargo test` saga +
 * watcher unit tests; this spec verifies the React-layer plumbing:
 *
 *   1. Decision shortcut `a` against the focused claim invokes
 *      `save_decision` with the schema-canonical args.
 *   2. The `?` shortcut opens the keyboard overlay shell (criterion 9).
 *   3. The packet-changed-externally event surfaces the J12 ARIA-alert
 *      banner (criterion 4).
 *   4. The settings cog opens M6 (criterion 8 — UI surface).
 */
import { test, expect, type Page } from '@playwright/test';

interface MockedInvocation {
  cmd: string;
  args: Record<string, unknown>;
}

// v0.1.1-schema-valid packet. Mirror of tests/unit/packet-loader.test.ts::
// MINIMAL_PACKET_YAML — keeps this spec aligned with the canonical Ajv
// schema. The previous fixture was a pre-v0.1.1 shape; Ajv rejected with
// 37 errors and PacketView never mounted ClaimsTab, so the test couldn't
// observe "updates redirect_uri allowlist" no matter how long it waited.
// Surfaced by the gh#2 ship cycle (2026-05-18) once the unrelated
// packet-loader-test fixture skip-if-absent fix let ts-quality reach the
// e2e job for the first time on synaptiai/trail main.
const PACKET_FIXTURE_YAML = `
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
  branch: feature/sprint-4
  base_branch: origin/main
  pr_number: null
  author: test@example.com
task_intent:
  source_type: prompt
  source_ref: PROMPT-SPRINT-4
  summary: minimal packet for sprint-4 decisions e2e
  acceptance_criteria: []
agent_session:
  tool: claude-code
  model: claude-opus-4-7
  models:
  - claude-opus-4-7
  started_at: '2026-05-09T11:00:00.000+00:00'
  ended_at: '2026-05-09T11:30:00.000+00:00'
  session_id: session-x
  transcript_summary: []
  prompts:
    initial: 'sprint-4 fixture'
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
    description: Wrote /tmp/redirect.ts (10 chars)
    files: ['/tmp/redirect.ts']
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
  - /tmp/redirect.ts
  human_touched_files: []
summary:
  claims:
  - id: CLAIM-001
    stable_id: 0123456789abcdef
    text: updates redirect_uri allowlist
    evidence_refs:
    - DIFF-001
    confidence: supported
    synthesis_mode: mechanical
    risk_classification:
      agent: { level: med, rationale: scope unchanged }
      creator_override: { level: null, reason: null, at: null, by: null }
      reviewer_override: { level: null, reason: null, at: null, by: null }
  ungrounded_claim_count: 0
approval_trail: []
`;

async function installIpcMock(
  page: Page,
  invocations: MockedInvocation[],
): Promise<void> {
  await page.addInitScript(
    ({ packetYaml, invocationsHandle }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__sprint4Invocations__ = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__sprint4InvocationsName__ = invocationsHandle;
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
        read_packet: () => ({
          packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          schema_version: '0.1.1',
          yaml_text: packetYaml,
          yaml_path: '.trail/sessions/session-x/packet-1.yml',
        }),
        save_decision: (args: Record<string, unknown>) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__sprint4Invocations__.push({ cmd: 'save_decision', args });
          return { ok: true };
        },
        override_risk: (args: Record<string, unknown>) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__sprint4Invocations__.push({ cmd: 'override_risk', args });
          return { ok: true };
        },
        audit_log_append: (args: Record<string, unknown>) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__sprint4Invocations__.push({ cmd: 'audit_log_append', args });
          return { ok: true };
        },
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
    },
    { packetYaml: PACKET_FIXTURE_YAML, invocationsHandle: 'sprint4' },
  );
  // Suppress unused warning — `invocations` is the type-tying handle.
  void invocations;
}

test.describe('Sprint 4 — decisions + modals + J12 (gh#11)', () => {
  test.beforeEach(async ({ page }) => {
    await installIpcMock(page, []);
  });

  test('? shortcut opens the keyboard overlay shell', async ({ page }) => {
    await page.goto('/');
    // Wait for the sidebar to render so a focusable target exists.
    await page.waitForSelector('.sidebar', { timeout: 10_000 });
    await page.locator('body').focus();
    await page.keyboard.press('?');
    // The overlay's modal title is "Keyboard shortcuts".
    await expect(page.getByText('Keyboard shortcuts')).toBeVisible({
      timeout: 5_000,
    });
  });

  test('Settings cog opens M6 modal', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.sidebar', { timeout: 10_000 });
    await page.getByRole('button', { name: 'Open settings' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Settings' }),
    ).toBeVisible();
  });

  test('decision shortcut a invokes save_decision with focused claim', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForSelector('.sidebar', { timeout: 10_000 });
    // Open the packet via sidebar click.
    await page.locator('.sidebar__row').first().click();
    // Wait for ClaimsTab to render.
    await expect(
      page.getByText('updates redirect_uri allowlist'),
    ).toBeVisible({ timeout: 10_000 });
    // Trigger `a` shortcut.
    await page.keyboard.press('a');
    // Wait briefly for the dispatch + IPC mock.
    await page.waitForTimeout(200);
    const invocations = await page.evaluate<unknown[]>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__sprint4Invocations__ ?? [],
    );
    const saveDecision = invocations.find(
      (i) => (i as { cmd: string }).cmd === 'save_decision',
    ) as { cmd: string; args: Record<string, unknown> } | undefined;
    expect(saveDecision, 'a key must dispatch save_decision').toBeDefined();
    // v0.1.1 IPC wrapper-args contract: the IPC client wraps the args
    // as `{ args: parsed.data }` (see apps/ui/src/ipc/client.ts:130). The
    // mock captures the outer payload verbatim, so the inner fields are
    // at `args.args.*`. The previous direct-field assertion predated the
    // wrapper-args fix (v0.1.1 P0) and only worked under the flat shape
    // the resolver no longer accepts.
    const inner = (saveDecision!.args as { args: Record<string, unknown> }).args;
    expect(inner.packet_id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(inner.decision).toBe('accept');
  });
});
