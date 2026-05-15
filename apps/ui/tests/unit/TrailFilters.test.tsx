import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import {
  TrailFilters,
  toIpcFilter,
  computeTimeWindow,
  EMPTY_FILTER,
  type TrailFiltersValue,
} from '@/components/screens/TrailFilters';

describe('<TrailFilters>', () => {
  it('renders three facet chips', () => {
    const onChange = vi.fn();
    render(<TrailFilters value={EMPTY_FILTER} onChange={onChange} />);
    // The chips are buttons with aria-pressed.
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/^risk$/i)).toBeInTheDocument();
    expect(screen.getByText(/^time$/i)).toBeInTheDocument();
    expect(screen.getByText(/^redaction$/i)).toBeInTheDocument();
  });

  it('opens the risk popover and toggles a level', () => {
    const onChange = vi.fn();
    render(<TrailFilters value={EMPTY_FILTER} onChange={onChange} />);
    const riskBtn = screen.getByRole('button', { name: /^risk$/i });
    fireEvent.click(riskBtn);
    // Popover surfaces a listbox with HIGH option.
    const high = screen.getByRole('option', { name: /HIGH/ });
    fireEvent.click(high);
    expect(onChange).toHaveBeenCalledWith({
      ...EMPTY_FILTER,
      risk_levels: ['high'],
    });
  });

  it('toggles risk level OFF when clicked twice', () => {
    const onChange = vi.fn();
    const initial: TrailFiltersValue = { ...EMPTY_FILTER, risk_levels: ['high'] };
    render(<TrailFilters value={initial} onChange={onChange} />);
    const riskBtn = screen.getByRole('button', { name: /risk:/i });
    fireEvent.click(riskBtn);
    const high = screen.getByRole('option', { name: /HIGH/ });
    fireEvent.click(high);
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTER, risk_levels: [] });
  });

  it('selects a time window', () => {
    const onChange = vi.fn();
    render(<TrailFilters value={EMPTY_FILTER} onChange={onChange} />);
    const timeBtn = screen.getByRole('button', { name: /^time$/i });
    fireEvent.click(timeBtn);
    const today = screen.getByRole('option', { name: /Today/ });
    fireEvent.click(today);
    expect(onChange).toHaveBeenCalledWith({
      ...EMPTY_FILTER,
      time_window: 'today',
    });
  });

  it('selects a redaction density', () => {
    const onChange = vi.fn();
    render(<TrailFilters value={EMPTY_FILTER} onChange={onChange} />);
    const redactBtn = screen.getByRole('button', { name: /^redaction$/i });
    fireEvent.click(redactBtn);
    const heavy = screen.getByRole('option', { name: /Heavy redactions/ });
    fireEvent.click(heavy);
    expect(onChange).toHaveBeenCalledWith({
      ...EMPTY_FILTER,
      redaction: 'heavy',
    });
  });

  it('shows the clear button when a filter is active', () => {
    const onChange = vi.fn();
    render(
      <TrailFilters
        value={{ risk_levels: ['high'], time_window: 'all', redaction: 'any' }}
        onChange={onChange}
      />,
    );
    const clearBtn = screen.getByRole('button', { name: /clear all filters/i });
    fireEvent.click(clearBtn);
    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTER);
  });

  it('Escape closes an open popover', () => {
    const onChange = vi.fn();
    render(<TrailFilters value={EMPTY_FILTER} onChange={onChange} />);
    const riskBtn = screen.getByRole('button', { name: /^risk$/i });
    fireEvent.click(riskBtn);
    expect(screen.getByRole('listbox', { name: /Risk levels/ })).toBeInTheDocument();
    // Find the toolbar (parent of all chips) and dispatch Escape.
    const toolbar = screen.getByRole('toolbar');
    fireEvent.keyDown(toolbar, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: /Risk levels/ })).not.toBeInTheDocument();
  });

  it('passes axe-core a11y scan', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <TrailFilters value={EMPTY_FILTER} onChange={onChange} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe('toIpcFilter (UI → IPC translation)', () => {
  const now = new Date('2026-05-09T12:00:00Z');

  it('returns an empty object for the default filter', () => {
    const ipc = toIpcFilter(EMPTY_FILTER, now);
    expect(ipc).toEqual({});
  });

  it('translates risk_levels through', () => {
    const ipc = toIpcFilter(
      { ...EMPTY_FILTER, risk_levels: ['high', 'crit'] },
      now,
    );
    expect(ipc.risk_levels).toEqual(['high', 'crit']);
  });

  it('translates today / week / month / quarter to a captured_after ISO', () => {
    expect(toIpcFilter({ ...EMPTY_FILTER, time_window: 'today' }, now).captured_after).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
    expect(
      toIpcFilter({ ...EMPTY_FILTER, time_window: 'week' }, now).captured_after,
    ).toBeDefined();
    expect(
      toIpcFilter({ ...EMPTY_FILTER, time_window: 'all' }, now).captured_after,
    ).toBeUndefined();
  });

  // F-CODE-4: `today` must be a CLOSED interval — captured_before pinned
  // to local-midnight tomorrow so future-dated packets (clock drift, a
  // future "scheduled session" feature) cannot leak past the upper bound.
  // Other windows intentionally have an open upper bound (week/month/
  // quarter mean "the last N days up to now").
  it('today emits captured_before = local-midnight tomorrow (closed interval)', () => {
    const ipc = toIpcFilter({ ...EMPTY_FILTER, time_window: 'today' }, now);
    expect(ipc.captured_before).toBeDefined();
    expect(ipc.captured_before).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Sanity: captured_before > captured_after, exactly 24h apart.
    const before = new Date(ipc.captured_before!);
    const after = new Date(ipc.captured_after!);
    expect(before.getTime() - after.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('week / month / quarter / all do NOT emit captured_before', () => {
    expect(
      toIpcFilter({ ...EMPTY_FILTER, time_window: 'week' }, now).captured_before,
    ).toBeUndefined();
    expect(
      toIpcFilter({ ...EMPTY_FILTER, time_window: 'month' }, now).captured_before,
    ).toBeUndefined();
    expect(
      toIpcFilter({ ...EMPTY_FILTER, time_window: 'quarter' }, now).captured_before,
    ).toBeUndefined();
    expect(
      toIpcFilter({ ...EMPTY_FILTER, time_window: 'all' }, now).captured_before,
    ).toBeUndefined();
  });

  it('redaction: some/heavy → has_redactions=true; none → false; any → omitted', () => {
    expect(toIpcFilter({ ...EMPTY_FILTER, redaction: 'some' }, now).has_redactions).toBe(true);
    expect(toIpcFilter({ ...EMPTY_FILTER, redaction: 'heavy' }, now).has_redactions).toBe(true);
    expect(toIpcFilter({ ...EMPTY_FILTER, redaction: 'none' }, now).has_redactions).toBe(false);
    expect(toIpcFilter({ ...EMPTY_FILTER, redaction: 'any' }, now).has_redactions).toBeUndefined();
  });
});

describe('computeTimeWindow', () => {
  const now = new Date('2026-05-09T12:00:00Z');

  it('today returns local-midnight', () => {
    const r = computeTimeWindow('today', now);
    expect(r).not.toBeNull();
    expect(r?.getHours()).toBe(0);
  });

  it('week is 7 days back', () => {
    const r = computeTimeWindow('week', now);
    const diff = (now.getTime() - (r?.getTime() ?? 0)) / (1000 * 60 * 60 * 24);
    expect(diff).toBeGreaterThanOrEqual(7);
    expect(diff).toBeLessThanOrEqual(8);
  });

  it('all returns null', () => {
    expect(computeTimeWindow('all', now)).toBeNull();
  });
});
