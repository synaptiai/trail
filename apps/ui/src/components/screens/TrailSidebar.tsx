import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import {
  Banner,
  Chip,
  EmptyState,
  HorizonLine,
  Risk,
  Skeleton,
} from '@/components/primitives';
import { invoke, IpcUnavailableError, readSettings } from '@/ipc/client';
import type { Persona, Settings } from '@/ipc/contract';
import { tokens } from '@/design/tokens';
import {
  dominantRisk,
  formatAge,
  type SidebarRow,
  timeCluster,
} from '@/db/queries';
import {
  loadPinnedSessions,
  pinSession,
  unpinSession,
  enrichPinsWithLatestPacket,
  type PinnedSession,
} from '@/services/recent-sessions';
import {
  EMPTY_FILTER,
  TrailFilters,
  toIpcFilter,
  type TrailFiltersValue,
} from './TrailFilters';
import { IconRail } from './IconRail';
import './TrailSidebar.css';

/**
 * <TrailSidebar> — runtime trail browser (B4 §3, gh#8 acceptance criteria).
 *
 * This is the first persona-facing surface that exercises the full
 * libSQL → IPC → React data path. Sprint 1 shipped the schema; Sprint 2
 * boots it (criteria 1, 6) and wires the user-facing surface (criteria
 * 2-9).
 *
 * Architecture:
 *   - `query_trail` IPC fetches rows; the response is validated against
 *     `queryTrailResponseSchema` before reaching React state.
 *   - Pin state: `loadPinnedSessions` reads the persistent pin list from
 *     `~/.trail/settings.json` (criterion 2). The pin section's
 *     latest-packet metadata (display_name, captured_at) is JOINED
 *     in-memory against the timeline rows already loaded by `query_trail`
 *     via `enrichPinsWithLatestPacket`. (The Rust handler
 *     `query_recent_sessions` exists and is fully tested but is NOT
 *     wired from this surface as of Sprint 2 — see F-DOC-1 in the
 *     cycle-1 review. Sprint 3 may wire it for a live `packet_count`.)
 *   - Filter state lives in component state; on change, a TS transition
 *     defers the (potentially expensive) re-fetch + rerender behind
 *     React's concurrent renderer so the chip toggle stays at 60fps.
 *
 * Virtualization (criterion 5):
 *   - Custom windowed renderer; not a third-party library. We render only
 *     the rows whose computed top falls within `[scrollTop - overscan,
 *     scrollTop + viewportHeight + overscan]`. Row height is fixed to
 *     `--size-row-comfortable` (44px) per B4 §3.2 + B3 §15.2.
 *   - 1000-packet cold-render budget: ≤ 300ms (verified by Playwright).
 *
 * Accessibility (criterion 9):
 *   - The packet list is `role="listbox"`. Each row is `role="option"`
 *     with `aria-selected`. Roving-tabindex pattern: only the active row
 *     has `tabIndex=0`; arrow keys move focus + selection. Home/End jump
 *     to first / last. Skip-link navigates to the main content area.
 *
 * Dim-trail motion (criterion 3):
 *   - On filter change, non-matching rows fade to opacity 0.30 via
 *     `--trail-dim-opacity` for `--motion-base` ms (B3 §8.3). The
 *     reduced-motion media query (tokens.css) collapses the transition
 *     to instant.
 */

export interface TrailSidebarProps {
  persona: Persona;
  activePacketId: string | null;
  onSelect: (id: string) => void;
}

interface QueryTrailResponse {
  packets: SidebarRow[];
  next_cursor?: string;
}

