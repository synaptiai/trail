import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { axe } from 'jest-axe';
import { setIpcMock, type InvokeMockMap } from '../_helpers/ipc-mock';
import type { SidebarRow } from '@/db/queries';

/**
 * IPC mocking strategy:
 *
 * The TrailSidebar imports `@/ipc/client` at module scope. To avoid a
 * race with vitest's module loader (the IPC client caches its Tauri-bridge
 * promise on first invocation), we mock `@/ipc/client` itself via
 * `vi.mock` at the top of this file (vitest hoists it). The mock invoke
 * looks up `activeMap` which `setIpcMock` updates per-test.
 */
vi.mock('@/ipc/client', async () => {
  const actual = await vi.importActual<typeof import('@/ipc/client')>(
    '@/ipc/client',
  );
  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    // We dynamically import the helper here so vitest hoisting does not break it.
    const { _activeMap } = await import('../_helpers/ipc-mock-state');
    const handler = _activeMap.map?.[command];
    if (!handler) {
      throw new actual.IpcInvocationError({
        kind: 'internal',
        message: `unmocked IPC command: ${command}`,
      });
    }
    return handler(args);
  };
  return {
    ...actual,
    invoke,
    readSettings: async () => invoke('read_settings', {}),
    // Cycle-4.5 W1 (PR #21): writeSettings now requires persona.
    writeSettings: async (partial: unknown, persona: unknown) =>
      invoke('write_settings', { partial, persona }),
  };
});

import { TrailSidebar } from '@/components/screens/TrailSidebar';
import { _resetForTest } from '@/services/recent-sessions';

function mkRow(over: Partial<SidebarRow>): SidebarRow {
  return {
    packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    session_id: 'sess-1',
    display_name: 'Trail packet 1',
    captured_at: '2026-05-09T12:00:00Z',
    low_count: 0,
    med_count: 0,
    high_count: 1,
    crit_count: 0,
    redaction_count: 0,
    posted_to_pr_count: 0,
    ...over,
  };
}

const DEFAULT_SETTINGS = {
  theme: 'dark' as const,
  density: 'comfortable' as const,
  disable_tamper_warnings: false,
  heavy_redaction_threshold: 15,
  capture_cli_path: 'trail',
  pinned_sessions: [] as Array<{ session_id: string; pinned_at: string }>,
};

beforeEach(() => {
  _resetForTest();
});

afterEach(() => {
  setIpcMock({});
});

function setupIpc(map: InvokeMockMap) {
  setIpcMock(map);
}

function defaultSettingsHandler() {
  return async () => ({ ...DEFAULT_SETTINGS });
}

