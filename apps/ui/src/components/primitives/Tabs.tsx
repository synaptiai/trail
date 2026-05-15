import { useCallback, useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import './Tabs.css';

/**
 * <Tabs> primitive (B3 §15.2 #11, B6 addition).
 *
 * Used by the four-tab packet view (Claims · Diff · Redaction · Trail) and the
 * vertical settings tabs in M6.
 *
 * Full ARIA wiring (B3 §15.2):
 *   role="tablist"   on the tab strip; aria-orientation per orientation
 *   role="tab"       on each tab button; aria-selected, aria-controls
 *   role="tabpanel"  on each panel; aria-labelledby
 *
 * Keyboard:
 *   horizontal — Left/Right move between tabs; Home/End jump
 *   vertical   — Up/Down move between tabs; Home/End jump
 */

export type TabsOrientation = 'horizontal' | 'vertical';

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Optional badge or icon; rendered inline beside the label. */
  trailing?: ReactNode;
  /** Disabled tabs are skipped during keyboard navigation. */
  disabled?: boolean;
}

export interface TabsProps {
  items: readonly TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  orientation?: TabsOrientation;
  /** Compact density tightens vertical padding. */
  density?: 'comfortable' | 'compact';
  /** Reviewer mode emphasis (raises active tab weight). */
  emphasize?: boolean;
  /** Renders the tab panel for `activeId`. */
  panel: ReactNode;
  /** Optional label for the tablist (sr-only by default). */
  label?: string;
}

export function Tabs({
  items,
  activeId,
  onChange,
  orientation = 'horizontal',
  density = 'comfortable',
  emphasize = false,
  panel,
  label = 'Tabs',
}: TabsProps) {
  const baseId = useId();
  const refs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const focusTab = useCallback(
    (id: string) => {
      const btn = refs.current.get(id);
      btn?.focus();
      onChange(id);
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const enabled = items.filter((t) => !t.disabled);
      if (enabled.length === 0) return;
      const currentIndex = enabled.findIndex((t) => t.id === activeId);
      if (currentIndex < 0) return;
      const isHorizontal = orientation === 'horizontal';
      const next = isHorizontal ? 'ArrowRight' : 'ArrowDown';
      const prev = isHorizontal ? 'ArrowLeft' : 'ArrowUp';
      let target = -1;
      if (event.key === next) target = (currentIndex + 1) % enabled.length;
      else if (event.key === prev) target = (currentIndex - 1 + enabled.length) % enabled.length;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = enabled.length - 1;
      if (target < 0) return;
      event.preventDefault();
      const targetItem = enabled[target];
      if (targetItem) focusTab(targetItem.id);
    },
    [activeId, focusTab, items, orientation],
  );

  const tablistClass = [
    'tabs__list',
    `tabs__list--${orientation}`,
    `tabs__list--${density}`,
    emphasize ? 'tabs__list--emphasize' : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`tabs tabs--${orientation}`}>
      <div
        role="tablist"
        aria-orientation={orientation}
        aria-label={label}
        className={tablistClass}
        onKeyDown={handleKeyDown}
      >
        {items.map((item) => {
          const tabId = `${baseId}-tab-${item.id}`;
          const panelId = `${baseId}-panel-${item.id}`;
          const isActive = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={tabId}
              ref={(node) => {
                if (node) refs.current.set(item.id, node);
                else refs.current.delete(item.id);
              }}
              aria-selected={isActive}
              aria-controls={panelId}
              tabIndex={isActive ? 0 : -1}
              disabled={item.disabled}
              className={['tabs__tab', isActive ? 'tabs__tab--active' : null, 'type-ui']
                .filter(Boolean)
                .join(' ')}
              onClick={() => onChange(item.id)}
            >
              <span className="tabs__tab-label">{item.label}</span>
              {item.trailing ? <span className="tabs__tab-trailing">{item.trailing}</span> : null}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-${activeId}`}
        aria-labelledby={`${baseId}-tab-${activeId}`}
        tabIndex={0}
        className="tabs__panel"
      >
        {panel}
      </div>
    </div>
  );
}
