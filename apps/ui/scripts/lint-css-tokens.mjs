#!/usr/bin/env node
/**
 * lint-css-tokens — extend the `tokens/no-raw-design-values` ESLint rule's
 * contract to actual CSS files (B3 §15.1 step 6 / B5 §5.1.1).
 *
 * Why a separate script: ESLint's flat-config processor API does not natively
 * tokenize CSS. Stylelint would work but adds a sizeable dep tree; the spec
 * calls for "plain regex over CSS source files." This script is exactly that.
 *
 * Rules (mirror eslint.config.mjs `noRawDesignValues`):
 *   - Raw hex (#XXX/#XXXXXX/#XXXXXXXX) outside the allowlist → ERROR
 *   - Raw px (Npx) outside the allowlist → ERROR
 *
 * Allowlisted files (single source of truth for design values):
 *   - src/design/tokens.ts  (TS authoring file — handled by ESLint)
 *   - src/design/tokens.css (codegen output — has all the raw px)
 *
 * Allowed inside non-allowlisted CSS (defense-in-depth carve-outs documented
 * here, not in the file under lint, so violations show up in review):
 *   - Raw px inside `@media (...)` rules — CSS @media DOES NOT accept
 *     custom properties at parse time (per CSSWG), so breakpoint values
 *     must be raw. Each occurrence must have a sibling comment naming the
 *     `--breakpoint-*` token it mirrors.
 *   - `0px` is permitted (semantically zero; no token needed).
 *   - rgba()/hsla() containing numeric components — those are color literals
 *     INSIDE function syntax and never confusable with raw color hashes.
 *
 * Per PR #6 cycle-1 review F1 (P1 tooling-correctness, consensus HIGH).
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const SRC = join(ROOT, 'src');

const ALLOWLISTED_RELATIVE = new Set([
  'src/design/tokens.ts',
  'src/design/tokens.css',
]);

// Cycle-2 N8 fix: only match VALID CSS color-hash lengths (3, 4, 6, 8). The
// previous `{3,8}` also matched 5/7 which aren't valid CSS hex colors and
// caused false-positives on identifiers like `#deadb0` (used in test
// fixtures). Using an alternation keeps the regex simple.
const RAW_HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
// Cycle-2 N9 fix: include leading `-` so `margin: -14px` is flagged. The
// previous regex's negative-lookbehind boundary class `[^a-zA-Z0-9_-]`
// tolerated `-` as a "non-leading" char, masking negative literals.
const RAW_PX = /(?:^|[^a-zA-Z0-9_])(-?\d+(?:\.\d+)?)px\b/g;

/**
 * Walk a directory recursively, returning all CSS file paths.
 * Excludes `node_modules`, build artefacts, and the codegen output.
 */
async function walkCss(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const ent of entries) {
      const fp = join(current, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'storybook-static') continue;
        stack.push(fp);
      } else if (ent.isFile() && ent.name.endsWith('.css')) {
        out.push(fp);
      }
    }
  }
  return out;
}

function relForLog(fp) {
  return relative(ROOT, fp).replace(/\\/g, '/');
}

/**
 * For a given line of CSS, return findings as an array of { type, value, col }.
 * Skips occurrences inside @media query expressions (treated as
 * documented-token mirrors per the carve-out above).
 */
function scanLine(line) {
  const findings = [];
  // Detect `@media (...)` and skip — but ONLY when the line itself is the
  // @media at-rule header. Inside-block lines that follow are fully scanned.
  const isMediaHeader = /^\s*@media\b/.test(line);
  if (isMediaHeader) {
    // Still scan for hex (breakpoint hex makes no sense), but skip px.
    for (const m of line.matchAll(RAW_HEX)) {
      findings.push({ type: 'hex', value: m[0], col: m.index ?? 0 });
    }
    return findings;
  }
  for (const m of line.matchAll(RAW_HEX)) {
    findings.push({ type: 'hex', value: m[0], col: m.index ?? 0 });
  }
  for (const m of line.matchAll(RAW_PX)) {
    // `0px` is semantically zero — no token needed.
    if (m[1] === '0') continue;
    findings.push({ type: 'px', value: `${m[1]}px`, col: m.index ?? 0 });
  }
  return findings;
}

/**
 * Strip block comments by walking the file text character-by-character,
 * preserving line breaks so line numbers stay accurate. This replaces the
 * prior line-by-line `*`-prefix heuristic which falsely flagged middle
 * lines of multi-line comments without a `*` prefix (cycle-2 N7).
 *
 * Returns an array of strings, one per source line, with comments masked
 * to spaces.
 */
function maskBlockComments(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  let inComment = false;
  for (const line of lines) {
    let masked = '';
    let i = 0;
    while (i < line.length) {
      if (!inComment) {
        if (line[i] === '/' && line[i + 1] === '*') {
          masked += '  ';
          inComment = true;
          i += 2;
        } else if (line[i] === '/' && line[i + 1] === '/') {
          // Line-end // comment — fill rest of the line with spaces.
          masked += ' '.repeat(line.length - i);
          break;
        } else {
          masked += line[i];
          i++;
        }
      } else {
        if (line[i] === '*' && line[i + 1] === '/') {
          masked += '  ';
          inComment = false;
          i += 2;
        } else {
          masked += ' ';
          i++;
        }
      }
    }
    out.push(masked);
  }
  return out;
}

async function lintFile(fp) {
  const rel = relForLog(fp);
  if (ALLOWLISTED_RELATIVE.has(rel)) return [];
  const src = await readFile(fp, 'utf8');
  const lines = maskBlockComments(src);
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineFindings = scanLine(line);
    for (const f of lineFindings) {
      findings.push({ file: rel, line: i + 1, col: f.col + 1, type: f.type, value: f.value });
    }
  }
  return findings;
}

async function main() {
  const cssFiles = await walkCss(SRC);
  const allFindings = [];
  for (const fp of cssFiles) {
    const findings = await lintFile(fp);
    allFindings.push(...findings);
  }
  if (allFindings.length === 0) {
    console.log(`lint-css-tokens: scanned ${cssFiles.length} file(s); no raw design values found.`);
    return;
  }
  for (const f of allFindings) {
    const msg =
      f.type === 'hex'
        ? `raw hex literal "${f.value}" — use a CSS variable from tokens.css`
        : `raw ${f.value} — use --space-*/--size-*/--border-width-* from tokens.ts`;
    console.error(`${f.file}:${f.line}:${f.col}  ${msg}`);
  }
  console.error(`\nlint-css-tokens: ${allFindings.length} violation(s) across ${cssFiles.length} file(s).`);
  process.exit(1);
}

main().catch((err) => {
  console.error('lint-css-tokens: fatal:', err);
  process.exit(2);
});
