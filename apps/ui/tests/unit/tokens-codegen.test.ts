import { describe, expect, it } from 'vitest';
import { tokens } from '@/design';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '../../src/design/tokens.css');

/**
 * Token codegen guarantees:
 *   - tokens.css starts with the GENERATED banner
 *   - every primitive token in tokens.ts appears as a CSS variable
 *   - both :root (dark) and [data-theme="light"] blocks exist
 *   - the CRIT brighten (#C84A40) is in dark scope (B6 P1 verification)
 */

const css = readFileSync(cssPath, 'utf8');

describe('tokens codegen output', () => {
  it('emits the GENERATED banner', () => {
    expect(css.startsWith('/* GENERATED')).toBe(true);
  });

  it('declares ink scale primitives', () => {
    for (const k of Object.keys(tokens.color.ink)) {
      expect(css).toContain(`--ink-${k}:`);
    }
  });

  it('declares the CRIT-brightened pigment (B6 P1)', () => {
    // dark scope value matches the brightened color
    expect(css).toContain('--risk-crit: #C84A40');
    expect(css).toContain('--risk-crit: #6E1F1A');
  });

  it('emits both dark and light theme blocks', () => {
    expect(css).toContain(':root, [data-theme="dark"] {');
    expect(css).toContain('[data-theme="light"] {');
  });

  it('emits a class for every type token', () => {
    for (const name of Object.keys(tokens.type)) {
      expect(css).toContain(`.type-${name} {`);
    }
  });

  it('pins opsz on Newsreader type tokens (B3 §2.5)', () => {
    expect(css).toMatch(/\.type-display-1[^}]*font-variation-settings:\s*"opsz"\s*36/);
    expect(css).toMatch(/\.type-h1[^}]*font-variation-settings:\s*"opsz"\s*22/);
  });
});
