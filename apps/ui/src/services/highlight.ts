/**
 * Shiki highlighter service — singleton + per-language cache.
 *
 * Cold start: loads oniguruma WASM + the requested grammar (~250ms budget per
 * B3 §15.3). Subsequent same-language hunks: ~30ms.
 *
 * Pre-warm hook: `prewarmHighlighter(['typescript', 'python', 'rust', 'go'])`
 * is invoked at <App> mount per B3 §15.1 step 5. This trades 200-400ms idle
 * work at app launch for sub-50ms hunks across the session.
 *
 * Per PR #6 cycle-1 review F4: this module previously joined hunk lines,
 * tokenized once with codeToHtml, then SPLIT THE HTML BACK into per-line
 * spans via the regex `<span class="line">([\s\S]*?)<\/span>`. That regex
 * is brittle to shiki's output (e.g., `<span class="line empty">`, future
 * ARIA wrappers, transformer plugins) and silently falls back to escaped
 * raw content on mismatch — breaking syntax highlighting asymmetrically
 * across the hunk. The new implementation uses shiki's official
 * `codeToTokens` API which returns a 2D `ThemedToken[][]` array (one inner
 * array per source line, even for blank lines and CRLF inputs). Each line
 * is rendered to safe HTML via a structured walk; no regex over shiki's
 * own emission, so a shiki version bump cannot drift the contract.
 */
import type { ThemedToken } from 'shiki';
import type { DiffHunkLine } from '@/components/primitives/DiffHunk';
import trailDarkTheme from '@/design/shiki-themes/trail-dark.json';
import trailLightTheme from '@/design/shiki-themes/trail-light.json';

export type HighlightLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'python'
  | 'rust'
  | 'go'
  | 'yaml'
  | 'json'
  | 'bash'
  | 'plaintext';

/**
 * Resolve the shiki language id from a file path. Sprint 3b's `<DiffTab>` and
 * `<DiffHunk>` call this with `semantic_changes[].files[0]`. Unknown
 * extensions fall back to `plaintext` rather than guessing, so the diff still
 * paints (B3 §15.3 budget) and shiki avoids loading an unbundled grammar.
 *
 * Mapping covers the top-4 pre-warmed grammars (typescript/python/go/rust)
 * plus the cohort registered in `getHighlighter()`. Extension list is
 * intentionally flat: a registered extension always pre-resolves; anything
 * else short-circuits to plaintext (no guessing). Per F25: the extension
 * table is the single source of truth — drift between this map and
 * `getHighlighter()`'s `langs` array is a real bug, so the test
 * `inferLanguage covers every language registered in the highlighter`
 * pins them together.
 */
export function inferLanguage(filePath: string): HighlightLanguage {
  // Lowercase the basename only (paths can carry uppercase Windows-style
  // segments; we want extension match on the leaf).
  const lower = filePath.toLowerCase();
  // Match the rightmost `.ext` AFTER the last path separator. Compound
  // extensions (e.g., `.spec.ts` → `.ts`) resolve to the inner extension.
  const lastSlash = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'));
  const basename = lastSlash >= 0 ? lower.slice(lastSlash + 1) : lower;
  const dot = basename.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  const ext = basename.slice(dot + 1);
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'py':
    case 'pyi':
      return 'python';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'json':
    case 'jsonc':
      return 'json';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    default:
      return 'plaintext';
  }
}

export type HighlightTheme = 'trail-dark' | 'trail-light';

export interface HighlightedHunkLine {
  kind: '+' | '-' | ' ';
  /** HTML emitted by shiki, scoped to a single line. */
  html: string;
}

export interface HighlightedHunk {
  language: HighlightLanguage;
  theme: HighlightTheme;
  lines: HighlightedHunkLine[];
}

interface HighlighterFacade {
  codeToTokens: (
    code: string,
    options: { lang: string; theme: string },
  ) => { tokens: ThemedToken[][] };
}

let highlighterPromise: Promise<HighlighterFacade> | null = null;

async function getHighlighter(): Promise<HighlighterFacade> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    const { createHighlighter } = await import('shiki');
    const highlighter = await createHighlighter({
      themes: [trailDarkTheme as never, trailLightTheme as never],
      langs: ['typescript', 'tsx', 'javascript', 'jsx', 'python', 'rust', 'go', 'yaml', 'json', 'bash'],
    });
    return {
      codeToTokens: (code: string, options) =>
        highlighter.codeToTokens(code, {
          lang: options.lang as never,
          theme: options.theme,
        }),
    };
  })();
  return highlighterPromise;
}

/** Pre-warm the highlighter with the most-common grammars (per B3 §15.1 step 5). */
export async function prewarmHighlighter(): Promise<void> {
  await getHighlighter();
}

interface HighlightHunkArgs {
  language: HighlightLanguage;
  theme: HighlightTheme;
  lines: readonly DiffHunkLine[];
}

