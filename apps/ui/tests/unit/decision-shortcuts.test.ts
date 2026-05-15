/**
 * Unit tests for the decision-shortcuts dispatcher.
 *
 * Pins the contract from gh#11 criterion 9:
 *   a/c/b/r → decide(accept|changes|block|request-evidence)
 *   j/k → move-down / move-up
 *   n/p → jump-next-undecided / jump-prev-undecided
 *   Shift+A → bulk-accept
 *   ? → open-overlay
 *
 * Plus the suppression rules:
 *   - Modifier-bearing combos (Ctrl/Cmd/Alt) pass through (return null).
 *   - text-entry targets (input/textarea/contenteditable/role=textbox)
 *     suppress dispatch.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyShortcut,
  decisionKeyToSchemaValue,
} from '@/services/decision-shortcuts';

function ev(
  init: Partial<KeyboardEventInit> & { key: string; target?: EventTarget | null },
): KeyboardEvent {
  // happy-dom KeyboardEvent honours target via Object.defineProperty in the
  // event init. We construct via new KeyboardEvent + explicit target setter
  // because spec init does not include target.
  const e = new KeyboardEvent('keydown', init);
  if (init.target) {
    Object.defineProperty(e, 'target', {
      configurable: true,
      get: () => init.target ?? null,
    });
  }
  return e;
}

describe('classifyShortcut', () => {
  it('maps a → accept', () => {
    const a = classifyShortcut(ev({ key: 'a' }));
    expect(a).toEqual({ kind: 'decide', decision: 'accept' });
  });

  it('maps c → changes', () => {
    expect(classifyShortcut(ev({ key: 'c' }))).toEqual({
      kind: 'decide',
      decision: 'changes',
    });
  });

  it('maps b → block', () => {
    expect(classifyShortcut(ev({ key: 'b' }))).toEqual({
      kind: 'decide',
      decision: 'block',
    });
  });

  it('maps r → request-evidence', () => {
    expect(classifyShortcut(ev({ key: 'r' }))).toEqual({
      kind: 'decide',
      decision: 'request-evidence',
    });
  });

  it('maps j → move-down', () => {
    expect(classifyShortcut(ev({ key: 'j' }))).toEqual({ kind: 'move-down' });
  });

  it('maps k → move-up', () => {
    expect(classifyShortcut(ev({ key: 'k' }))).toEqual({ kind: 'move-up' });
  });

  it('maps n / p → jump-next/prev-undecided', () => {
    expect(classifyShortcut(ev({ key: 'n' }))).toEqual({
      kind: 'jump-next-undecided',
    });
    expect(classifyShortcut(ev({ key: 'p' }))).toEqual({
      kind: 'jump-prev-undecided',
    });
  });

  it('Shift+A → bulk-accept', () => {
    const e = classifyShortcut(ev({ key: 'A', shiftKey: true }));
    expect(e).toEqual({ kind: 'bulk-accept' });
    // lowercase a with shift also lands on bulk-accept (Caps locked / non-US)
    const e2 = classifyShortcut(ev({ key: 'a', shiftKey: true }));
    expect(e2).toEqual({ kind: 'bulk-accept' });
  });

  it('? → open-overlay', () => {
    expect(classifyShortcut(ev({ key: '?' }))).toEqual({ kind: 'open-overlay' });
  });

  it('returns null for modifier combos (Ctrl+A select-all)', () => {
    expect(classifyShortcut(ev({ key: 'a', ctrlKey: true }))).toBeNull();
    expect(classifyShortcut(ev({ key: 'r', metaKey: true }))).toBeNull();
    expect(classifyShortcut(ev({ key: 'j', altKey: true }))).toBeNull();
  });

  it('returns null when target is an input', () => {
    const input = document.createElement('input');
    expect(classifyShortcut(ev({ key: 'a', target: input }))).toBeNull();
  });

  it('returns null when target is contenteditable', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    expect(classifyShortcut(ev({ key: 'a', target: div }))).toBeNull();
  });

  it('returns null when target has role=textbox', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'textbox');
    expect(classifyShortcut(ev({ key: 'a', target: el }))).toBeNull();
  });

  it('returns null for unknown keys', () => {
    expect(classifyShortcut(ev({ key: 'x' }))).toBeNull();
    expect(classifyShortcut(ev({ key: 'Enter' }))).toBeNull();
  });
});

describe('decisionKeyToSchemaValue', () => {
  it('maps the four UI decisions onto the schema enum', () => {
    expect(decisionKeyToSchemaValue('accept')).toBe('accept');
    expect(decisionKeyToSchemaValue('changes')).toBe('changes');
    expect(decisionKeyToSchemaValue('block')).toBe('block');
    expect(decisionKeyToSchemaValue('request-evidence')).toBe('reject');
  });
});
