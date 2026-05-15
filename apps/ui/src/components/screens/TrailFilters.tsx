import { useMemo, useRef, useState } from 'react';
import { Chip } from '@/components/primitives';
import type { RiskLevel, TrailFilter } from '@/ipc/contract';
import './TrailFilters.css';

/**
 * <TrailFilters> — three-axis filter strip (B4 §3.5).
 *
 * Axes:
 *   - **Risk**: multi-select chip popover (low / med / high / crit).
 *   - **Time**: today / week / month / quarter / all (single-select).
 *   - **Redaction**: any / none / some / heavy (single-select).
 *
 * State plane:
 *   - The component is fully controlled — `value` + `onChange`.
 *   - Each chip toggles its facet without dismissing the popover; chips
 *     close on Escape or by clicking the chip again.
 *
 * Motion (B3 §8.3):
 *   - Filter apply triggers the **dim-trail motion** in <TrailSidebar>:
 *     non-matching rows fade to opacity 0.30. This component does NOT own
 *     the motion; it merely fires `onChange` and the parent applies the
 *     dim-trail transition class.
 *   - Reduced-motion is honoured globally via tokens.css `@media`.
 *
 * Accessibility:
 *   - Each chip is a `<button aria-pressed>` so screen readers announce
 *     the toggle state.
 *   - The popovers are `role="dialog" aria-modal="false"` (non-modal:
 *     pressing Escape closes them but does not trap focus).
 */

const TIME_OPTIONS: { id: TimeWindow; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'quarter', label: 'This quarter' },
];

const REDACTION_OPTIONS: { id: RedactionDensity; label: string }[] = [
  { id: 'any', label: 'Any density' },
  { id: 'none', label: 'No redactions' },
  { id: 'some', label: 'Some redactions' },
  { id: 'heavy', label: 'Heavy redactions' },
];

const RISK_OPTIONS: RiskLevel[] = ['low', 'med', 'high', 'crit'];

export type TimeWindow = 'all' | 'today' | 'week' | 'month' | 'quarter';
export type RedactionDensity = 'any' | 'none' | 'some' | 'heavy';

export interface TrailFiltersValue {
  risk_levels: RiskLevel[];
  time_window: TimeWindow;
  redaction: RedactionDensity;
}

export const EMPTY_FILTER: TrailFiltersValue = {
  risk_levels: [],
  time_window: 'all',
  redaction: 'any',
};

export interface TrailFiltersProps {
  value: TrailFiltersValue;
  onChange: (next: TrailFiltersValue) => void;
  /** Heavy-redaction threshold from settings (B3 OQ-B3-6 default 15). */
  heavyRedactionThreshold?: number | undefined;
}

