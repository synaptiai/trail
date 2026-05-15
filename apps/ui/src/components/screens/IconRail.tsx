import { useEffect, useRef } from 'react';
import { Risk } from '@/components/primitives';
import type { SidebarRow } from '@/db/queries';
import { dominantRisk } from '@/db/queries';
import './IconRail.css';

/**
 * <IconRail> — narrow-width sidebar variant (B4 §3.3).
 *
 * Activates when window width < 1024px (the `--breakpoint-md` token). The
 * component itself does NOT poll matchMedia — `<TrailSidebar>` owns the
 * resize observer and renders <IconRail> or <TrailSidebar full mode>.
 *
 * Layout: 56px wide; one icon per packet, top-N pinned + most-recent. The
 * selected packet is preserved across mode switches (gh#8 criterion 4) by
 * rendering the same `activePacketId` selection state.
 *
 * Interaction:
 *   - Click an icon → opens the packet (calls onSelect).
 *   - Tooltip on hover → shows packet name + age (browser-native title).
 *   - "+" button at the bottom → calls `onExpand` to switch back to wide.
 */

export interface IconRailProps {
  rows: readonly SidebarRow[];
  activePacketId: string | null;
  onSelect: (packetId: string) => void;
  onExpand: () => void;
  /** Limit the number of icons shown; defaults to 12. */
  maxIcons?: number;
}

export function IconRail({
  rows,
  activePacketId,
  onSelect,
  onExpand,
  maxIcons = 12,
}: IconRailProps) {
  const visible = rows.slice(0, maxIcons);
  const listRef = useRef<HTMLElement | null>(null);

  // Keep the active row scrolled into view across mode switches —
  // criterion 4: "preserves selected packet."
  useEffect(() => {
    if (!activePacketId || !listRef.current) return;
    const sel = listRef.current.querySelector<HTMLElement>(
      `[data-packet-id="${cssEscape(activePacketId)}"]`,
    );
    sel?.scrollIntoView({ block: 'nearest' });
  }, [activePacketId]);

  return (
    <aside className="icon-rail" aria-label="Trail browser (rail)">
      <div className="icon-rail__brand" aria-hidden="true">◯</div>
      {/*
        ARIA pattern: the rail uses a custom button-row pattern rather than
        ARIA's listbox/option (which forbids interactive descendants per
        WAI-ARIA 1.2 + axe rule "nested-interactive"). Each `<button
        role="option">` is the focusable cell — the button IS the option,
        not a child of it. The screen-reader experience is unchanged
        (selected/role/index announced via aria-* on the button).
      */}
      <div
        className="icon-rail__list"
        ref={(el) => {
          listRef.current = el;
        }}
        role="listbox"
        aria-label="Recent packets (icon rail)"
      >
        {visible.map((row) => {
          const isActive = activePacketId === row.packet_id;
          const risk = dominantRisk(row);
          return (
            <button
              key={row.packet_id}
              type="button"
              className={`icon-rail__btn ${isActive ? 'is-active' : ''}`}
              data-packet-id={row.packet_id}
              role="option"
              aria-selected={isActive}
              title={`${row.display_name} — ${row.captured_at}`}
              aria-label={`Open packet ${row.display_name}`}
              onClick={() => onSelect(row.packet_id)}
            >
              {risk ? (
                <Risk level={risk} variant="dot" label="" />
              ) : (
                <span className="icon-rail__placeholder" aria-hidden="true">
                  ◯
                </span>
              )}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="icon-rail__expand"
        aria-label="Expand sidebar"
        onClick={onExpand}
      >
        +
      </button>
    </aside>
  );
}

/**
 * `CSS.escape` polyfill — kept for legacy/non-DOM environments where
 * the `CSS` global is undefined. happy-dom 20+ and every modern
 * browser ship `CSS.escape` natively, so the polyfill branch is
 * effectively never taken in v0.1's test or runtime environments;
 * it remains as a defence-in-depth fallback for headless renderers
 * (older happy-dom forks, jsdom < 21) and for any code path that
 * runs outside a DOM context.
 *
 * Cycle-4.5 W16 (PR #21): docblock-precision update. The previous
 * version said "the test env does not [ship CSS]" — that was true
 * pre-cycle-3 (happy-dom 14) but has been false since the cycle-3
 * happy-dom 20 bump.
 */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}
