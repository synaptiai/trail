/**
 * Storybook 8 + Vite config for @trail/ui (B3 §15.1 / gh#9 criterion 9).
 *
 * Sprint 3a wiring: discovers `*.stories.tsx` colocated under `src/` so the
 * five new packet-view foundation components ship with stories. Sprint 3b's
 * DiffHunk + tab-body integration will reuse this config; Sprint 4's modals
 * extend it with the M1-M6 matrix.
 *
 * Why local config (not vendored from main): the `.storybook/` directory was
 * deferred in Sprint 1 because the 13 primitives were over-tested in vitest +
 * playwright and Storybook was the lower-priority QA surface. Sprint 3a
 * brings it online because the packet view has compositional surfaces
 * (mode × tab × claim count × histogram shape) that benefit from visual
 * permutation review during PR cycles.
 */
import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-essentials', '@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: {} },
  docs: { autodocs: false },
  viteFinal: async (vite) => {
    // The `@/*` path alias mirrors vite.config.ts so stories can import
    // through the same paths the production code uses.
    const { fileURLToPath } = await import('node:url');
    const { resolve, dirname } = await import('node:path');
    vite.resolve = vite.resolve ?? {};
    vite.resolve.alias = {
      ...(vite.resolve.alias as Record<string, string> | undefined),
      '@': resolve(dirname(fileURLToPath(import.meta.url)), '../src'),
    };
    return vite;
  },
};

export default config;