export function TrailFilters({ value, onChange }: TrailFiltersProps) {
  const [openFacet, setOpenFacet] = useState<'risk' | 'time' | 'redaction' | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const riskLabel = useMemo(() => {
    if (value.risk_levels.length === 0) return 'risk';
    return `risk: ${value.risk_levels.map((l) => l.toUpperCase()).join(', ')}`;
  }, [value.risk_levels]);

  const timeLabel = useMemo(() => {
    const opt = TIME_OPTIONS.find((t) => t.id === value.time_window);
    return value.time_window === 'all' ? 'time' : `time: ${opt?.label ?? value.time_window}`;
  }, [value.time_window]);

  const redactionLabel = useMemo(() => {
    const opt = REDACTION_OPTIONS.find((r) => r.id === value.redaction);
    return value.redaction === 'any' ? 'redaction' : `redaction: ${opt?.label ?? value.redaction}`;
  }, [value.redaction]);

  function toggleRiskLevel(level: RiskLevel) {
    const next = value.risk_levels.includes(level)
      ? value.risk_levels.filter((l) => l !== level)
      : [...value.risk_levels, level];
    onChange({ ...value, risk_levels: next });
  }

  function pickTimeWindow(t: TimeWindow) {
    onChange({ ...value, time_window: t });
    setOpenFacet(null);
  }

  function pickRedaction(r: RedactionDensity) {
    onChange({ ...value, redaction: r });
    setOpenFacet(null);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && openFacet) {
      setOpenFacet(null);
      event.stopPropagation();
    }
  }

  function clearAll() {
    onChange(EMPTY_FILTER);
  }

  const hasActive =
    value.risk_levels.length > 0 || value.time_window !== 'all' || value.redaction !== 'any';

  return (
    <div
      className="trail-filters"
      ref={containerRef}
      onKeyDown={handleKeyDown}
      role="toolbar"
      aria-label="Filter trail by risk, time, and redaction"
    >
      <div className="trail-filters__row">
        {/*
          F-A11Y-1: each chip button declares aria-haspopup + aria-expanded
          + aria-pressed. The inner <Chip> primitive renders the visible
          label as a <span>; without `aria-hidden` the SR would announce
          BOTH the button's computed name (from the Chip text) AND the
          chip-tone'd span — verbose. Use `aria-label` to set the button
          name to just the human-readable summary; mark the inner Chip
          aria-hidden so the SR does not double-read it.
        */}
        <button
          type="button"
          className={`trail-filters__chip ${value.risk_levels.length > 0 ? 'is-active' : ''}`}
          aria-pressed={value.risk_levels.length > 0}
          aria-expanded={openFacet === 'risk'}
          aria-haspopup="listbox"
          aria-label={riskLabel}
          onClick={() => setOpenFacet(openFacet === 'risk' ? null : 'risk')}
        >
          <Chip tone={value.risk_levels.length > 0 ? 'accent' : 'neutral'} aria-hidden>
            {riskLabel}
          </Chip>
        </button>
        <button
          type="button"
          className={`trail-filters__chip ${value.time_window !== 'all' ? 'is-active' : ''}`}
          aria-pressed={value.time_window !== 'all'}
          aria-expanded={openFacet === 'time'}
          aria-haspopup="listbox"
          aria-label={timeLabel}
          onClick={() => setOpenFacet(openFacet === 'time' ? null : 'time')}
        >
          <Chip tone={value.time_window !== 'all' ? 'accent' : 'neutral'} aria-hidden>
            {timeLabel}
          </Chip>
        </button>
        <button
          type="button"
          className={`trail-filters__chip ${value.redaction !== 'any' ? 'is-active' : ''}`}
          aria-pressed={value.redaction !== 'any'}
          aria-expanded={openFacet === 'redaction'}
          aria-haspopup="listbox"
          aria-label={redactionLabel}
          onClick={() => setOpenFacet(openFacet === 'redaction' ? null : 'redaction')}
        >
          <Chip tone={value.redaction !== 'any' ? 'accent' : 'neutral'} aria-hidden>
            {redactionLabel}
          </Chip>
        </button>
        {hasActive ? (
          <button
            type="button"
            className="trail-filters__clear type-mono-sm"
            onClick={clearAll}
            aria-label="Clear all filters"
          >
            clear
          </button>
        ) : null}
      </div>

      {/*
        ARIA pattern: each popover is a listbox directly (NOT wrapped in
        a dialog). The chip button declares aria-haspopup="listbox", so
        the popup's role MUST match. The previous wrapper used
        role="dialog" which violated this contract; axe-core's
        aria-haspopup-popup-role rule would have flagged it. The
        listbox itself is the popover here — no dialog chrome required
        for a quick-pick filter.
      */}
      {openFacet === 'risk' ? (
        <ul
          className="trail-filters__popover"
          role="listbox"
          aria-multiselectable="true"
          aria-label="Risk levels"
        >
          {RISK_OPTIONS.map((level) => {
            const selected = value.risk_levels.includes(level);
            return (
              <li
                key={level}
                role="option"
                aria-selected={selected}
                className={`trail-filters__option type-ui ${selected ? 'is-selected' : ''}`}
                onClick={() => toggleRiskLevel(level)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleRiskLevel(level);
                  }
                }}
                tabIndex={0}
              >
                <span className="trail-filters__option-mark" aria-hidden="true">
                  {selected ? '✓' : ''}
                </span>
                <span>{level.toUpperCase()}</span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {openFacet === 'time' ? (
        <ul
          className="trail-filters__popover"
          role="listbox"
          aria-label="Time windows"
        >
          {TIME_OPTIONS.map((opt) => {
            const selected = opt.id === value.time_window;
            return (
              <li
                key={opt.id}
                role="option"
                aria-selected={selected}
                className={`trail-filters__option type-ui ${selected ? 'is-selected' : ''}`}
                onClick={() => pickTimeWindow(opt.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    pickTimeWindow(opt.id);
                  }
                }}
                tabIndex={0}
              >
                <span className="trail-filters__option-mark" aria-hidden="true">
                  {selected ? '●' : '○'}
                </span>
                <span>{opt.label}</span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {openFacet === 'redaction' ? (
        <ul
          className="trail-filters__popover"
          role="listbox"
          aria-label="Redaction density"
        >
          {REDACTION_OPTIONS.map((opt) => {
            const selected = opt.id === value.redaction;
            return (
              <li
                key={opt.id}
                role="option"
                aria-selected={selected}
                className={`trail-filters__option type-ui ${selected ? 'is-selected' : ''}`}
                onClick={() => pickRedaction(opt.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    pickRedaction(opt.id);
                  }
                }}
                tabIndex={0}
              >
                <span className="trail-filters__option-mark" aria-hidden="true">
                  {selected ? '●' : '○'}
                </span>
                <span>{opt.label}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pure helpers — translate UI filter state to the IPC TrailFilter shape.
// ---------------------------------------------------------------------------

/**
 * Convert a `TrailFiltersValue` to the IPC-typed `TrailFilter`.
 *
 * Time-window translation happens here so the component itself doesn't
 * carry a clock dep. `now` is injected (defaulting to `new Date()`) so
 * tests can pin time deterministically.
 *
 * Redaction-density translation:
 *   - `any`   → no constraint
 *   - `none`  → has_redactions=false
 *   - `some`  → has_redactions=true (≥1 redaction)
 *   - `heavy` → has_redactions=true (sidebar applies a count threshold
 *               post-fetch via `heavyRedactionThreshold`)
 */
export function toIpcFilter(
  ui: TrailFiltersValue,
  now: Date = new Date(),
): TrailFilter {
  const filter: TrailFilter = {};
  if (ui.risk_levels.length > 0) filter.risk_levels = [...ui.risk_levels];
  const window = computeTimeWindow(ui.time_window, now);
  if (window) filter.captured_after = window.toISOString();
  // F-CODE-4: the `today` window means "captured between local-midnight
  // today AND end-of-today". The original code only emitted
  // captured_after, so a future-dated packet (clock drift, future
  // "scheduled session" feature) would silently match. Pin the upper
  // bound to local-midnight tomorrow so "today" is a closed interval.
  if (ui.time_window === 'today') {
    const tomorrow = new Date(now);
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    filter.captured_before = tomorrow.toISOString();
  }
  if (ui.redaction === 'some' || ui.redaction === 'heavy') {
    filter.has_redactions = true;
  } else if (ui.redaction === 'none') {
    filter.has_redactions = false;
  }
  return filter;
}

export function computeTimeWindow(window: TimeWindow, now: Date): Date | null {
  if (window === 'all') return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  switch (window) {
    case 'today':
      return start;
    case 'week':
      start.setDate(start.getDate() - 7);
      return start;
    case 'month':
      start.setDate(start.getDate() - 30);
      return start;
    case 'quarter':
      start.setDate(start.getDate() - 90);
      return start;
  }
}
