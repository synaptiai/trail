import { useEffect, useMemo, useState } from 'react';
import './CodeBlock.css';
import {
  highlightCode,
  type HighlightedCode,
  type HighlightLanguage,
  type HighlightTheme,
} from '@/services/highlight';

/**
 * <CodeBlock> primitive — Sprint 3b (gh#10 criterion 3).
 *
 * Renders a passage of code with shiki syntax highlighting. Differs from
 * `<DiffHunk>` (B3 §15.2 #10) in three ways:
 *   1. Semantics: role="figure" (a single passage of code) vs role="region"
 *      (a diff hunk with addition/removal axis).
 *   2. Shape: ONE block of code, not a +/− line array. The caller passes a
 *      `code: string` and we split on \n internally so the markup mirrors
 *      shiki's per-line tokenization.
 *   3. Background: surface-raised, no risk-low/high tint (additions/removals
 *      have meaning in a diff; an evidence excerpt does not).
 *
 * Used by the Diff tab's per-claim evidence excerpt subsection (B4 §4.4 +
 * §4.5) where the caller wants to surface a small slice of code without the
 * +/− gutter.
 *
 * Theme handoff (B3 §3.5):
 *   - Resolves theme from `data-theme` on <html> if not specified, so
 *     Settings → Appearance → Theme drives both diff hunks and code blocks.
 *   - The token JSON is the canonical port of the B3 §3.5 token table; the
 *     `prefers-reduced-motion: reduce` carve-out is enforced by the global
 *     `tokens.css` block (no per-component opt-in needed; all transitions
 *     short-circuit at the document root).
 *
 * Performance:
 *   - First call shares the singleton highlighter with `<DiffHunk>`, so the
 *     250ms shiki cold-start cost is paid AT MOST ONCE per session (B3
 *     §15.3). Subsequent CodeBlock renders are warm at ≤30ms.
 *   - The grammar lazy-loads on first use of an unregistered language; the
 *     pre-warm at <App> mount covers the top-4 grammars.
 */

export interface CodeBlockProps {
  /** Source language (registered shiki grammar). */
  language: HighlightLanguage;
  /** Source code. \n line splits; CRLF is normalised. */
  code: string;
  /** Required ARIA label so screen readers can locate the figure. */
  ariaLabel: string;
  /** Optional theme override; defaults to document `[data-theme]`. */
  theme?: HighlightTheme;
  /** Optional caption rendered below the code (figcaption — read by AT). */
  caption?: string;
}

export function CodeBlock({
  language,
  code,
  ariaLabel,
  theme,
  caption,
}: CodeBlockProps) {
  const [highlighted, setHighlighted] = useState<HighlightedCode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolvedTheme: HighlightTheme = useMemo(() => {
    if (theme) return theme;
    if (typeof document === 'undefined') return 'trail-dark';
    return document.documentElement.dataset['theme'] === 'light'
      ? 'trail-light'
      : 'trail-dark';
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    highlightCode({ language, theme: resolvedTheme, code })
      .then((result) => {
        if (!cancelled) setHighlighted(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [language, resolvedTheme, code]);

  return (
    <figure
      className="code-block"
      role="figure"
      aria-label={ariaLabel}
      // `data-lang` (NOT `lang=`): the HTML `lang` attribute denotes human
      // language per WCAG 3.1.1/3.1.2 (BCP-47), so axe-core's `valid-lang`
      // rule rejects values like "typescript". Programming language is
      // exposed instead via a data-attribute that AT can be configured to
      // surface, and via the figure's `aria-label` text where the caller
      // can include the language hint if relevant.
      data-lang={language}
    >
      <pre className="code-block__body type-mono">
        {highlighted ? (
          highlighted.lines.map((line, idx) => (
            <div key={idx} className="code-block__line">
              <span
                className="code-block__content"
                // shiki output is structurally generated per line via the
                // typed `codeToTokens` API; raw source content is HTML-
                // escaped before composition (see services/highlight.ts).
                dangerouslySetInnerHTML={{ __html: line.html }}
              />
            </div>
          ))
        ) : error ? (
          // F4-style resilience — when highlight fails, fall back to plain
          // text so the excerpt is still legible. The diagnostic header
          // surfaces the failure mode.
          <div className="code-block__placeholder">
            <span className="code-block__error type-mono-sm">
              Highlight failed: {error}
            </span>
            {code.split('\n').map((line, idx) => (
              <div key={idx} className="code-block__line">
                <span className="code-block__content">{line}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="code-block__placeholder">Loading…</div>
        )}
      </pre>
      {caption ? <figcaption className="code-block__caption type-body-sm">{caption}</figcaption> : null}
    </figure>
  );
}