/**
 * Renders a single tokenized line to safe HTML. Each token becomes a
 * `<span style="color:...">content</span>`; the content is HTML-escaped so
 * even if shiki's tokenizer produced an unsafe string we never inject raw
 * markup. The fontStyle bits map to italic/bold/underline (shiki encodes
 * them as a bitmask: 1=italic, 2=bold, 4=underline, 8=strike).
 */
function renderLineHtml(tokens: ThemedToken[]): string {
  if (tokens.length === 0) return '';
  return tokens.map(renderTokenHtml).join('');
}

function renderTokenHtml(token: ThemedToken): string {
  const styles: string[] = [];
  if (token.color) styles.push(`color:${token.color}`);
  if (token.bgColor) styles.push(`background-color:${token.bgColor}`);
  if (token.fontStyle && token.fontStyle > 0) {
    if ((token.fontStyle & 1) !== 0) styles.push('font-style:italic');
    if ((token.fontStyle & 2) !== 0) styles.push('font-weight:bold');
    if ((token.fontStyle & 4) !== 0) styles.push('text-decoration:underline');
    if ((token.fontStyle & 8) !== 0) styles.push('text-decoration:line-through');
  }
  const styleAttr = styles.length > 0 ? ` style="${styles.join(';')}"` : '';
  return `<span${styleAttr}>${escapeHtml(token.content)}</span>`;
}

/**
 * Highlights an entire hunk by joining its content lines with a delimiter,
 * tokenizing once via shiki's typed `codeToTokens` API, then walking the
 * `ThemedToken[][]` per-line. This is dramatically cheaper than tokenizing
 * per-line because shiki resolves multi-line constructs (template strings,
 * block comments) correctly at hunk scope, and the shape contract is
 * structural — no regex over rendered HTML.
 *
 * Returns one HighlightedHunkLine per input line; the kind field is
 * preserved. If shiki returns fewer lines than expected (e.g., a trailing
 * empty line that the tokenizer collapses), the caller falls back to
 * escaped raw content per-line so the hunk still renders.
 */
export async function highlightHunk(args: HighlightHunkArgs): Promise<HighlightedHunk> {
  const { language, theme, lines } = args;
  const highlighter = await getHighlighter();
  const code = lines.map((l) => l.content).join('\n');
  const result = highlighter.codeToTokens(code, { lang: language, theme });
  const tokenLines = result.tokens;
  const out: HighlightedHunkLine[] = lines.map((line, idx) => {
    const lineTokens = tokenLines[idx];
    if (!lineTokens) {
      // shiki collapsed a line — render escaped raw content rather than
      // dropping it. This preserves diff fidelity even on grammar edge cases.
      return { kind: line.kind, html: escapeHtml(line.content) };
    }
    return { kind: line.kind, html: renderLineHtml(lineTokens) };
  });
  return { language, theme, lines: out };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sprint 3b: tokenise a single code block (no +/− kind axis). Used by the
 * `<CodeBlock>` primitive that renders evidence excerpts in the Diff tab and
 * elsewhere. Returns one HTML chunk per source line so the caller can wrap
 * each line with a row container (line-numbers slot, hover state, etc.) —
 * not a `<pre><code>` document. This shape mirrors `highlightHunk` so the
 * caller's contract is symmetric (one input line → one HTML chunk).
 */
export interface HighlightedCodeLine {
  /** HTML emitted by shiki, scoped to a single line. */
  html: string;
}

export interface HighlightedCode {
  language: HighlightLanguage;
  theme: HighlightTheme;
  lines: HighlightedCodeLine[];
}

interface HighlightCodeArgs {
  language: HighlightLanguage;
  theme: HighlightTheme;
  /** Source code; lines split on \n. CRLF is normalised to LF before tokenising. */
  code: string;
}

export async function highlightCode(args: HighlightCodeArgs): Promise<HighlightedCode> {
  const { language, theme } = args;
  // Normalise CRLF→LF so shiki's per-line tokenisation aligns with the
  // caller's line.split('\n') (the underlying tokenizer accepts both, but
  // the line count mismatches if the caller's split disagrees with the
  // tokenizer's internal split).
  const code = args.code.replace(/\r\n/g, '\n');
  const sourceLines = code.split('\n');
  const highlighter = await getHighlighter();
  const result = highlighter.codeToTokens(code, { lang: language, theme });
  const tokenLines = result.tokens;
  const out: HighlightedCodeLine[] = sourceLines.map((source, idx) => {
    const lineTokens = tokenLines[idx];
    if (!lineTokens) {
      // Symmetric fallback to highlightHunk: collapsed lines render as
      // escaped raw content so paint never silently drops content.
      return { html: escapeHtml(source) };
    }
    return { html: renderLineHtml(lineTokens) };
  });
  return { language, theme, lines: out };
}
