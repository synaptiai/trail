import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import {
  KeyboardOverlay,
  __testing,
} from '@/components/screens/KeyboardOverlay';
import { classifyShortcut } from '@/services/decision-shortcuts';

/**
 * Sprint 6 (gh#13 AC-1): full keyboard overlay.
 *
 * AC: shows ALL wired shortcuts grouped by context, searchable, scrollable;
 * axe-clean; in sync with the dispatcher's KEY_TO_DECISION + classifyShortcut
 * map.
 */
describe('<KeyboardOverlay> — Sprint 6 full overlay', () => {
  it('renders all five shortcut groups when open', () => {
    render(<KeyboardOverlay open onClose={() => {}} />);
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(screen.getByText('Packet view (claims)')).toBeInTheDocument();
    expect(screen.getByText('Sidebar (trail timeline)')).toBeInTheDocument();
    expect(
      screen.getByText('Tabs (claims / diff / redaction / trail)'),
    ).toBeInTheDocument();
    expect(screen.getByText('Modal')).toBeInTheDocument();
  });

  it('does not render when open=false', () => {
    render(<KeyboardOverlay open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('catalog mirrors the dispatcher: every dispatcher key has a row', () => {
    // Sample every single-letter key the dispatcher accepts and assert
    // it appears in the catalog. classifyShortcut is the single source
    // of truth for what's wired; the overlay must render the same set.
    const keysFromDispatcher = ['a', 'c', 'b', 'r', 'j', 'k', 'n', 'p', 'g'];
    for (const k of keysFromDispatcher) {
      const action = classifyShortcut(
        new KeyboardEvent('keydown', { key: k }),
      );
      expect(action, `dispatcher should classify '${k}'`).not.toBeNull();
    }
    // Every dispatcher-classified key must have a row in the catalog
    // (case-insensitive — `Shift+A` covers shift-a).
    const allRowsLower = __testing.SHORTCUT_GROUPS.flatMap((g) =>
      g.shortcuts.map((s) => s.key.toLowerCase()),
    );
    for (const k of keysFromDispatcher) {
      const found = allRowsLower.some((rk) => rk === k || rk.endsWith(`+${k}`));
      expect(found, `catalog must list dispatcher key '${k}'`).toBe(true);
    }
    // The shift-bulk-accept binding has its own row.
    expect(allRowsLower).toContain('shift+a');
    // The global `?` and `Esc` rows.
    expect(allRowsLower).toContain('?');
    expect(allRowsLower).toContain('esc');
  });

  // Cycle-2 C13 (PR #21): reverse-direction drift test. The forward
  // assertion above (catalog must list every dispatcher key) catches
  // the case where the dispatcher gains a binding but the catalog
  // forgets to surface it. The reverse case — the catalog lists a
  // single-letter shortcut that the dispatcher does NOT actually wire —
  // would have been an undetected slip-through. This test closes the
  // loop: for every catalog row whose `key` is a single dispatcher-
  // shaped letter (no modifier, not punctuation/named keys), assert
  // classifyShortcut returns a non-null action. The narrowing avoids
  // false positives on non-dispatcher keys (?, Esc, Tab, arrows,
  // Home/End/Shift+A).
  it('reverse drift: every single-letter catalog key dispatches (C13)', () => {
    // Keys the dispatcher classifies via the special-key branch (NOT
    // the `KEY_TO_DECISION` table) but which still warrant a catalog
    // row even though classifyShortcut treats them as separate. The
    // dispatcher's contract:
    //   single-letter keys without modifier → KEY_TO_DECISION (a/c/b/r)
    //                                       OR navigation (j/k/n/p/g)
    //   `?` (global)                         → open-overlay
    //   `Shift+A`                            → bulk-accept
    //   Esc / Tab / arrows / Home / End      → handled by the focused
    //                                          consumer (Modal primitive,
    //                                          TrailSidebar, Tabs), not
    //                                          classifyShortcut. These
    //                                          are CORRECTLY in the
    //                                          catalog without a
    //                                          dispatcher entry.
    const NAMED_KEYS = new Set([
      '?',
      'esc',
      'tab',
      'shift+tab',
      'arrowdown',
      'arrowup',
      'arrowleft',
      'arrowright',
      'home',
      'end',
      'shift+p',
      'shift+a',
    ]);
    const allRows = __testing.SHORTCUT_GROUPS.flatMap((g) =>
      g.shortcuts.map((s) => s.key),
    );
    for (const rawKey of allRows) {
      const lower = rawKey.toLowerCase();
      if (NAMED_KEYS.has(lower)) continue;
      // Single character keys remaining must dispatch.
      if (lower.length !== 1) {
        // Multi-char that isn't in NAMED_KEYS is an unknown shape —
        // either add it to NAMED_KEYS (with rationale) or to
        // KEY_TO_DECISION. Surface the gap loudly.
        throw new Error(
          `catalog row '${rawKey}' is multi-char but not in NAMED_KEYS — add to whitelist or wire dispatcher`,
        );
      }
      const action = classifyShortcut(
        new KeyboardEvent('keydown', { key: lower }),
      );
      expect(
        action,
        `catalog lists '${rawKey}' but dispatcher does not classify it — drift`,
      ).not.toBeNull();
    }
  });

  it('search filters case-insensitively across keys and descriptions', async () => {
    const user = userEvent.setup();
    render(<KeyboardOverlay open onClose={() => {}} />);
    const search = screen.getByLabelText(/search shortcuts/i);
    // Filter to "accept" — should keep Accept and Bulk-accept rows; should
    // drop Block, Move, Tabs, etc.
    await user.type(search, 'accept');
    expect(screen.getByText(/Accept the focused claim/)).toBeInTheDocument();
    expect(
      screen.getByText(/Bulk-accept every visible undecided claim/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Block the focused claim')).toBeNull();
    expect(screen.queryByText(/Move focus to the next tab/)).toBeNull();
  });

  it('shows an empty-state message when nothing matches the search', async () => {
    const user = userEvent.setup();
    render(<KeyboardOverlay open onClose={() => {}} />);
    const search = screen.getByLabelText(/search shortcuts/i);
    await user.type(search, 'zzzzz-no-match');
    expect(screen.getByRole('status')).toHaveTextContent(/No shortcuts match/);
    // None of the group headers render once everything filters out.
    expect(screen.queryByText('Global')).toBeNull();
  });

  it('Escape closes the overlay (Modal primitive integration)', async () => {
    const onClose = vi.fn();
    render(<KeyboardOverlay open onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('search input has an explicit accessible label', () => {
    render(<KeyboardOverlay open onClose={() => {}} />);
    const search = screen.getByLabelText(/search shortcuts/i);
    expect(search).toHaveAttribute('type', 'search');
  });

  it('axe-clean (B6 P1: AA non-text contrast, focus-trap, ARIA dialog)', async () => {
    const { container } = render(
      <KeyboardOverlay open onClose={() => {}} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
