import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import './DiffHunk.css';
import { highlightHunk, type HighlightedHunk } from '@/services/highlight';

/**
 * <DiffHunk> primitive (B3 §15.2 #10, B6 P1 — shiki-only).
 *
 * Lazy-loads shiki highlighter on first paint and caches per language to keep
 * cold start ≤ 250ms (B3 §15.3 budget) while warm hits stay ≤ 30ms.
 *
 * Diff additions/removals retain their --risk-low-bg / --risk-high-bg row tint
 * (B3 §3.5) so the syntax color layer stays purely informational.
 *
 * Accessibility:
 *   - role="region" with aria-label="Diff hunk: <path>" so SR users can locate it.
 *   - + / − prefix characters render in the gutter so addition / removal isn't
 *     conveyed by color alone (B3 §12.2).
 */

export interface DiffHunkLine {
  /** '+' (addition), '-' (removal), ' ' (context). */
  kind: '+' | '-' | ' ';
  /** Original line content WITHOUT the +/- prefix. */
  content: string;
  /** Optional new-side line number; null for removals. */
  newLineNo?: number | null;
  /** Optional old-side line number; null for additions. */
  oldLineNo?: number | null;
}

/**
 * Cycle-3 C3 (PR #21): map the literal `+`/`-`/` ` line-kind discriminator
 * to a CSS-safe word ("add"/"del"/"ctx"). The previous class names —
 * `diff-hunk__line--+` and `diff-hunk__line---` — used CSS escape syntax
 * (`\+`, `\-`) in the stylesheet but axe-core walks the DOM with raw
 * `Element.matches('.diff-hunk__line--+...')`, which happy-dom 20's
 * stricter SelectorParser correctly rejects as an invalid CSS selector.
 * The word-form is a no-op visual change (CSS rules updated to match)
 * and clears the axe-core a11y scan failure.
 */
function kindToClass(kind: DiffHunkLine['kind']): 'add' | 'del' | 'ctx' {
  if (kind === '+') return 'add';
  if (kind === '-') return 'del';
  return 'ctx';
}

export interface DiffHunkProps {
  /** File path for the hunk header + ARIA label. */
  path: string;
  /** Source language (shiki bundled grammar id). */
  language: 'typescript' | 'tsx' | 'javascript' | 'jsx' | 'python' | 'rust' | 'go' | 'yaml' | 'json' | 'bash' | 'plaintext';
  /** Hunk header (e.g., "@@ -10,7 +10,11 @@" or a structured ReactNode). */
  header?: ReactNode;
  /** Pre-parsed hunk lines. */
  lines: readonly DiffHunkLine[];
  /** Theme — defaults to current document theme attribute. */
  theme?: 'trail-dark' | 'trail-light';
  /** Optional fallback (rendered while highlight is loading). */
  fallback?: ReactNode;
}

export function DiffHunk({
  path,
  language,
  header,
  lines,
  theme,
  fallback,
}: DiffHunkProps) {
  const [highlighted, setHighlighted] = useState<HighlightedHunk | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const resolveTheme: 'trail-dark' | 'trail-light' =
      theme ?? (document.documentElement.dataset['theme'] === 'light' ? 'trail-light' : 'trail-dark');
    highlightHunk({ language, theme: resolveTheme, lines })
      .then((result) => {
        if (!cancelled) setHighlighted(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [language, theme, lines]);

  return (
    <section className="diff-hunk" role="region" aria-label={`Diff hunk: ${path}`}>
      <header className="diff-hunk__header type-mono">
        <span className="diff-hunk__path">{path}</span>
        {header ? <span className="diff-hunk__range">{header}</span> : null}
      </header>
      <pre className="diff-hunk__body type-mono">
        {highlighted
          ? highlighted.lines.map((line, idx) => (
              <div
                key={idx}
                className={`diff-hunk__line diff-hunk__line--${kindToClass(line.kind)}`}
              >
                <span className="diff-hunk__gutter" aria-hidden="true">
                  {line.kind === '+' ? '+' : line.kind === '-' ? '−' : ' '}
                </span>
                <span
                  className="diff-hunk__content"
                  dangerouslySetInnerHTML={{ __html: line.html }}
                />
              </div>
            ))
          : (fallback ?? (
              <div className="diff-hunk__placeholder">
                {error ? `Highlight failed: ${error}` : 'Loading…'}
                {/* When highlight fails, fall back to plain text so the diff is
                    still legible (color alone is never the only encoding). */}
                {error
                  ? lines.map((line, idx) => (
                      <div
                key={idx}
                className={`diff-hunk__line diff-hunk__line--${kindToClass(line.kind)}`}
              >
                        <span className="diff-hunk__gutter" aria-hidden="true">
                          {line.kind === '+' ? '+' : line.kind === '-' ? '−' : ' '}
                        </span>
                        <span className="diff-hunk__content">{line.content}</span>
                      </div>
                    ))
                  : null}
              </div>
            ))}
      </pre>
    </section>
  );
}
