import { describe, expect, it } from 'vitest';
import { excerptsToHunkLines } from '@/components/screens/DiffTab';
import type { SemanticChangeShape } from '@/services/packet-loader';

/**
 * Sprint 3b — direct tests for the excerpt → DiffHunkLine mapping
 * (cycle-1 self-review F1 — the function is exported but only used
 * by DiffTab; without direct tests a refactor that breaks the mapping
 * could pass DiffTab.test.tsx if the test data happens to mask the
 * regression).
 *
 * Locked enum semantics from schema/$defs/excerpt.kind:
 *   - "before"            → removal (-)
 *   - "after"             → addition (+)
 *   - "before#N" 1..5     → removal, paired with after#N
 *   - "after#N"  1..5     → addition, paired with before#N
 *   - hunks beyond #5 silently dropped
 */

const baseChange = (overrides: Partial<SemanticChangeShape>): SemanticChangeShape => ({
  id: 'DIFF-001',
  description: 'test',
  files: ['src/x.ts'],
  operation: 'edit',
  excerpts: [],
  ...overrides,
});

describe('excerptsToHunkLines — write op', () => {
  it('renders all excerpts as additions for write op', () => {
    const lines = excerptsToHunkLines(
      baseChange({
        operation: 'write',
        excerpts: [
          { kind: 'after', text: 'line 1\nline 2', elided: false },
        ],
      }),
    );
    expect(lines).toEqual([
      { kind: '+', content: 'line 1' },
      { kind: '+', content: 'line 2' },
    ]);
  });
});

describe('excerptsToHunkLines — edit op', () => {
  it('partitions before/after into - / + lines (removals first per git convention)', () => {
    const lines = excerptsToHunkLines(
      baseChange({
        operation: 'edit',
        excerpts: [
          { kind: 'before', text: 'old line', elided: false },
          { kind: 'after', text: 'new line', elided: false },
        ],
      }),
    );
    expect(lines).toEqual([
      { kind: '-', content: 'old line' },
      { kind: '+', content: 'new line' },
    ]);
  });

  it('preserves order within each kind partition', () => {
    const lines = excerptsToHunkLines(
      baseChange({
        operation: 'edit',
        excerpts: [
          { kind: 'before', text: 'old1', elided: false },
          { kind: 'before', text: 'old2', elided: false },
          { kind: 'after', text: 'new1', elided: false },
        ],
      }),
    );
    expect(lines.map((l) => l.content)).toEqual(['old1', 'old2', 'new1']);
  });

  it('handles multi-line excerpts by splitting on \\n', () => {
    const lines = excerptsToHunkLines(
      baseChange({
        operation: 'edit',
        excerpts: [{ kind: 'after', text: 'a\nb\nc', elided: false }],
      }),
    );
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.content)).toEqual(['a', 'b', 'c']);
    lines.forEach((l) => expect(l.kind).toBe('+'));
  });

  it('normalises CRLF to LF before splitting', () => {
    const lines = excerptsToHunkLines(
      baseChange({
        operation: 'edit',
        excerpts: [{ kind: 'after', text: 'a\r\nb', elided: false }],
      }),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]!.content).toBe('a');
    expect(lines[1]!.content).toBe('b');
  });

  it('emits an elision marker as a context line when excerpt was clipped', () => {
    const lines = excerptsToHunkLines(
      baseChange({
        operation: 'edit',
        excerpts: [{ kind: 'after', text: 'partial content', elided: true }],
      }),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ kind: '+', content: 'partial content' });
    expect(lines[1]!.kind).toBe(' ');
    expect(lines[1]!.content).toContain('clipped during capture');
  });
});

describe('excerptsToHunkLines — multiedit op', () => {
  it('pairs before#N / after#N excerpts in N-order', () => {
    const lines = excerptsToHunkLines(
      baseChange({
        operation: 'multiedit',
        excerpts: [
          { kind: 'after#2', text: 'after-two', elided: false },
          { kind: 'before#1', text: 'before-one', elided: false },
          { kind: 'after#1', text: 'after-one', elided: false },
          { kind: 'before#2', text: 'before-two', elided: false },
        ],
      }),
    );
    expect(lines).toEqual([
      { kind: '-', content: 'before-one' },
      { kind: '+', content: 'after-one' },
      { kind: '-', content: 'before-two' },
      { kind: '+', content: 'after-two' },
    ]);
  });

  it('drops hunks numbered beyond #5 silently per schema', () => {
    const lines = excerptsToHunkLines(
      baseChange({
        operation: 'multiedit',
        excerpts: [
          { kind: 'before#6', text: 'should drop', elided: false },
          { kind: 'after#1', text: 'kept', elided: false },
        ],
      }),
    );
    expect(lines).toEqual([{ kind: '+', content: 'kept' }]);
  });

  it('handles a multiedit with only one side present (orphan before/after)', () => {
    const lines = excerptsToHunkLines(
      baseChange({
        operation: 'multiedit',
        excerpts: [{ kind: 'before#1', text: 'orphan-before', elided: false }],
      }),
    );
    expect(lines).toEqual([{ kind: '-', content: 'orphan-before' }]);
  });

  it('preserves elision markers per side', () => {
    const lines = excerptsToHunkLines(
      baseChange({
        operation: 'multiedit',
        excerpts: [
          { kind: 'before#1', text: 'old', elided: true },
          { kind: 'after#1', text: 'new', elided: false },
        ],
      }),
    );
    expect(lines).toEqual([
      { kind: '-', content: 'old' },
      { kind: ' ', content: '… [excerpt clipped during capture]' },
      { kind: '+', content: 'new' },
    ]);
  });

  it('skips kinds that do not match the multiedit pattern', () => {
    const lines = excerptsToHunkLines(
      baseChange({
        operation: 'multiedit',
        // 'before' (no #N) doesn't match the multiedit shape; should drop.
        excerpts: [
          { kind: 'before', text: 'invalid', elided: false },
          { kind: 'after#1', text: 'valid', elided: false },
        ],
      }),
    );
    expect(lines).toEqual([{ kind: '+', content: 'valid' }]);
  });
});
