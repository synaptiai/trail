import '@testing-library/jest-dom/vitest';
import { expect } from 'vitest';
// jest-axe ships CommonJS; vitest happy-dom can require it via dynamic interop.
// We register the toHaveNoViolations matcher globally so individual tests can
// `expect(await axe(container)).toHaveNoViolations()` without a per-file dance.
// jest-axe@9 has no shipped .d.ts so we cast through unknown to satisfy
// vitest's `expect.extend` matcher-object signature; the augmentation in
// `jest-axe-matchers.d.ts` provides the typed assertion at call sites.
import { toHaveNoViolations } from 'jest-axe';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
expect.extend(toHaveNoViolations as any);