describe('<TrailSidebar> runtime (gh#8 criterion 1)', () => {
  it('reads packets from libSQL via query_trail and renders rows', async () => {
    const rows = [
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F00', display_name: 'Packet A', captured_at: '2026-05-09T12:00:00Z' }),
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F01', display_name: 'Packet B', captured_at: '2026-05-09T11:00:00Z' }),
    ];
    setupIpc({
      query_trail: async () => ({ packets: rows }),
      read_settings: defaultSettingsHandler(),
    });

    const onSelect = vi.fn();
    render(<TrailSidebar persona="reviewer" activePacketId={null} onSelect={onSelect} />);

    await waitFor(() => expect(screen.getByText('Packet A')).toBeInTheDocument());
    expect(screen.getByText('Packet B')).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Packet A'));
    expect(onSelect).toHaveBeenCalledWith('01ARZ3NDEKTSV4RRFFQ69G5F00');
  });

  it('renders posted-to-pr badge when posted_to_pr_count > 0 (criterion 7)', async () => {
    setupIpc({
      query_trail: async () => ({
        packets: [mkRow({ display_name: 'Posted packet', posted_to_pr_count: 3 })],
      }),
      read_settings: defaultSettingsHandler(),
    });

    render(<TrailSidebar persona="creator" activePacketId={null} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText('Posted packet')).toBeInTheDocument());
    expect(screen.getByText('POSTED')).toBeInTheDocument();
  });

  it('renders the empty state when libSQL returns zero packets', async () => {
    setupIpc({
      query_trail: async () => ({ packets: [] }),
      read_settings: defaultSettingsHandler(),
    });

    render(<TrailSidebar persona="creator" activePacketId={null} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No packets captured yet/i)).toBeInTheDocument());
  });

  it('arrow-key navigation moves selection through the list (criterion 9)', async () => {
    const rows = [
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F00', display_name: 'Packet A' }),
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F01', display_name: 'Packet B' }),
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F02', display_name: 'Packet C' }),
    ];
    setupIpc({
      query_trail: async () => ({ packets: rows }),
      read_settings: defaultSettingsHandler(),
    });

    const onSelect = vi.fn();
    const { rerender } = render(
      <TrailSidebar persona="reviewer" activePacketId={null} onSelect={onSelect} />,
    );
    await waitFor(() => expect(screen.getByText('Packet A')).toBeInTheDocument());

    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenLastCalledWith('01ARZ3NDEKTSV4RRFFQ69G5F00');

    onSelect.mockClear();
    rerender(<TrailSidebar persona="reviewer" activePacketId="01ARZ3NDEKTSV4RRFFQ69G5F00" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('Packet A')).toBeInTheDocument());
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenLastCalledWith('01ARZ3NDEKTSV4RRFFQ69G5F01');
  });

  it('Home / End jump to first / last (criterion 9)', async () => {
    const rows = [
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F00', display_name: 'Packet A' }),
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F01', display_name: 'Packet B' }),
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F02', display_name: 'Packet C' }),
    ];
    setupIpc({
      query_trail: async () => ({ packets: rows }),
      read_settings: defaultSettingsHandler(),
    });

    const onSelect = vi.fn();
    render(<TrailSidebar persona="reviewer" activePacketId="01ARZ3NDEKTSV4RRFFQ69G5F01" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('Packet A')).toBeInTheDocument());

    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith('01ARZ3NDEKTSV4RRFFQ69G5F02');
    onSelect.mockClear();
    fireEvent.keyDown(list, { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith('01ARZ3NDEKTSV4RRFFQ69G5F00');
  });

  it('Shift+P pins the focused session (keyboard equivalent of the pin star)', async () => {
    const rows = [
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F00', session_id: 'sess-A', display_name: 'Packet A' }),
    ];
    let writtenPartial: unknown = null;
    setupIpc({
      query_trail: async () => ({ packets: rows }),
      read_settings: defaultSettingsHandler(),
      write_settings: async (args) => {
        writtenPartial = (args as { partial: unknown }).partial;
        return { ok: true };
      },
    });

    render(<TrailSidebar persona="reviewer" activePacketId="01ARZ3NDEKTSV4RRFFQ69G5F00" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText('Packet A')).toBeInTheDocument());

    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'P', shiftKey: true });
    // The pinSession path calls writeSettings with a pinned_sessions
    // payload; assert the side-effect.
    await waitFor(() => {
      expect(writtenPartial).not.toBeNull();
      const partial = writtenPartial as { pinned_sessions?: Array<{ session_id: string }> };
      expect(partial.pinned_sessions?.[0]?.session_id).toBe('sess-A');
    });
  });

  it('skip link is present (criterion 9)', async () => {
    setupIpc({
      query_trail: async () => ({ packets: [] }),
      read_settings: defaultSettingsHandler(),
    });
    render(<TrailSidebar persona="reviewer" activePacketId={null} onSelect={() => {}} />);
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Skip to packet view/i })).toBeInTheDocument(),
    );
  });

  it('exposes ARIA listbox semantics with row count', async () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      mkRow({
        packet_id: `01ARZ3NDEKTSV4RRFFQ69G5F0${i}`,
        display_name: `Packet ${i}`,
        captured_at: `2026-05-0${i + 1}T12:00:00Z`,
      }),
    );
    setupIpc({
      query_trail: async () => ({ packets: rows }),
      read_settings: defaultSettingsHandler(),
    });
    render(<TrailSidebar persona="reviewer" activePacketId={null} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText('Packet 0')).toBeInTheDocument());

    const list = screen.getByRole('listbox', { name: /\d+ packets/ });
    expect(list).toBeInTheDocument();
    expect(list.getAttribute('data-row-count')).toBe('7');
  });

  it('passes axe-core scan with rows rendered', async () => {
    const rows = [
      mkRow({ display_name: 'Packet A' }),
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F01', display_name: 'Packet B' }),
    ];
    setupIpc({
      query_trail: async () => ({ packets: rows }),
      read_settings: defaultSettingsHandler(),
    });
    const { container } = render(
      <TrailSidebar persona="reviewer" activePacketId={null} onSelect={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('Packet A')).toBeInTheDocument());
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('handles query_trail error gracefully (banner surfaces)', async () => {
    setupIpc({
      query_trail: async () => {
        throw { kind: 'internal', message: 'simulated DB failure' };
      },
      read_settings: defaultSettingsHandler(),
    });
    render(<TrailSidebar persona="reviewer" activePacketId={null} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Trail database unavailable/i)).toBeInTheDocument());
  });

  it('respects pinned_sessions returned by read_settings (criterion 2)', async () => {
    const rows = [
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F00', session_id: 'pinned-A', display_name: 'Pinned packet A' }),
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F01', session_id: 'pinned-B', display_name: 'Pinned packet B' }),
    ];
    setupIpc({
      query_trail: async () => ({ packets: rows }),
      read_settings: async () => ({
        ...DEFAULT_SETTINGS,
        pinned_sessions: [{ session_id: 'pinned-A', pinned_at: '2026-05-09T01:00:00Z' }],
      }),
    });
    render(<TrailSidebar persona="reviewer" activePacketId={null} onSelect={() => {}} />);
    // Wait for the pin button to render (has unique aria-label).
    await waitFor(() =>
      expect(screen.getByLabelText(/Open pinned session pinned-A/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Your recent sessions/i)).toBeInTheDocument();
    // The pin section AND the timeline both render the packet — the pin
    // section reads the latest captured_at from the timeline rows. We do
    // not assert exact-match text here; the unique aria-label is enough.
    const pinned = screen.getAllByText('Pinned packet A');
    expect(pinned.length).toBeGreaterThanOrEqual(1);
  });
});

