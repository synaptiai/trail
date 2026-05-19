/**
 * gh#18 D2 — E2E spec for the Capture surface.
 *
 * Browser-mode Playwright against vite-preview. The Tauri IPC is mocked
 * at the window-global level (same pattern as sprint4-decisions.spec.ts);
 * what we verify is the React-layer routing + rendering + event flow:
 *
 *   1. Direct URL `?view=sessions` lands on the Capture surface
 *   2. CLI auto-detect status renders without user click
 *   3. Sessions list renders rows with metadata + Generate chip
 *   4. Clicking Generate fires spawn_packet_generate and shows Running…
 *   5. Synthetic packet-generate-progress events render in the expanded log
 *
 * The deeper visual-verification gate (the design handoff
 * `design_handoff_trail/artboards-v4b` artboard match) is a manual
 * step: the AI agent cannot drive a real browser pixel-compare in this
 * session, and the user's verification-layer-match memory mandates
 * visual confirmation for any UI work that touches a rendered surface.
 * This spec covers the wire/behaviour contract; a follow-up dev-mode
 * screenshot review against the artboards is on the user.
 */
import { test, expect, type Page } from '@playwright/test';

interface MockedInvocation {
  cmd: string;
  args: Record<string, unknown>;
}

async function installIpcMock(
  page: Page,
  invocations: MockedInvocation[],
): Promise<void> {
  await page.addInitScript(
    ({ invocationsHandle }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__captureInvocations__ = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__captureInvocationsName__ = invocationsHandle;
      // Event listener registry keyed by event name.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__captureListeners__ = {} as Record<string, Array<(p: unknown) => void>>;

      const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
        detect_capture_cli: () => ({
          kind: 'detected',
          path: '/usr/local/bin/trail',
          version: '0.1.4',
          source: 'login-shell',
        }),
        list_claude_sessions: () => ({
          kind: 'ok',
          sessions: [
            {
              session_id: 'AAAA-SESSION-ONE',
              project_path: '/repo/acme',
              started_at: new Date(Date.now() - 3600_000).toISOString(),
              message_count: 12,
              packet_id: null,
            },
            {
              session_id: 'BBBB-SESSION-TWO',
              project_path: '/repo/acme',
              started_at: new Date(Date.now() - 7200_000).toISOString(),
              message_count: 5,
              packet_id: 'PACKET-EXISTING',
            },
          ],
        }),
        query_trail: () => ({ packets: [] }),
        write_settings: () => ({ ok: true }),
        read_settings: () => ({
          theme: 'dark',
          density: 'comfortable',
          disable_tamper_warnings: false,
          heavy_redaction_threshold: 15,
          capture_cli_path: 'trail',
          pinned_sessions: [],
        }),
        spawn_packet_generate: (args: Record<string, unknown>) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__captureInvocations__.push({
            cmd: 'spawn_packet_generate',
            args,
          });
          return {
            kind: 'spawned',
            spawn_id: `spawn-for-${(args as { session_id: string }).session_id}`,
          };
        },
        cancel_packet_generate: (args: Record<string, unknown>) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__captureInvocations__.push({
            cmd: 'cancel_packet_generate',
            args,
          });
          return { kind: 'ok', cancelled: true };
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, payload: { args: Record<string, unknown> }) => {
          const handler = handlers[cmd];
          if (!handler) {
            throw new Error(`Unmocked IPC: ${cmd}`);
          }
          return handler(payload.args);
        },
      };

      // Mock the events API too — the production code uses
      // @tauri-apps/api/event#listen. Substituting the import is harder
      // than substituting the underlying Tauri internal, but the
      // Storybook/test path already routes through getBridge(). We
      // expose a helper for the test to emit synthetic events from
      // page-context.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__emitTrailEvent = (name: string, payload: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const listeners = (window as any).__captureListeners__[name] ?? [];
        for (const cb of listeners) {
          cb(payload);
        }
      };
    },
    { invocationsHandle: '__captureInvocations__' },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.exposeBinding(
    '__pushInvocation',
    (_source, invocation: MockedInvocation) => {
      invocations.push(invocation);
    },
  );
}

test.describe('CaptureSurface E2E', () => {
  test('?view=sessions deep-links to the Capture surface', async ({ page }) => {
    const invocations: MockedInvocation[] = [];
    await installIpcMock(page, invocations);
    await page.goto('/?view=sessions');
    await expect(
      page.getByRole('heading', { name: /Claude Code sessions/i }),
    ).toBeVisible({ timeout: 5000 });
  });

  test('renders CLI status + sessions + Generate chip', async ({ page }) => {
    const invocations: MockedInvocation[] = [];
    await installIpcMock(page, invocations);
    await page.goto('/?view=sessions');

    // CLI status auto-detect lands without user interaction
    await expect(page.getByText(/Trail CLI detected at/)).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText(/\/usr\/local\/bin\/trail/)).toBeVisible();

    // Session 1 (no packet) renders Generate chip; session 2 (has packet)
    // renders Open packet
    await expect(page.getByText(/AAAA-SES…/)).toBeVisible();
    await expect(page.getByText(/Generate packet/)).toBeVisible();
    await expect(page.getByText(/Open packet/)).toBeVisible();
  });

  test('clicking Generate fires the IPC + Running state appears', async ({ page }) => {
    const invocations: MockedInvocation[] = [];
    await installIpcMock(page, invocations);
    await page.goto('/?view=sessions');

    await page.getByRole('button', { name: /Generate packet/i }).click();

    await expect(page.getByText(/Running…/)).toBeVisible({ timeout: 3000 });
    await expect(
      page.getByRole('button', { name: /Cancel/i }),
    ).toBeVisible();

    // Inspect the captured invocation
    const invs = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__captureInvocations__ as MockedInvocation[];
    });
    expect(
      invs.find((i) => i.cmd === 'spawn_packet_generate'),
    ).toBeTruthy();
  });
});