const ROW_HEIGHT_PX = 44; // matches --size-row-comfortable token (B4 §3.2).
const VIRT_OVERSCAN_ROWS = 6; // render N rows above/below the viewport.
/**
 * Narrow-mode media query (B4 §3.3 + criterion 4).
 *
 * The breakpoint is `tokens.breakpoint.md` (1024). matchMedia queries
 * are STRINGS at runtime — the CSS custom-property cannot be
 * dereferenced inside `(max-width: ...)`. We compute the threshold from
 * the token value via a template literal so a future bump of the token
 * does not silently drift this constant.
 *
 * Lint exception: the lint rule's regex matches `\d+px` LITERALS in
 * source code (Literal + TemplateElement); the substitution
 * `${tokens.breakpoint.md - 1}px` produces the literal at runtime
 * after the parser has tokenised the file, and the token half is the
 * single source of truth.
 */
const NARROW_QUERY = `(max-width: ${tokens.breakpoint.md - 1}px)`;

export function TrailSidebar({ persona, activePacketId, onSelect }: TrailSidebarProps) {
  // ---- Data state -------------------------------------------------------
  const [rows, setRows] = useState<SidebarRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterUi, setFilterUi] = useState<TrailFiltersValue>(EMPTY_FILTER);
  const [pinned, setPinned] = useState<PinnedSession[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [isPending, startTransition] = useTransition();
  const [dimTrailActive, setDimTrailActive] = useState(false);

  // ---- Layout mode ------------------------------------------------------
  const [isNarrow, setIsNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(NARROW_QUERY).matches;
  });
  const [forceWide, setForceWide] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(NARROW_QUERY);
    const update = () => setIsNarrow(mql.matches);
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update);
      return () => mql.removeEventListener('change', update);
    }
    // Older Safari fallback.
    mql.addListener(update);
    return () => mql.removeListener(update);
  }, []);

  // ---- Initial settings + pinned-sessions load --------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await readSettings();
        if (!cancelled) setSettings(s);
      } catch (err) {
        if (!cancelled && !(err instanceof IpcUnavailableError)) {
          // Non-fatal: settings fall back to defaults; the tampering check
          // for HMAC happens at write time. Log only.
          console.warn('[TrailSidebar] readSettings failed:', err);
        }
      }
      try {
        const pins = await loadPinnedSessions();
        if (!cancelled) setPinned(pins);
      } catch (err) {
        if (!cancelled && !(err instanceof IpcUnavailableError)) {
          console.warn('[TrailSidebar] loadPinnedSessions failed:', err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Trail fetch ------------------------------------------------------
  const fetchTrail = useCallback(
    async (uiFilter: TrailFiltersValue) => {
      const ipcFilter = toIpcFilter(uiFilter);
      try {
        const result = await invoke<QueryTrailResponse>('query_trail', {
          filter: ipcFilter,
          limit: 500,
        });
        return result.packets;
      } catch (err) {
        if (err instanceof IpcUnavailableError) {
          // Outside the desktop shell. Surface an empty list so the
          // rendered surface still mounts (Storybook, vitest).
          return [];
        }
        throw err;
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchTrail(filterUi)
      .then((packets) => {
        if (cancelled) return;
        setRows(packets);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // persona reload covers J11 future-self resume — switching persona
    // refreshes the trail because reviewer/auditor see the same rows but
    // may have different sort/decoration rules in later sprints.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona, filterUi.risk_levels.join('|'), filterUi.time_window, filterUi.redaction]);

  // ---- Filter change handler with dim-trail motion ----------------------
  // F-CODE-2: the dim-trail timeout is tracked in a ref so rapid filter
  // toggles (faster than `tokens.motion.duration.long`/360ms) clear the
  // previous timer before scheduling a new one — preventing stacked timers
  // and dim-trail-class desync. The previous implementation returned a
  // cleanup closure from a `useCallback` that React never invokes.
  const dimTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup: clear any pending timer on unmount so the test renderer (and
  // the desktop on close) doesn't hold a setTimeout reference.
  useEffect(() => {
    return () => {
      if (dimTimeoutRef.current !== null) {
        clearTimeout(dimTimeoutRef.current);
        dimTimeoutRef.current = null;
      }
    };
  }, []);

  const handleFilterChange = useCallback((next: TrailFiltersValue) => {
    // Clear any pending dim-trail-deactivate from a prior, still-in-flight
    // filter change. Without this, rapid toggles stack timers and the
    // last-timer-wins race can drop the class while the user is still
    // toggling.
    if (dimTimeoutRef.current !== null) {
      clearTimeout(dimTimeoutRef.current);
      dimTimeoutRef.current = null;
    }
    setDimTrailActive(true);
    startTransition(() => {
      setFilterUi(next);
    });
    // Match the dim-trail CSS transition duration (--motion-long; 360ms).
    // Token-derived rather than hardcoded so a future bump of the token
    // does not silently desync the JS / CSS clocks.
    dimTimeoutRef.current = setTimeout(() => {
      setDimTrailActive(false);
      dimTimeoutRef.current = null;
    }, tokens.motion.duration.long);
  }, []);

  // ---- Pinned sessions UI ----------------------------------------------
  // Cycle-4.5 W1 (PR #21): persona threading on writeSettings — the
  // sidebar's pin/unpin handlers persist via writeSettings which now
  // requires persona. Auditor mode never reaches this path in v0.1
  // (no pin/unpin UI surfaces for read-only mode), but defence-in-depth
  // forwards persona regardless so the IPC + Rust handler agree.
  const handlePin = useCallback(
    async (sessionId: string) => {
      try {
        const next = await pinSession(sessionId, persona);
        setPinned(next);
      } catch (err) {
        console.warn('[TrailSidebar] pinSession failed:', err);
      }
    },
    [persona],
  );

  const handleUnpin = useCallback(
    async (sessionId: string) => {
      try {
        const next = await unpinSession(sessionId, persona);
        setPinned(next);
      } catch (err) {
        console.warn('[TrailSidebar] unpinSession failed:', err);
      }
    },
    [persona],
  );

  // Enrich pins with latest-packet info from the loaded rows so the pin
  // list shows the latest captured_at + display_name without an extra
  // IPC roundtrip.
  const enrichedPins = useMemo(() => enrichPinsWithLatestPacket(pinned, rows ?? []), [pinned, rows]);

  // ---- Active packet keyboard navigation -------------------------------
  // Per WCAG 2.1.1: every interaction has a keyboard path.
  //   - ArrowUp / ArrowDown / Home / End: select adjacent / first / last.
  //   - Shift+P (on focused row): pin the row's session.
  //   - Right-click / Shift+F10 (browser-native contextmenu): pin via
  //     the option button's onContextMenu handler.
  // The visible pin star (★ at the row's right edge) is a sighted-mouse
  // affordance ONLY — it's aria-hidden and offers no keyboard path of
  // its own; the keyboard equivalents above cover the functionality.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLElement | null>(null);

  const navigate = useCallback(
    (direction: 'prev' | 'next' | 'first' | 'last') => {
      if (!rows || rows.length === 0) return;
      const idx = activePacketId
        ? rows.findIndex((r) => r.packet_id === activePacketId)
        : -1;
      let nextIdx = idx;
      switch (direction) {
        case 'prev':
          nextIdx = idx <= 0 ? 0 : idx - 1;
          break;
        case 'next':
          nextIdx = idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1);
          break;
        case 'first':
          nextIdx = 0;
          break;
        case 'last':
          nextIdx = rows.length - 1;
          break;
      }
      const nextRow = rows[nextIdx];
      if (nextRow) onSelect(nextRow.packet_id);
    },
    [rows, activePacketId, onSelect],
  );

  const handleListKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        navigate('next');
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        navigate('prev');
      } else if (event.key === 'Home') {
        event.preventDefault();
        navigate('first');
      } else if (event.key === 'End') {
        event.preventDefault();
        navigate('last');
      } else if ((event.key === 'P' || event.key === 'p') && event.shiftKey) {
        // Shift+P pins the focused row's session. Keyboard equivalent for
        // the visible pin star (which is aria-hidden / mouse-only).
        if (rows && activePacketId) {
          const active = rows.find((r) => r.packet_id === activePacketId);
          if (active) {
            event.preventDefault();
            handlePin(active.session_id);
          }
        }
      }
    },
    [navigate, rows, activePacketId, handlePin],
  );

  // ---- Virtualization computation --------------------------------------
  //
  // The virtualizer maintains scrollTop + viewportHeight in state. On
  // mount, useLayoutEffect captures the listbox's clientHeight BEFORE the
  // browser paints; without this, the first paint happens with
  // viewportHeight=0 and the fallback path renders every row, busting
  // the 1000-packet budget on cold render.
  //
  // Fallback semantics: when viewportHeight cannot be determined (e.g.,
  // happy-dom test env), we render a CAPPED subset (--virt-fallback-rows)
  // rather than every row. This caps the worst-case DOM size at a known
  // budget instead of degrading silently to N=∞.
  const VIRT_FALLBACK_ROWS = 32;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Synchronously read the laid-out height so the FIRST paint already
    // has a sensible viewport — no all-1000-rows flash before the
    // virtualizer kicks in.
    setViewportHeight(el.clientHeight);
    setScrollTop(el.scrollTop);
  }, [rows]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () => {
      setScrollTop(el.scrollTop);
      setViewportHeight(el.clientHeight);
    };
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (ro && el) ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [rows]);

  const virtRange = useMemo(() => {
    if (!rows) return { startIndex: 0, endIndex: 0 };
    const total = rows.length;
    if (total === 0) return { startIndex: 0, endIndex: 0 };
    if (viewportHeight === 0) {
      // No layout yet — render a safe subset so the cold paint never
      // exceeds VIRT_FALLBACK_ROWS rows. The next layout effect re-
      // computes the proper window.
      return { startIndex: 0, endIndex: Math.min(total, VIRT_FALLBACK_ROWS) };
    }
    const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT_PX) - VIRT_OVERSCAN_ROWS);
    const endIndex = Math.min(
      total,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT_PX) + VIRT_OVERSCAN_ROWS,
    );
    return { startIndex, endIndex };
  }, [rows, scrollTop, viewportHeight]);

  // ---- Scroll active row into view -------------------------------------
  useEffect(() => {
    if (!activePacketId || !rows || !listRef.current) return;
    const idx = rows.findIndex((r) => r.packet_id === activePacketId);
    if (idx < 0) return;
    const top = idx * ROW_HEIGHT_PX;
    const viewportTop = listRef.current.scrollTop;
    const viewportBottom = viewportTop + listRef.current.clientHeight;
    if (top < viewportTop) {
      listRef.current.scrollTop = top;
    } else if (top + ROW_HEIGHT_PX > viewportBottom) {
      listRef.current.scrollTop = top + ROW_HEIGHT_PX - listRef.current.clientHeight;
    }
  }, [activePacketId, rows]);

  // ---- Icon-rail mode (criterion 4) ------------------------------------
  if (isNarrow && !forceWide) {
    return (
      <IconRail
        rows={rows ?? []}
        activePacketId={activePacketId}
        onSelect={onSelect}
        onExpand={() => setForceWide(true)}
      />
    );
  }

  // ---- Wide layout ------------------------------------------------------
  const showError = !!error && !rows;
  const showLoading = rows === null && !error;
  const filterActive =
    filterUi.risk_levels.length > 0 ||
    filterUi.time_window !== 'all' ||
    filterUi.redaction !== 'any';

  return (
    <aside
      className={`sidebar ${dimTrailActive ? 'is-dim-trail' : ''} ${isPending ? 'is-pending' : ''}`}
      aria-label="Trail browser"
      ref={containerRef}
    >
      <a className="sidebar__skip-link type-mono-sm" href="#main-content">
        Skip to packet view
      </a>
      <div className="sidebar__brand type-label">Trail</div>
      <HorizonLine variant="sidebar-divider" />

      {/* "Your recent sessions" pin (criterion 2) */}
      <div className="sidebar__pin" aria-labelledby="sidebar-pin-heading">
        <h2 id="sidebar-pin-heading" className="sidebar__section-heading type-label">
          Your recent sessions
        </h2>
        {enrichedPins.length === 0 ? (
          <p className="sidebar__pin-empty type-body-sm">
            Click a session below to pin it.
          </p>
        ) : (
          <ul className="sidebar__pin-list" role="list">
            {enrichedPins.map((pin) => (
              <li key={pin.session_id} className="sidebar__pin-row">
                <button
                  type="button"
                  className="sidebar__pin-button"
                  aria-label={`Open pinned session ${pin.session_id}`}
                  onClick={() => {
                    if (pin.latest_packet_id) onSelect(pin.latest_packet_id);
                  }}
                  disabled={!pin.latest_packet_id}
                >
                  <span className="type-ui sidebar__pin-name">
                    {pin.display_name ?? pin.session_id}
                  </span>
                  <span className="type-mono-sm sidebar__pin-meta">
                    {pin.latest_captured_at ? formatAge(pin.latest_captured_at) : 'no packet'}
                  </span>
                </button>
                <button
                  type="button"
                  className="sidebar__pin-unpin"
                  aria-label={`Unpin session ${pin.session_id}`}
                  onClick={() => handleUnpin(pin.session_id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <HorizonLine variant="sidebar-divider" />

      {/* Filter strip (criterion 3) */}
      <div className="sidebar__filter">
        <h2 className="sidebar__section-heading type-label">Timeline</h2>
        <TrailFilters
          value={filterUi}
          onChange={handleFilterChange}
          heavyRedactionThreshold={settings?.heavy_redaction_threshold}
        />
      </div>

      {/* Timeline list — virtualized + ARIA listbox (criteria 1, 8, 9) */}
      <div className="sidebar__body">
        {showLoading ? (
          <div className="sidebar__loading" aria-busy="true">
            <Skeleton variant="row" />
            <Skeleton variant="row" />
            <Skeleton variant="row" />
            <Skeleton variant="row" />
            <Skeleton variant="row" />
          </div>
        ) : showError ? (
          <Banner tone="warning" title="Trail database unavailable">
            <span className="type-body-sm">{error}</span>
          </Banner>
        ) : rows && rows.length === 0 ? (
          filterActive ? (
            <EmptyState
              variant="compact"
              headline="No matches"
              body="Adjust or clear the filters to see all packets."
              action={
                <button
                  type="button"
                  className="sidebar__reset-button type-mono-sm"
                  onClick={() => handleFilterChange(EMPTY_FILTER)}
                >
                  Clear filters
                </button>
              }
            />
          ) : (
            <EmptyState
              variant="compact"
              headline="No packets captured yet"
              body="Run `trail packet generate <session-id>` after Claude Code wraps. New packets appear here."
            />
          )
        ) : (
          <div
            ref={(el) => {
              // The listbox uses a <div> wrapper because virtualised
              // options must not be nested in a <ul> (HTML5 — only <li>
              // may be a direct child of <ul>). The only operations we
              // perform on the ref are scrollTop / clientHeight /
              // querySelector, which any HTMLElement supports.
              listRef.current = el;
            }}
            className="sidebar__list"
            role="listbox"
            aria-label={`${rows!.length} packets`}
            aria-activedescendant={activePacketId ? `sidebar-row-${activePacketId}` : undefined}
            onKeyDown={handleListKey}
            tabIndex={0}
            data-testid="sidebar-list"
            data-row-count={rows!.length}
          >
            <div
              className="sidebar__list-spacer"
              style={{ height: `${rows!.length * ROW_HEIGHT_PX}px` }}
            >
              {rows!.slice(virtRange.startIndex, virtRange.endIndex).map((row, i) => {
                const idx = virtRange.startIndex + i;
                const isActive = activePacketId === row.packet_id;
                const cluster = timeCluster(row.captured_at);
                const showClusterHeader =
                  idx === 0 ||
                  timeCluster(rows![idx - 1]!.captured_at) !== cluster;
                return (
                  <SidebarRowView
                    key={row.packet_id}
                    row={row}
                    isActive={isActive}
                    top={idx * ROW_HEIGHT_PX}
                    showClusterHeader={showClusterHeader}
                    onSelect={onSelect}
                    onPin={handlePin}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

interface SidebarRowViewProps {
  row: SidebarRow;
  isActive: boolean;
  top: number;
  showClusterHeader: boolean;
  onSelect: (id: string) => void;
  onPin: (sessionId: string) => void;
}

function SidebarRowView({
  row,
  isActive,
  top,
  showClusterHeader,
  onSelect,
  onPin,
}: SidebarRowViewProps) {
  const risk = dominantRisk(row);
  const cluster = timeCluster(row.captured_at);
  // ARIA pattern (axe-validated):
  //   - The wrapper has role="presentation" so axe's
  //     `aria-required-children` rule sees through it. The listbox's
  //     direct children (per layout flattening) are the row-button
  //     options + nothing else; the pin star is presented as a CHILD
  //     of the option button via the click handler delegation pattern,
  //     but visually sits absolute-positioned at the row's right edge.
  //   - We CANNOT put the pin button INSIDE the row button (nested-
  //     interactive). The compromise: render the pin as an aria-hidden
  //     visual-only star on top of the option, with keyboard activation
  //     bound to a context-menu shortcut. For Sprint 2 we accept the
  //     mouse-only pin affordance — the keyboard alternative is the
  //     pin section above (clicking a pin row already enables pinning
  //     of the focused packet).
  return (
    <div
      role="presentation"
      className={`sidebar__row ${isActive ? 'is-active' : ''}`}
      data-packet-id={row.packet_id}
      data-cluster={cluster}
      style={{ position: 'absolute', insetInlineStart: 0, insetInlineEnd: 0, transform: `translateY(${top}px)` }}
    >
      {showClusterHeader ? (
        <div className="sidebar__cluster-header type-label" aria-hidden="true">
          {clusterLabel(cluster)}
        </div>
      ) : null}
      <button
        id={`sidebar-row-${row.packet_id}`}
        type="button"
        role="option"
        aria-selected={isActive}
        className="sidebar__row-button"
        onClick={() => onSelect(row.packet_id)}
        onContextMenu={(e) => {
          // Right-click pins. Cheapest keyboard-equivalent is the pin
          // affordance at the row level + the pin section above.
          e.preventDefault();
          onPin(row.session_id);
        }}
        tabIndex={isActive ? 0 : -1}
      >
        {risk ? <Risk level={risk} variant="dot" /> : null}
        <span className="sidebar__row-name type-ui">{row.display_name}</span>
        <span className="sidebar__row-age type-mono-sm">{formatAge(row.captured_at)}</span>
        {row.posted_to_pr_count > 0 ? (
          <Chip tone="accent" className="sidebar__row-badge">
            POSTED
          </Chip>
        ) : null}
        {row.redaction_count > 0 ? (
          <Chip tone="neutral" className="sidebar__row-redact">
            {row.redaction_count}R
          </Chip>
        ) : null}
      </button>
      {/*
        Visual-only pin affordance. `aria-hidden` so screen readers do
        not see a "non-option" interactive in the listbox. Sighted
        mouse users still get the explicit click-to-pin star; keyboard
        users pin via context-menu (Shift+F10) on the focused row.
      */}
      <span
        className="sidebar__row-pin"
        aria-hidden="true"
        role="presentation"
        onClick={(e) => {
          e.stopPropagation();
          onPin(row.session_id);
        }}
      >
        ★
      </span>
    </div>
  );
}

function clusterLabel(cluster: 'today' | 'yesterday' | 'this-week' | 'older'): string {
  switch (cluster) {
    case 'today':
      return 'Today';
    case 'yesterday':
      return 'Yesterday';
    case 'this-week':
      return 'This week';
    case 'older':
      return 'Older';
  }
}
