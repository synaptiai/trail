/**
 * Test-only IPC mock helpers.
 *
 * The actual `vi.mock` declaration MUST live at the top of the consuming
 * test file (vitest hoists it). Pattern:
 *
 *   ```ts
 *   import { vi } from 'vitest';
 *   vi.mock('@/ipc/client', async () => {
 *     const actual = await vi.importActual<typeof import('@/ipc/client')>('@/ipc/client');
 *     const invoke = async (cmd: string, args: any) => {
 *       const { _activeMap } = await import('../_helpers/ipc-mock-state');
 *       const handler = _activeMap.map[cmd];
 *       if (!handler) throw new actual.IpcInvocationError({ kind: 'internal', message: `unmocked: ${cmd}` });
 *       return handler(args);
 *     };
 *     return { ...actual, invoke, readSettings: () => invoke('read_settings', {}), writeSettings: (p, persona) => invoke('write_settings', { partial: p, persona }) };
 *   });
 *   ```
 *
 * Then in tests, call `setIpcMock(...)` to swap handlers per-test.
 */
export { setIpcMock, _activeMap } from './ipc-mock-state';

export interface InvokeMockMap {
  [command: string]: (args?: Record<string, unknown>) => Promise<unknown>;
}
