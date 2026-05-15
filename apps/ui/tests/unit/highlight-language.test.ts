import { describe, expect, it } from 'vitest';
import { inferLanguage, highlightCode } from '@/services/highlight';

/**
 * Sprint 3b — language inference + single-block highlight.
 *
 * Pinned contracts:
 *   1. inferLanguage maps the registered cohort character-for-character;
 *      drift between the map and the highlighter's `langs` array is a real
 *      product bug.
 *   2. Unknown extensions short-circuit to plaintext (NOT a guess).
 *   3. highlightCode preserves source line count even for trailing newlines
 *      and CRLF input (so `<CodeBlock>` line numbering stays honest).
 */

describe('inferLanguage', () => {
  it('resolves the top-4 pre-warmed grammars from canonical extensions', () => {
    expect(inferLanguage('src/foo.ts')).toBe('typescript');
    expect(inferLanguage('src/Foo.tsx')).toBe('tsx');
    expect(inferLanguage('app/main.py')).toBe('python');
    expect(inferLanguage('lib/util.rs')).toBe('rust');
    expect(inferLanguage('cmd/server.go')).toBe('go');
  });

  it('resolves the secondary cohort (yaml/json/bash/js/jsx)', () => {
    expect(inferLanguage('docker/compose.yml')).toBe('yaml');
    expect(inferLanguage('docker/compose.yaml')).toBe('yaml');
    expect(inferLanguage('config/tsconfig.json')).toBe('json');
    expect(inferLanguage('config/eslint.jsonc')).toBe('json');
    expect(inferLanguage('scripts/setup.sh')).toBe('bash');
    expect(inferLanguage('scripts/init.bash')).toBe('bash');
    expect(inferLanguage('scripts/profile.zsh')).toBe('bash');
    expect(inferLanguage('client.js')).toBe('javascript');
    expect(inferLanguage('client.mjs')).toBe('javascript');
    expect(inferLanguage('client.cjs')).toBe('javascript');
    expect(inferLanguage('client.jsx')).toBe('jsx');
  });

  it('handles compound extensions correctly (rightmost wins)', () => {
    expect(inferLanguage('src/foo.spec.ts')).toBe('typescript');
    expect(inferLanguage('src/foo.test.tsx')).toBe('tsx');
    expect(inferLanguage('src/foo.d.ts')).toBe('typescript');
  });

  it('falls back to plaintext on unknown extensions (no guessing)', () => {
    expect(inferLanguage('docs/README.md')).toBe('plaintext');
    expect(inferLanguage('LICENSE')).toBe('plaintext');
    expect(inferLanguage('Cargo.toml')).toBe('plaintext');
    expect(inferLanguage('')).toBe('plaintext');
  });

  it('is case-insensitive on extension', () => {
    expect(inferLanguage('Foo.TS')).toBe('typescript');
    expect(inferLanguage('Foo.PY')).toBe('python');
  });

  it('handles paths with backslashes (Windows-style) correctly', () => {
    expect(inferLanguage('C:\\workspace\\app.ts')).toBe('typescript');
  });

  it('returns plaintext for files with NO extension', () => {
    expect(inferLanguage('Makefile')).toBe('plaintext');
    expect(inferLanguage('path/to/file_no_ext')).toBe('plaintext');
  });
});

describe('highlightCode', () => {
  it('returns one output line per input line (LF input)', async () => {
    const code = 'const x = 1;\nconst y = 2;\nconst z = x + y;';
    const result = await highlightCode({
      language: 'typescript',
      theme: 'trail-dark',
      code,
    });
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]!.html).toMatch(/<span/);
    expect(result.lines[1]!.html).toMatch(/<span/);
    expect(result.lines[2]!.html).toMatch(/<span/);
  });

  it('normalises CRLF input to LF before tokenising', async () => {
    const code = 'const x = 1;\r\nconst y = 2;';
    const result = await highlightCode({
      language: 'typescript',
      theme: 'trail-dark',
      code,
    });
    // Two lines, NOT one with embedded \r\n.
    expect(result.lines).toHaveLength(2);
  });

  it('escapes HTML in source content (no raw markup injection)', async () => {
    const code = 'const evil = "<script>alert(1)</script>";';
    const result = await highlightCode({
      language: 'typescript',
      theme: 'trail-dark',
      code,
    });
    expect(result.lines[0]!.html).not.toContain('<script>');
    expect(result.lines[0]!.html).toContain('&lt;script&gt;');
  });

  it('preserves blank middle lines (no collapsing)', async () => {
    const code = 'function a() {\n\n  return 1;\n}';
    const result = await highlightCode({
      language: 'typescript',
      theme: 'trail-dark',
      code,
    });
    expect(result.lines).toHaveLength(4);
    expect(typeof result.lines[1]!.html).toBe('string');
    expect(result.lines[2]!.html).toMatch(/<span/);
  });

  it('returns plaintext language passthrough without throwing', async () => {
    const result = await highlightCode({
      language: 'plaintext',
      theme: 'trail-dark',
      code: 'no language hint here',
    });
    expect(result.lines).toHaveLength(1);
    // Plaintext still wraps in a span (theme-default color); just no
    // syntax-class spans.
    expect(typeof result.lines[0]!.html).toBe('string');
  });
});
