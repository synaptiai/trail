/**
 * M4 Post-to-PR modal unit tests (gh#12 AC-2 destination confirm,
 * AC-3 P3 sync, AC-7 error handling, AC-8 edge flows).
 *
 * Cycle-1.5 F3: adds axe-core a11y assertion (parity with M3 / M5).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockHandler {
  (args: Record<string, unknown>): Promise<unknown> | unknown;
}
const mockHandlers: { current: Record<string, MockHandler> } = { current: {} };

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window.__TAURI_INTERNALS__ = { callbacks: {}, plugins: {} };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    const handler = mockHandlers.current[cmd];
    if (!handler) throw { kind: 'internal', message: `unmocked: ${cmd}` };
    return handler(args);
  },
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

import { M4PostToPrModal } from '@/components/screens/M4PostToPrModal';

const VALID_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function setHandlers(map: Record<string, MockHandler>) {
  mockHandlers.current = map;
}

describe('<M4PostToPrModal> destination confirmation (gh#12 AC-2)', () => {
  beforeEach(() => setHandlers({}));
  afterEach(() => setHandlers({}));

  it('shows the detected destination in the confirm stage', () => {
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="synaptiai/trail#432"
      />,
    );
    const dest = screen.getByTestId('m4-destination');
    expect(dest.textContent).toContain('synaptiai/trail#432');
  });

  it('post button is enabled by default (no override required)', () => {
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="synaptiai/trail#432"
      />,
    );
    expect(
      (screen.getByTestId('m4-confirm-post') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('rejects non-numeric PR override and disables Post', () => {
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="x/y#1"
      />,
    );
    fireEvent.change(screen.getByTestId('m4-pr-input'), {
      target: { value: 'abc' },
    });
    expect(
      (screen.getByTestId('m4-confirm-post') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('PR override updates the destination display', () => {
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="synaptiai/trail#432"
      />,
    );
    fireEvent.change(screen.getByTestId('m4-pr-input'), {
      target: { value: '999' },
    });
    expect(screen.getByTestId('m4-destination').textContent).toContain(
      'synaptiai/trail#999',
    );
  });

  it('renders re-post variant when lastPosted is supplied (CR-GH-02)', () => {
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="synaptiai/trail#432"
        lastPosted={{
          pr_url: 'https://github.com/synaptiai/trail/pull/432',
          pr_number: 432,
          posted_at: '2026-05-01T10:00:00+00:00',
        }}
      />,
    );
    expect(screen.getByText('Re-post packet to PR')).toBeInTheDocument();
    expect(screen.getByTestId('m4-last-posted').textContent).toContain('432');
    expect(screen.getByTestId('m4-confirm-post').textContent).toBe('Re-post');
  });

  // Cycle-1.5 F3 (gh#12): a11y scan parity with Sprint 4 modals.
  it('passes axe a11y scan (confirm stage)', async () => {
    const { container } = render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="synaptiai/trail#432"
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('flags destination change vs last-posted (B6 P1 hardening)', () => {
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="synaptiai/trail#999"
        lastPosted={{
          pr_url: 'https://github.com/synaptiai/trail/pull/432',
          pr_number: 432,
          posted_at: '2026-05-01T10:00:00+00:00',
        }}
      />,
    );
    const dest = screen.getByTestId('m4-destination');
    expect(dest.className).toContain('m4__destination--changed');
    expect(dest.textContent).toContain('destination changed');
  });
});

describe('<M4PostToPrModal> post flow (gh#12 AC-3, AC-5)', () => {
  beforeEach(() => setHandlers({}));
  afterEach(() => setHandlers({}));

  it('successful post surfaces pr_url + body_hash_prefix', async () => {
    setHandlers({
      post_to_pr: async () => ({
        ok: true,
        pr_url: 'https://github.com/synaptiai/trail/pull/432',
        destination: 'synaptiai/trail#432',
        body_hash_prefix: '0123456789abcdef',
      }),
    });
    const onPosted = vi.fn();
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="synaptiai/trail#432"
        onPosted={onPosted}
      />,
    );
    await act(async () => {
      screen.getByTestId('m4-confirm-post').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('m4-success-detail')).toBeInTheDocument();
    });
    const success = screen.getByTestId('m4-success-detail');
    expect(success.textContent).toContain('synaptiai/trail/pull/432');
    expect(success.textContent).toContain('0123456789abcdef');
    expect(onPosted).toHaveBeenCalledTimes(1);
  });

  it('forwards pr_number override to the IPC', async () => {
    let received: Record<string, unknown> | null = null;
    setHandlers({
      post_to_pr: async (args) => {
        received = args;
        return { ok: true, pr_url: 'https://example.com/pr/777', destination: 'a/b#777' };
      },
    });
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="a/b#1"
      />,
    );
    fireEvent.change(screen.getByTestId('m4-pr-input'), { target: { value: '777' } });
    await act(async () => {
      screen.getByTestId('m4-confirm-post').click();
    });
    await waitFor(() => {
      expect(received).not.toBeNull();
    });
    expect((received as unknown as Record<string, unknown>).pr_number).toBe(777);
  });
});

describe('<M4PostToPrModal> error handling (gh#12 AC-7, AC-8)', () => {
  beforeEach(() => setHandlers({}));
  afterEach(() => setHandlers({}));

  it('E3 — gh-not-authenticated triggers onAuthFailed callback', async () => {
    setHandlers({
      post_to_pr: async () => {
        throw { kind: 'gh-not-authenticated', message: 'not logged in' };
      },
    });
    const onAuthFailed = vi.fn();
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="x/y#1"
        onAuthFailed={onAuthFailed}
      />,
    );
    await act(async () => {
      screen.getByTestId('m4-confirm-post').click();
    });
    await waitFor(() => {
      expect(onAuthFailed).toHaveBeenCalledWith('not logged in');
    });
    expect(screen.getByTestId('m4-edge-kind-gh-auth-fail')).toBeInTheDocument();
  });

  it('E6 — network failure surfaces network-failure Banner', async () => {
    setHandlers({
      post_to_pr: async () => {
        throw {
          kind: 'gh-cli-error',
          stderr: '[network-or-rate-limit] dial tcp: i/o timeout',
          exit_code: 7,
          message: 'net',
        };
      },
    });
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="x/y#1"
      />,
    );
    await act(async () => {
      screen.getByTestId('m4-confirm-post').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('m4-edge-kind-network-failure')).toBeInTheDocument();
    });
  });

  it('E4 — gh CLI absent surfaces gh-missing Banner', async () => {
    setHandlers({
      post_to_pr: async () => {
        throw {
          kind: 'gh-cli-error',
          stderr: '[gh-missing] gh not on PATH',
          exit_code: 4,
          message: 'missing',
        };
      },
    });
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="x/y#1"
      />,
    );
    await act(async () => {
      screen.getByTestId('m4-confirm-post').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('m4-edge-kind-gh-missing')).toBeInTheDocument();
    });
  });

  // gh#12 cycle-1.5 F11 (AC-8): when the gh CLI is missing, the
  // recovery action MUST be a real action (open install instructions),
  // not the default Retry that fails again. The original cycle-1
  // implementation rendered Retry universally, so users hit a loop.
  it('F11 regression: gh-missing replaces Retry with Open install instructions', async () => {
    setHandlers({
      post_to_pr: async () => {
        throw {
          kind: 'gh-cli-error',
          stderr: '[gh-missing] gh not on PATH',
          exit_code: 4,
          message: 'missing',
        };
      },
    });
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="x/y#1"
      />,
    );
    await act(async () => {
      screen.getByTestId('m4-confirm-post').click();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('m4-open-install-instructions'),
      ).toBeInTheDocument();
    });
    // The Retry button MUST NOT be present when gh-missing — clicking
    // it would re-fire post_to_pr and fail again. Only the install
    // instructions button should appear.
    expect(screen.queryByTestId('m4-retry')).toBeNull();
    const button = screen.getByTestId(
      'm4-open-install-instructions',
    ) as HTMLButtonElement;
    expect(button.textContent).toContain('Open install instructions');
  });

  // gh#12 cycle-1.5 F4 (AC-7): packet-not-found and pr-not-found surface
  // distinct edge kinds in the M4 modal — verify the edge-kind testid
  // discriminator differs.
  it('F4 regression: packet-not-found IPC surfaces packet-not-found edge kind', async () => {
    setHandlers({
      post_to_pr: async () => {
        throw {
          kind: 'packet-not-found',
          message: 'packet YAML missing on disk',
        };
      },
    });
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="x/y#1"
      />,
    );
    await act(async () => {
      screen.getByTestId('m4-confirm-post').click();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('m4-edge-kind-packet-not-found'),
      ).toBeInTheDocument();
    });
    // Critical: must NOT be the pr-not-found discriminator (cycle-1 bug).
    expect(screen.queryByTestId('m4-edge-kind-pr-not-found')).toBeNull();
  });

  it('F4 regression: pr-not-found IPC surfaces pr-not-found edge kind (distinct from packet)', async () => {
    setHandlers({
      post_to_pr: async () => {
        throw {
          kind: 'pr-not-found',
          message: 'no PR for branch X',
        };
      },
    });
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="x/y#1"
      />,
    );
    await act(async () => {
      screen.getByTestId('m4-confirm-post').click();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('m4-edge-kind-pr-not-found'),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId('m4-edge-kind-packet-not-found')).toBeNull();
  });

  it('Retry re-runs the post after error', async () => {
    let attempt = 0;
    setHandlers({
      post_to_pr: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw {
            kind: 'gh-cli-error',
            stderr: '[network-or-rate-limit] timeout',
            exit_code: 7,
            message: 'net',
          };
        }
        return {
          ok: true,
          pr_url: 'https://example.com/pr/1',
          destination: 'x/y#1',
          body_hash_prefix: 'aa',
        };
      },
    });
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        persona="creator"
        detectedDestination="x/y#1"
      />,
    );
    await act(async () => {
      screen.getByTestId('m4-confirm-post').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('m4-retry')).toBeInTheDocument();
    });
    await act(async () => {
      screen.getByTestId('m4-retry').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('m4-success-detail')).toBeInTheDocument();
    });
    expect(attempt).toBe(2);
  });
});

// Cycle-4.5 W9 (PR #21): the persona-forbidden Banner copy was wired
// into classifyGhError + M4 in cycle-3 C1, but no test exercised
// rendering at the React layer — only the classification function
// itself. Without an integration-level render test, a regression that
// silently changed the title or removed the auditor-mode-is-read-only
// copy would only surface in manual QA. This block pins the rendered
// Banner end-to-end: throw the raw `persona-forbidden` IPC error from
// the post_to_pr handler, click the post button, and assert the
// auditor-readable title + body land in the DOM.
describe('<M4PostToPrModal> persona-forbidden Banner (cycle-4.5 W9)', () => {
  beforeEach(() => setHandlers({}));
  afterEach(() => setHandlers({}));

  it('renders persona-forbidden Banner when post_to_pr throws PersonaForbidden', async () => {
    setHandlers({
      post_to_pr: async () => {
        // Raw shape the Rust handler emits via serde — exercises
        // asIpcError → ipcErrorSchema → typed IpcInvocationError →
        // classifyGhError → ClassifiedEdgeFlow round-trip.
        throw {
          kind: 'persona-forbidden',
          persona: 'auditor',
          command: 'post_to_pr',
        };
      },
    });
    render(
      <M4PostToPrModal
        open
        onClose={() => {}}
        packetId={VALID_ULID}
        // The UI gate prevents auditor from reaching M4 in practice;
        // this test exercises the defence-in-depth path where the
        // Rust handler rejects regardless.
        persona="auditor"
        detectedDestination="x/y#1"
      />,
    );
    await act(async () => {
      screen.getByTestId('m4-confirm-post').click();
    });
    // The kind tag pinpoints the routed edge flow.
    await waitFor(() => {
      expect(
        screen.getByTestId('m4-edge-kind-persona-forbidden'),
      ).toBeInTheDocument();
    });
    // Banner title + body must surface the auditor copy.
    expect(screen.getByText(/Auditor mode is read-only/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Auditors cannot post packets or PR decisions/i),
    ).toBeInTheDocument();
  });
});
