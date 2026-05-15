/**
 * ESLint v9 flat config for @trail/ui.
 *
 * Phase 2 contract (B3 §15.1 step 6 / B5 §5.1.1):
 *   - Raw hex (#XXXXXX) outside `src/design/tokens.ts`         → ERROR
 *   - Raw px (`24px`) outside `src/design/tokens.ts`           → ERROR
 *   - The codegen output `src/design/tokens.css` is allowlisted because it
 *     IS the emission target for the typed token map.
 *
 * Two-file enforcement:
 *   1. THIS FILE scans `src/**\/*.{ts,tsx}` (literals + template-strings).
 *   2. `scripts/lint-css-tokens.mjs` scans every `src/**\/*.css` (the
 *      "plain regex over CSS source files" the spec calls for).
 *   The `lint` npm script chains both so a single command covers all surfaces.
 *
 * Per PR #6 cycle-1 review F1 (P1 tooling-correctness, consensus HIGH).
 */
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

const ALLOWLISTED_FILES = new Set(['src/design/tokens.ts', 'src/design/tokens.css']);

// Cycle-2 N8 fix: only match VALID CSS color-hash lengths (3, 4, 6, 8); the
// previous `{3,8}` also matched 5/7 which aren't valid CSS hex colors.
const RAW_HEX_PATTERN = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
// Cycle-2 N9 fix: include leading `-` so `'-14px'` literals are flagged.
const RAW_PX_PATTERN = /(?:^|[^a-zA-Z0-9_])(-?\d+(?:\.\d+)?)px\b/g;

/** Custom flat rule: no raw design values. */
const noRawDesignValues = {
  meta: {
    type: 'problem',
    docs: { description: 'forbid raw hex / px outside the token source-of-truth' },
    schema: [],
    messages: {
      rawHex: 'raw hex literal "{{value}}" — use a CSS variable from tokens.css',
      rawPx: 'raw {{value}}px — use a --space-*/--size-* token from tokens.ts',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (!filename) return {};
    const relative = filename.replace(/\\/g, '/').split('/apps/ui/').pop() ?? filename;
    if (ALLOWLISTED_FILES.has(relative)) return {};
    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        const matches = [...String(node.value).matchAll(RAW_HEX_PATTERN)];
        for (const m of matches) {
          context.report({ node, messageId: 'rawHex', data: { value: m[0] } });
        }
        const px = [...String(node.value).matchAll(RAW_PX_PATTERN)];
        for (const m of px) {
          context.report({ node, messageId: 'rawPx', data: { value: m[1] } });
        }
      },
      TemplateElement(node) {
        const raw = node.value?.raw ?? '';
        if (!raw) return;
        for (const m of raw.matchAll(RAW_HEX_PATTERN)) {
          context.report({ node, messageId: 'rawHex', data: { value: m[0] } });
        }
        for (const m of raw.matchAll(RAW_PX_PATTERN)) {
          context.report({ node, messageId: 'rawPx', data: { value: m[1] } });
        }
      },
    };
  },
};

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        URLSearchParams: 'readonly',
        URL: 'readonly',
        crypto: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Promise: 'readonly',
        HTMLElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLUListElement: 'readonly',
        Element: 'readonly',
        SVGElement: 'readonly',
        Node: 'readonly',
        Notification: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        // Sprint 3b (gh#10): perf harness uses requestAnimationFrame for
        // post-paint measurement, and `performance.now()` for sub-ms
        // timestamps — both standard DOM globals (lib: ["DOM"]).
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        performance: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        // CSS — global object exposing CSS.escape() per CSSOM spec.
        CSS: 'readonly',
        // Sprint 3a (gh#9): packet-loader's dev fixture-fallback path uses
        // browser fetch. Tests use the global Response type via `as Response`
        // when stubbing fetch via vi.spyOn — these are standard DOM lib types
        // surfaced as globals by `lib: ["DOM"]` in tsconfig.base.json.
        fetch: 'readonly',
        Response: 'readonly',
        React: 'readonly',
      },
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
      tokens: { rules: { 'no-raw-design-values': noRawDesignValues } },
    },
    rules: {
      'tokens/no-raw-design-values': 'error',
      'react/jsx-uses-react': 'off',
      'react/jsx-uses-vars': 'error',
      'react/react-in-jsx-scope': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': 'off',
    },
    settings: { react: { version: 'detect' } },
  },
  {
    files: ['tests/**/*.{ts,tsx}', 'scripts/**/*.{mjs,ts}', 'eslint.config.mjs'],
    rules: { 'tokens/no-raw-design-values': 'off' },
  },
  {
    ignores: ['dist', 'storybook-static', 'src-tauri/target', 'src/design/tokens.css'],
  },
];
