import { useId, useMemo, useState } from 'react';
import { Modal, KeyboardKey } from '@/components/primitives';
import './KeyboardOverlay.css';

/**
 * <KeyboardOverlay> — Sprint 6 (gh#13 AC-1).
 *
 * Triggered by the global `?` shortcut. Sprint 4 shipped a minimal table
 * shell; Sprint 6 promotes it to the full styled overlay (B4 §6.x):
 *
 *   - All wired shortcuts grouped by context (Global / Packet view /
 *     Sidebar / Tabs / Modal).
 *   - Searchable: typing in the search box filters by key OR description
 *     (case-insensitive, all groups; empty groups hide).
 *   - Scrollable: overlay caps at the modal-md height and the body
 *     scrolls when the shortcut list overflows.
 *
 * Source of truth: `apps/ui/src/services/decision-shortcuts.ts` for the
 * dispatcher; the Modal primitive for ESC + Tab focus-trap; per-screen
 * components for context-scoped bindings (Sidebar j/k/Home/End/Shift+P
 * lives in TrailSidebar; Tabs Left/Right/Home/End is in primitives/Tabs).
 *
 * AC-1 spec: shows ALL wired shortcuts; searchable; scrollable.
 * AC-2 spec: axe-clean (the inner table is rendered inside the modal,
 * which already has role=dialog + focus-trap; the search input has an
 * explicit label).
 */
export interface KeyboardOverlayProps {
  open: boolean;
  onClose: () => void;
}

interface Shortcut {
  key: string;
  description: string;
}

interface ShortcutGroup {
  id: string;
  label: string;
  shortcuts: Shortcut[];
}

/**
 * Authoritative shortcut catalog. Each entry mirrors a real binding in
 * src/. When a new shortcut lands in the dispatcher, add it here so the
 * overlay stays in sync (the unit test pins this list against the
 * dispatch table).
 */
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: 'global',
    label: 'Global',
    shortcuts: [
      { key: '?', description: 'Open this keyboard overlay' },
      { key: 'Esc', description: 'Close modal / overlay' },
      { key: 'g', description: 'Open the Post-to-PR modal (creator + reviewer)' },
    ],
  },
  {
    id: 'packet-view',
    label: 'Packet view (claims)',
    shortcuts: [
      { key: 'a', description: 'Accept the focused claim' },
      { key: 'c', description: 'Request changes on the focused claim' },
      { key: 'b', description: 'Block the focused claim' },
      { key: 'r', description: 'Request evidence (reject) on the focused claim' },
      { key: 'j', description: 'Move focus to the next claim' },
      { key: 'k', description: 'Move focus to the previous claim' },
      { key: 'n', description: 'Jump to the next undecided claim' },
      { key: 'p', description: 'Jump to the previous undecided claim' },
      { key: 'Shift+A', description: 'Bulk-accept every visible undecided claim' },
    ],
  },
  {
    id: 'sidebar',
    label: 'Sidebar (trail timeline)',
    shortcuts: [
      { key: 'ArrowDown', description: 'Move focus to the next packet' },
      { key: 'ArrowUp', description: 'Move focus to the previous packet' },
      { key: 'Home', description: 'Jump to the first packet' },
      { key: 'End', description: 'Jump to the last packet' },
      { key: 'Shift+P', description: 'Pin / unpin the focused session' },
    ],
  },
  {
    id: 'tabs',
    label: 'Tabs (claims / diff / redaction / trail)',
    shortcuts: [
      { key: 'ArrowLeft', description: 'Move focus to the previous tab' },
      { key: 'ArrowRight', description: 'Move focus to the next tab' },
      { key: 'Home', description: 'Jump to the first tab' },
      { key: 'End', description: 'Jump to the last tab' },
    ],
  },
  {
    id: 'modal',
    label: 'Modal',
    shortcuts: [
      { key: 'Tab', description: 'Move focus to the next focusable inside the modal' },
      { key: 'Shift+Tab', description: 'Move focus to the previous focusable' },
      { key: 'Esc', description: 'Close the modal (when dismissible)' },
    ],
  },
];

function matchesQuery(s: Shortcut, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    s.key.toLowerCase().includes(needle) ||
    s.description.toLowerCase().includes(needle)
  );
}

export function KeyboardOverlay({ open, onClose }: KeyboardOverlayProps) {
  const [query, setQuery] = useState('');
  const searchId = useId();

  const filtered = useMemo(() => {
    return SHORTCUT_GROUPS.map((g) => ({
      ...g,
      shortcuts: g.shortcuts.filter((s) => matchesQuery(s, query)),
    })).filter((g) => g.shortcuts.length > 0);
  }, [query]);

  const totalAfterFilter = filtered.reduce(
    (sum, g) => sum + g.shortcuts.length,
    0,
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      subtitle="Every wired shortcut, grouped by context (B4 §6)."
      size="md"
    >
      <div className="kbo">
        <label htmlFor={searchId} className="kbo__search-label type-ui">
          Search shortcuts
        </label>
        <input
          id={searchId}
          type="search"
          className="kbo__search"
          placeholder="Type a key or action…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <div
          className="kbo__scroll"
          role="region"
          aria-label="Keyboard shortcuts list"
        >
          {totalAfterFilter === 0 ? (
            <p className="kbo__empty type-body-sm" role="status">
              No shortcuts match &ldquo;{query}&rdquo;.
            </p>
          ) : (
            filtered.map((group) => (
              <section key={group.id} className="kbo__group">
                <h3 className="kbo__group-label type-ui">{group.label}</h3>
                <table className="kbo__table">
                  <thead className="sr-only">
                    <tr>
                      <th scope="col">Key</th>
                      <th scope="col">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.shortcuts.map((s) => (
                      <tr key={`${group.id}-${s.key}`}>
                        <td className="kbo__key-cell">
                          <KeyboardKey>{s.key}</KeyboardKey>
                        </td>
                        <td className="type-body-sm">{s.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))
          )}
        </div>
        <p className="kbo__note type-body-sm">
          Single-letter shortcuts are suppressed inside text-entry fields.
        </p>
      </div>
    </Modal>
  );
}

/**
 * Test-only export: the catalog the overlay renders. The decision-
 * shortcuts unit test pins this against the dispatch table to prevent
 * drift.
 */
export const __testing = { SHORTCUT_GROUPS };
