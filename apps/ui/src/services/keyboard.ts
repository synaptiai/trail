/**
 * Keyboard helpers — shared text-entry detection.
 *
 * Sprint 4: extracted from TopBar so the decision-shortcuts service and the
 * keyboard-overlay shell share one implementation. The N30 fix (composed-
 * path walk for shadow-DOM crossings) lives here exactly once.
 */

export function isTextEntryNode(el: HTMLElement): boolean {
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // happy-dom's isContentEditable reflects the DOM property; we also accept
  // the raw attribute in case the property has not synced (test envs).
  if (el.isContentEditable) return true;
  const ce = el.getAttribute('contenteditable');
  if (ce === 'true' || ce === '') return true;
  // ARIA roles for text-entry surfaces (react-aria-components, some
  // rich-text editors that don't use contenteditable directly).
  const role = el.getAttribute('role');
  if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
  return false;
}

export function isTextEntryTarget(event: KeyboardEvent): boolean {
  const target = event.target;
  if (target instanceof HTMLElement) {
    if (isTextEntryNode(target)) return true;
  }
  // composedPath is the spec mechanism for events crossing shadow-DOM
  // boundaries (custom elements, third-party widgets). Cross-browser
  // compatible since 2018; gated by typeof check for ancient envs.
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const node of path) {
    if (node instanceof HTMLElement && isTextEntryNode(node)) return true;
  }
  return false;
}

/**
 * True when the keyboard event has any modifier set (Ctrl/Cmd/Alt/Meta).
 * Used by the decision shortcuts to keep `a`/`c`/`b`/`r` from intercepting
 * Ctrl+A (select-all), Cmd+R (reload), etc.
 */
export function hasModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey;
}
