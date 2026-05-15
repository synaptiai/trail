import { describe, expect, it } from 'vitest';
import { highlightHunk, prewarmHighlighter } from '@/services/highlight';

/**
 * Highlight service (B3 §15.3) — must:
 *   1. Tokenize a multi-line hunk via shiki's structured API (no regex over
 *      rendered HTML), producing one HighlightedHunkLine per input line.
 *   2. Preserve the kind field (+, -, ' ').
 *   3. Render blank middle lines without dropping them or escaping all
 *      surrounding lines (the F4 regression scenario).
 *   4. Escape HTML in the source so a malicious diff payload cannot inject
 *      raw markup.
 *
 * Per PR #6 cycle-1 review F4 (P2 correctness refined).
 */

describe('highlightHunk', () => {
  it('returns one output line per input line, even for blank middle lines', async () => {
    const lines = [
      { kind: ' ' as const, content: 'function add(a: number, b: number) {' },
      { kind: ' ' as const, content: '' },
      { kind: '+' as const, content: '  return a + b;' },
      { kind: ' ' as const, content: '}' },
    ];
    const result = await highlightHunk({
      language: 'typescript',
      theme: 'trail-dark',
      lines,
    });
    expect(result.lines).toHaveLength(4);
    expect(result.lines[0]!.kind).toBe(' ');
    expect(result.lines[1]!.kind).toBe(' ');
    expect(result.lines[2]!.kind).toBe('+');
    expect(result.lines[3]!.kind).toBe(' ');
    // Each non-empty line should be wrapped in at least one token span.
    expect(result.lines[0]!.html).toMatch(/<span[\s\S]*>function/);
    expect(result.lines[3]!.html).toMatch(/<span[\s\S]*>}/);
  });

  it('preserves the kind field across all lines', async () => {
    const lines = [
      { kind: '-' as const, content: 'const x = 1;' },
      { kind: '+' as const, content: 'const x = 2;' },
    ];
    const result = await highlightHunk({
      language: 'typescript',
      theme: 'trail-dark',
      lines,
    });
    expect(result.lines.map((l) => l.kind)).toEqual(['-', '+']);
  });

  it('escapes HTML in source content (no raw markup injection)', async () => {
    const lines = [
      { kind: ' ' as const, content: 'const evil = "<script>alert(1)</script>";' },
    ];
    const result = await highlightHunk({
      language: 'typescript',
      theme: 'trail-dark',
      lines,
    });
    // The raw <script> bytes must be entity-encoded — &lt;script&gt; — and
    // not appear as literal markup. Token spans are added by shiki, but the
    // string content "<script>" must be escaped in the rendered tokens.
    expect(result.lines[0]!.html).not.toContain('<script>');
    expect(result.lines[0]!.html).toContain('&lt;script&gt;');
  });

  it('renders without a containing pre/code wrapper (caller composes)', async () => {
    const lines = [{ kind: ' ' as const, content: 'x = 1' }];
    const result = await highlightHunk({
      language: 'python',
      theme: 'trail-dark',
      lines,
    });
    // The contract is per-line HTML chunks, NOT a full <pre><code>...</code></pre>
    // document. The DiffHunk component composes these per-row.
    expect(result.lines[0]!.html).not.toMatch(/^<pre/);
  });

  it('handles a 3-line input with blank middle line and highlights all three', async () => {
    // Direct F4 regression scenario from the review:
    //   "feeds a 3-line input including a blank middle line and asserts all
    //    three are highlighted (not escaped fallback)"
    const lines = [
      { kind: ' ' as const, content: 'def foo():' },
      { kind: ' ' as const, content: '' },
      { kind: ' ' as const, content: '    return 42' },
    ];
    const result = await highlightHunk({
      language: 'python',
      theme: 'trail-dark',
      lines,
    });
    expect(result.lines).toHaveLength(3);
    // Lines 0 and 2 are non-empty — they must contain a token span.
    expect(result.lines[0]!.html).toMatch(/<span/);
    expect(result.lines[2]!.html).toMatch(/<span/);
    // Line 1 is empty — its rendered html may be empty string, that's fine.
    expect(typeof result.lines[1]!.html).toBe('string');
  });

  it('warm same-language hunks tokenise in ≤30ms (B3 §15.3 strict budget)', async () => {
    // Sprint 3b — direct measurement of the B3 §15.3 warm budget at the
    // service layer (no React/DOM/Playwright overhead). Prime the
    // singleton once, then measure 5 sequential same-language calls;
    // assert each is within the 30ms budget.
    //
    // Why this complements the Playwright test: the E2E perf spec has
    // ~10-15ms harness jitter that we can't control; this assertion
    // pins the contract at the service layer where the budget actually
    // lives.
    await prewarmHighlighter();
    // Discard the first post-prewarm call's timing — depending on shiki
    // version, the grammar may lazy-resolve on first invocation rather
    // than during prewarm.
    const fixture = [
      { kind: ' ' as const, content: 'export const x = 1;' },
      { kind: '+' as const, content: 'export const y = 2;' },
      { kind: ' ' as const, content: 'export const z = x + y;' },
    ];
    await highlightHunk({ language: 'typescript', theme: 'trail-dark', lines: fixture });
    // Now measure 5 warm calls.
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await highlightHunk({ language: 'typescript', theme: 'trail-dark', lines: fixture });
      timings.push(performance.now() - start);
    }
    // Strict B3 §15.3 budget — measured at service layer.
    for (const [idx, ms] of timings.entries()) {
      expect(
        ms,
        `warm tokenise #${idx + 1} took ${ms.toFixed(1)}ms (budget 30ms; B3 §15.3)`,
      ).toBeLessThan(30);
    }
  });

  it('prewarmHighlighter resolves successfully and primes subsequent calls', async () => {
    // Per PR #6 cycle-2 review N26: prewarmHighlighter() (the singleton-
    // priming entry point invoked at <App> mount per B3 §15.1 step 5) had
    // no test. A regression that breaks the promise-cache (e.g., a re-fetch
    // per call) would not be caught.
    //
    // We assert: (1) prewarmHighlighter resolves without throwing, (2) the
    // call is idempotent — a second invocation also resolves, and (3) a
    // subsequent highlightHunk works against the warmed-up singleton.
    await expect(prewarmHighlighter()).resolves.toBeUndefined();
    await expect(prewarmHighlighter()).resolves.toBeUndefined();
    const result = await highlightHunk({
      language: 'typescript',
      theme: 'trail-dark',
      lines: [{ kind: ' ' as const, content: 'const x = 1;' }],
    });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.html).toMatch(/<span/);
  });
});
