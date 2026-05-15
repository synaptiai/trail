/**
 * Module-scoped IPC mock state. Imported by `tests/unit/TrailSidebar.test.tsx`'s
 * `vi.mock('@/ipc/client')` factory, which is hoisted by vitest above the
 * `import` chain. We need a separate module so the hoist does not break the
 * map reference (factories cannot read closure variables defined later in
 * the file).
 *
 * Usage:
 *   - `setIpcMock({ query_trail: async () => ({...}) })` — install handlers
 *     for the next render.
 *   - On test exit, the `afterEach` clears handlers via `setIpcMock({})`.
 */
import type { InvokeMockMap } from './ipc-mock';

export const _activeMap: { map: InvokeMockMap } = { map: {} };

export function setIpcMock(map: InvokeMockMap) {
  _activeMap.map = map;
}