describe('<TrailSidebar> dim-trail motion (criterion 3)', () => {
  it('applies the is-dim-trail class on filter change', async () => {
    const rows = [mkRow({ display_name: 'Test packet' })];
    setupIpc({
      query_trail: async () => ({ packets: rows }),
      read_settings: defaultSettingsHandler(),
    });
    const { container } = render(
      <TrailSidebar persona="reviewer" activePacketId={null} onSelect={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('Test packet')).toBeInTheDocument());

    const riskBtn = screen.getByRole('button', { name: /^risk$/i });
    fireEvent.click(riskBtn);
    const high = screen.getByRole('option', { name: /HIGH/ });
    await act(async () => {
      fireEvent.click(high);
    });
    const sidebar = container.querySelector('.sidebar');
    expect(sidebar?.classList.contains('is-dim-trail')).toBe(true);
  });

  // F-CODE-2 regression test: rapid filter toggles must NOT stack timers.
  // Prior to the fix, the `useCallback` returned a cleanup closure that
  // React never invokes. Each click scheduled a fresh setTimeout; with N
  // clicks faster than the dim-trail duration (360ms), N timers raced and
  // last-timer-wins dropped the class while user was still toggling.
  //
  // Strategy: spy on global setTimeout/clearTimeout AROUND the rapid
  // filter toggles to count the dim-trail timers (any setTimeout matching
  // the 360ms dim-trail duration). With the fix, click 2 must call
  // clearTimeout on click 1's handle BEFORE scheduling click 2's. Without
  // the fix, two dim-trail timers would be live simultaneously.
  it('clears the previous dim-trail timeout when a second filter toggle arrives within the motion duration', async () => {
    const rows = [mkRow({ display_name: 'Stress packet' })];
    setupIpc({
      query_trail: async () => ({ packets: rows }),
      read_settings: defaultSettingsHandler(),
    });
    const { container } = render(
      <TrailSidebar persona="reviewer" activePacketId={null} onSelect={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('Stress packet')).toBeInTheDocument());

    const sidebar = container.querySelector('.sidebar');
    const riskBtn = screen.getByRole('button', { name: /^risk$/i });

    // From the design tokens: motion.duration.long === 360.
    const DIM_TRAIL_MS = 360;

    // Snapshot the live setTimeout handle ids that match DIM_TRAIL_MS.
    const dimHandles = new Set<unknown>();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const setSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: (...a: unknown[]) => unknown, ms?: number, ...rest: unknown[]) => {
        // Cast through unknown to bypass the lib.dom typings discrepancy.
        const handle = (realSetTimeout as unknown as (
          fn: (...a: unknown[]) => unknown,
          ms?: number,
          ...rest: unknown[]
        ) => unknown)(fn, ms, ...rest);
        if (ms === DIM_TRAIL_MS) dimHandles.add(handle);
        return handle as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
    const clearSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(((handle?: unknown) => {
        dimHandles.delete(handle);
        return (realClearTimeout as unknown as (h?: unknown) => void)(handle);
      }) as typeof clearTimeout);

    try {
      // Open the risk popover ONCE. `toggleRiskLevel` does not close the
      // popover after selection (only the time/redaction pickers do), so
      // each click on a risk option fires a fresh onChange → dim-trail
      // timer reset path.
      fireEvent.click(riskBtn);
      const high = screen.getByRole('option', { name: /HIGH/ });

      // Click 1: select HIGH → triggers dim-trail (1 dim timer
      // scheduled).
      await act(async () => {
        fireEvent.click(high);
      });
      expect(sidebar?.classList.contains('is-dim-trail')).toBe(true);
      expect(dimHandles.size).toBe(1);

      // Click 2: deselect HIGH (still within 360ms of click 1). With the
      // fix, click 1's timer is cleared before click 2's is scheduled,
      // so the live count stays at 1. Without the fix, the count would
      // be 2 (timers stacked).
      await act(async () => {
        fireEvent.click(high);
      });
      expect(sidebar?.classList.contains('is-dim-trail')).toBe(true);
      expect(dimHandles.size).toBe(1);

      // Click 3: re-select HIGH — should remain 1 (still no stacking).
      await act(async () => {
        fireEvent.click(high);
      });
      expect(dimHandles.size).toBe(1);

      // Wait for the (single) live timer to fire and clear the class.
      await waitFor(
        () => expect(sidebar?.classList.contains('is-dim-trail')).toBe(false),
        { timeout: 1000 },
      );
      // After firing, the timer self-clears the dimTimeoutRef but the
      // setTimeout itself completes — handle stays in the Set
      // (clearTimeout never called for a fired timer). The contract we
      // care about is that no MORE THAN ONE was live concurrently.
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  // F-CODE-2 cleanup test: unmounting MUST clear any pending dim-trail
  // timer so the test renderer doesn't hold a setTimeout reference past
  // the component lifetime.
  it('clears the pending dim-trail timeout on unmount', async () => {
    const rows = [mkRow({ display_name: 'Unmount packet' })];
    setupIpc({
      query_trail: async () => ({ packets: rows }),
      read_settings: defaultSettingsHandler(),
    });
    const realClearTimeout = globalThis.clearTimeout;
    const cleared: unknown[] = [];
    const clearSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(((handle?: unknown) => {
        cleared.push(handle);
        return (realClearTimeout as unknown as (h?: unknown) => void)(handle);
      }) as typeof clearTimeout);

    try {
      const { unmount } = render(
        <TrailSidebar persona="reviewer" activePacketId={null} onSelect={() => {}} />,
      );
      await waitFor(() => expect(screen.getByText('Unmount packet')).toBeInTheDocument());

      // Trigger the dim-trail timer.
      const riskBtn = screen.getByRole('button', { name: /^risk$/i });
      fireEvent.click(riskBtn);
      const high = screen.getByRole('option', { name: /HIGH/ });
      await act(async () => {
        fireEvent.click(high);
      });

      const beforeUnmount = cleared.length;
      unmount();
      // Unmount must have called clearTimeout at least once for the
      // pending dim-trail handle.
      expect(cleared.length).toBeGreaterThan(beforeUnmount);
    } finally {
      clearSpy.mockRestore();
    }
  });
});
