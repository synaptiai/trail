/**
 * Watcher events — frontend subscriptions for backend filesystem events.
 *
 * Sprint 4 (gh#11 criterion 4): wires the J12 tamper-banner to the
 * `packet-changed-externally` event the Rust watcher emits when a
 * filesystem change does NOT match a saga-in-flight write AND the
 * approval_trail hash differs from libSQL's `last_known_hash`.
 *
 * Three event surfaces (B5 §6.1):
 *
 *   packet-changed             — open packet's YAML changed; reload it
 *   packet-changed-externally  — J12 path; show tamper banner
 *   trail-needs-refresh        — sidebar refresh; non-blocking
 *
 * `subscribeFsWatch()` is the consumer-side single entry point: a React
 * component calls it once on mount, the hook returns an unsubscribe
 * thunk, and the component installs the relevant React state updaters
 * via the supplied callbacks.
 */
import { IpcUnavailableError, listen } from '@/ipc/client';
import type { MismatchType } from '@/ipc/contract';

export interface ExternalChangePayload {
  /**
   * `packet_id` is nullable as of v0.1.1 B6 — see the wire-shape
   * comment on `IpcEvent['packet-changed-externally']` in
   * `@/ipc/contract`. The PacketView per-packet J12 filter
   * (`payload.packet_id === packetId`) correctly drops null
   * mismatches; a future global "unparseable-file" banner can listen
   * here and surface null events at app scope.
   */
  packet_id: string | null;
  mismatch_type: MismatchType;
  message?: string;
}

export interface FsWatchCallbacks {
  /** Open packet's hash matches libSQL — but watcher saw a change. UI may want to reload yaml_text. */
  onPacketChanged?: (payload: { packet_id: string }) => void;
  /** Hash mismatch / parse-error / missing — surface J12. */
  onPacketChangedExternally?: (payload: ExternalChangePayload) => void;
  /** Trail browser should re-query libSQL. */
  onTrailNeedsRefresh?: () => void;
}

/**
 * Subscribe to the watcher's three event surfaces. Returns a thunk that
 * unsubscribes ALL three when called. Caller MUST call the thunk on
 * unmount or the listeners leak.
 *
 * Errors during subscription (e.g., Tauri bridge unavailable in
 * Storybook) are swallowed and logged at warn level — the surface
 * degrades gracefully to "watcher events do not flow."
 */
export async function subscribeFsWatch(
  callbacks: FsWatchCallbacks,
): Promise<() => void> {
  const unsubs: Array<() => void> = [];
  try {
    if (callbacks.onPacketChanged) {
      const cb = callbacks.onPacketChanged;
      unsubs.push(await listen('packet-changed', (payload) => cb(payload)));
    }
    if (callbacks.onPacketChangedExternally) {
      const cb = callbacks.onPacketChangedExternally;
      unsubs.push(
        await listen('packet-changed-externally', (payload) => {
          // Tauri payloads are typed via the contract; widen `mismatch_type`
          // because the contract enumerates closed variants.
          cb(payload as ExternalChangePayload);
        }),
      );
    }
    if (callbacks.onTrailNeedsRefresh) {
      const cb = callbacks.onTrailNeedsRefresh;
      unsubs.push(await listen('trail-needs-refresh', () => cb()));
    }
  } catch (err) {
    // Tauri bridge unavailable (Storybook, jsdom/happy-dom test env, web
    // preview) is the expected non-desktop case — log at debug level so
    // CI test logs don't drown in IpcUnavailableError noise. Real,
    // unexpected subscription failures still surface as console.error.
    //
    // Cycle-3 C3-S-EH-2: the prior implementation tested via
    // `err.constructor?.name === 'IpcUnavailableError'`. The class name
    // gets mangled (`t`, `a`, etc.) by Vite's production minifier, so the
    // brand-string match would silently fall through to the error branch
    // and flood real users' consoles with expected-absence noise. Switch
    // to `instanceof` over the imported class — survives minification
    // because the reference is symbolic, not string-keyed.
    if (err instanceof IpcUnavailableError) {
      console.debug('[Trail] watcher subscription unavailable (non-desktop env):', err);
    } else {
      console.error('[Trail] watcher subscription failed:', err);
    }
  }
  return () => {
    for (const u of unsubs) {
      // Cycle-3 C3-S-EH-3: the unsubscribe signature widens to
      // `() => void` in the Tauri contract, but if a future variant
      // returns a thenable, an unhandled rejection at unmount time would
      // surface as a console error or worse (DevTools "unhandled promise
      // rejection" banner). Wrap with Promise.resolve().catch so async
      // disposers settle silently. Synchronous throws still hit the
      // catch block as today.
      try {
        Promise.resolve(u()).catch(() => {
          // already torn down — swallow
        });
      } catch {
        // synchronous throw — already torn down
      }
    }
  };
}
