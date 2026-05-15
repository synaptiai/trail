/**
 * Vitest matcher augmentation for jest-axe's `toHaveNoViolations`.
 *
 * This file is a MODULE (top-level `import` makes it so) which is required
 * for `declare module 'vitest'` to MERGE into the existing module rather
 * than replace it. The pure ambient declaration of jest-axe lives in
 * jest-axe.d.ts.
 *
 * Per PR #6 cycle-1 review F16.
 */
import 'vitest';

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Assertion<T = unknown> {
    toHaveNoViolations: () => T;
  }
}
