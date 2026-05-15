/**
 * Decision-shortcut dispatcher (gh#11 criterion 9).
 *
 * Bindings (B4 §6 + §7.1 — shortcuts contract):
 *
 *   a       accept           the focused claim
 *   c       changes          the focused claim
 *   b       block            the focused claim
 *   r       request-evidence (UI-side; persisted as "reject" decision per
 *                             the schema's $defs/decision_kind enum)
 *   j       move focus down  one claim
 *   k       move focus up    one claim
 *   n       jump to next     undecided claim
 *   p       jump to prev     undecided claim
 *   Shift+A bulk-accept      all visible undecided claims
 *   ?       open keyboard    overlay shell
 *
 * Modifier-bearing combinations (Ctrl+A, Cmd+R, Alt+J) are PASSED THROUGH so
 * the browser's native shortcuts continue to work.
 *
 * Sprint 4 ships the dispatcher + the contract; consumer components call
 * `useDecisionShortcuts` with their callbacks. The hook adds one
 * document-level keydown listener; on unmount, removes it.
 *
 * IMPORTANT: text-entry targets short-circuit ALL shortcuts (per B6 P1 +
 * the Sprint 1 N30 fix). A reviewer typing a reason in M3 must NOT have
 * `r` re-trigger a request-evidence decision.
 */
import { useEffect } from 'react';
import { hasModifier, isTextEntryTarget } from './keyboard';

export type DecisionKey = 'accept' | 'changes' | 'block' | 'request-evidence';

export interface DecisionShortcutCallbacks {
  /** Apply `decision` to the currently focused claim. Optional (no-op if absent). */
  onDecide?: (decision: DecisionKey) => void;
  /** Move focus to the next claim row in document order. */
  onMoveDown?: () => void;
  /** Move focus to the previous claim row. */
  onMoveUp?: () => void;
  /** Jump focus to the next claim with no decision recorded yet. */
  onJumpNextUndecided?: () => void;
  /** Jump focus to the previous undecided claim. */
  onJumpPrevUndecided?: () => void;
  /** Bulk-accept every visible undecided claim. */
  onBulkAccept?: () => void;
  /** Open the keyboard-overlay shell. */
  onOpenOverlay?: () => void;
  /**
   * Open the M4 post-to-PR modal (Sprint 5; B4 §9 `g` global shortcut).
   * Creator + reviewer can post; auditor cannot. The PacketView gates
   * on persona before installing the callback.
   */
  onOpenPost?: () => void;
}

const KEY_TO_DECISION: Record<string, DecisionKey> = {
  a: 'accept',
  c: 'changes',
  b: 'block',
  r: 'request-evidence',
};

/**
 * Determine the action for a keydown event WITHOUT firing it. Pure
 * function so unit tests can pin the dispatch table without a DOM
 * listener. Returns null when the event is uninteresting.
 */
export type ShortcutAction =
  | { kind: 'decide'; decision: DecisionKey }
  | { kind: 'move-down' }
  | { kind: 'move-up' }
  | { kind: 'jump-next-undecided' }
  | { kind: 'jump-prev-undecided' }
  | { kind: 'bulk-accept' }
  | { kind: 'open-overlay' }
  | { kind: 'open-post' };

export function classifyShortcut(event: KeyboardEvent): ShortcutAction | null {
  if (isTextEntryTarget(event)) return null;
  if (hasModifier(event)) return null;
  // `?` is Shift+/ on US; the literal `?` key is also fine via key= property
  if (event.key === '?') return { kind: 'open-overlay' };
  if (event.shiftKey) {
    // Shift+A is the bulk-accept; only this one is shift-modified.
    if (event.key === 'A' || event.key === 'a') {
      return { kind: 'bulk-accept' };
    }
    return null;
  }
  // Single-letter shortcuts. We compare against `event.key` (lowercase) so
  // a CapsLock-on user still gets the same dispatch.
  const k = event.key.toLowerCase();
  if (k in KEY_TO_DECISION) {
    return { kind: 'decide', decision: KEY_TO_DECISION[k]! };
  }
  if (k === 'j') return { kind: 'move-down' };
  if (k === 'k') return { kind: 'move-up' };
  if (k === 'n') return { kind: 'jump-next-undecided' };
  if (k === 'p') return { kind: 'jump-prev-undecided' };
  if (k === 'g') return { kind: 'open-post' };
  return null;
}

/**
 * React hook: install the document-level keydown listener for the
 * decision shortcuts. Callbacks are optional; only the ones supplied
 * fire (so a Storybook surface can opt in to the visual shell without
 * the saga side-effect).
 *
 * `enabled=false` short-circuits the hook so a parent component can
 * disable shortcuts when a modal is open (M1/M3/M5/M6 are responsible
 * for absorbing focus + key events themselves).
 */
export function useDecisionShortcuts(
  callbacks: DecisionShortcutCallbacks,
  enabled: boolean = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      const action = classifyShortcut(event);
      if (!action) return;
      switch (action.kind) {
        case 'decide':
          if (!callbacks.onDecide) return;
          event.preventDefault();
          callbacks.onDecide(action.decision);
          return;
        case 'move-down':
          if (!callbacks.onMoveDown) return;
          event.preventDefault();
          callbacks.onMoveDown();
          return;
        case 'move-up':
          if (!callbacks.onMoveUp) return;
          event.preventDefault();
          callbacks.onMoveUp();
          return;
        case 'jump-next-undecided':
          if (!callbacks.onJumpNextUndecided) return;
          event.preventDefault();
          callbacks.onJumpNextUndecided();
          return;
        case 'jump-prev-undecided':
          if (!callbacks.onJumpPrevUndecided) return;
          event.preventDefault();
          callbacks.onJumpPrevUndecided();
          return;
        case 'bulk-accept':
          if (!callbacks.onBulkAccept) return;
          event.preventDefault();
          callbacks.onBulkAccept();
          return;
        case 'open-overlay':
          if (!callbacks.onOpenOverlay) return;
          event.preventDefault();
          callbacks.onOpenOverlay();
          return;
        case 'open-post':
          if (!callbacks.onOpenPost) return;
          event.preventDefault();
          callbacks.onOpenPost();
          return;
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [callbacks, enabled]);
}

/**
 * Map a `DecisionKey` to the schema-canonical `DecisionKind` value used
 * by the IPC contract. The UI surfaces "request-evidence" but the
 * approval_trail schema only enumerates accept|changes|block|reject; the
 * v0.1 mapping persists request-evidence as "reject" (the schema's
 * fourth value) and the UI label distinguishes the intent.
 *
 * Per gh#11 acceptance criterion 9 — the schema is locked at v0.1.1 and
 * additions to the enum are out-of-scope; this projection is the agreed
 * v0.1 path. Sprint 5 may extend the schema to add a dedicated variant.
 */
export function decisionKeyToSchemaValue(
  k: DecisionKey,
): 'accept' | 'changes' | 'block' | 'reject' {
  if (k === 'request-evidence') return 'reject';
  return k;
}
