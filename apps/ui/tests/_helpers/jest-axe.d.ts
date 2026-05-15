/**
 * jest-axe ambient module declaration.
 *
 * The published jest-axe@9 package ships index.js with no .d.ts. This file
 * is INTENTIONALLY a script (no top-level imports/exports) so the
 * `declare module 'jest-axe'` block is ambient and applies globally.
 * Vitest matcher augmentation lives in jest-axe-matchers.d.ts (a module
 * file that uses `import 'vitest'` to merge into the existing module).
 * Per PR #6 cycle-1 review F16.
 */

declare module 'jest-axe' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type AxeResults = any;

  export function axe(
    container: Element | Document | DocumentFragment,
    options?: Record<string, unknown>,
  ): Promise<AxeResults>;

  export function configureAxe(
    options?: Record<string, unknown>,
  ): typeof axe;

  export const toHaveNoViolations: Record<string, unknown>;
}
