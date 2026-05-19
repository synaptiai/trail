/**
 * IPC client — typed Tauri invoke wrapper.
 *
 * Validates arguments with the zod schemas in contract.ts before crossing the
 * Rust boundary so a JS programming error surfaces as a `IpcError.invalid-arguments`
 * BEFORE it reaches the Rust handler. The Rust handler re-validates (defense
 * in depth); both layers must reject malformed args.
 *
 * The browser-only fallback path (Storybook, unit tests) raises
 * `ipc-not-available`; tests should mock the relevant function via the
 * provider in `tests/_helpers/ipc-mock.ts`.
 */
import {
  IPC_COMMAND_SCHEMAS,
  IPC_RESPONSE_SCHEMAS,
  type IpcCommandName,
  type IpcEvent,
  type IpcEventName,
  type IpcError,
  ipcErrorSchema,
  type Settings,
  type ValidateCaptureCliPathResponse,
  type DetectCaptureCliResponse,
} from './contract.js';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>;

interface TauriBridge {
  invoke: Invoke;
  listen: Listen;
}

let bridgePromise: Promise<TauriBridge | null> | null = null;

async function getBridge(): Promise<TauriBridge | null> {
  if (bridgePromise) return bridgePromise;
  bridgePromise = (async () => {
    if (typeof window === 'undefined') return null;
    const tauriInternals = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
    if (!tauriInternals) return null;
    const [{ invoke }, { listen }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ]);
    return { invoke, listen: listen as Listen };
  })();
  return bridgePromise;
}

export class IpcUnavailableError extends Error {
  constructor() {
    super('Tauri IPC bridge not available — running outside the desktop shell');
  }
}

export class IpcInvocationError extends Error {
  readonly inner: IpcError;
  constructor(error: IpcError) {
    // Cycle-3 C1 (PR #21): the persona-forbidden variant has no
    // `message` field — its payload is `{ persona, command }`. Synthesise
    // a human-readable message for it so `Error.message` is non-empty
    // and existing callers that read `err.message` see the same shape
    // they did pre-cycle-3.
    super(ipcErrorMessage(error));
    this.inner = error;
  }
}

/**
 * Render an `IpcError` to a single-line human-readable message. For
 * variants with a `message` field we use it directly; for the
 * persona-forbidden variant we synthesise from the persona + command
 * fields.
 */
function ipcErrorMessage(error: IpcError): string {
  if (error.kind === 'persona-forbidden') {
    return `persona ${error.persona} cannot invoke ${error.command}`;
  }
  return error.message;
}

// Cycle-2 N27 fix: validate the backend's error payload at runtime using
// the closed-enum zod schema. A Rust handler that mistakenly serializes
// an unknown `kind` (or omits a required field) is now coerced to
// `IpcError.internal` with diagnostic message rather than silently
// consumed as the wrong variant.
function asIpcError(value: unknown): IpcError {
  const validated = ipcErrorSchema.safeParse(value);
  if (validated.success) return validated.data;
  if (typeof value === 'string') {
    return { kind: 'internal', message: value };
  }
  if (value instanceof Error) {
    return { kind: 'internal', message: value.message };
  }
  return {
    kind: 'internal',
    message: 'unknown IPC error (failed runtime schema validation)',
  };
}

export async function invoke<R = unknown>(
  command: IpcCommandName,
  args: Record<string, unknown> = {},
): Promise<R> {
  const schema = IPC_COMMAND_SCHEMAS[command];
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new IpcInvocationError({
      kind: 'invalid-arguments',
      field: first?.path.join('.') ?? '<unknown>',
      message: first?.message ?? 'invalid arguments',
    });
  }
  const bridge = await getBridge();
  if (!bridge) throw new IpcUnavailableError();
  let raw: unknown;
  try {
    // Every Rust command in src-tauri/src/ipc.rs takes a single named
    // parameter `args: SomeStruct`. Tauri 2's serde-driven argument resolver
    // expects the JS payload to be `{ args: <SomeStruct> }` — the outer
    // object's keys map to parameter names. Passing `parsed.data` directly
    // produces "missing required key args" at runtime for every command.
    // (Tauri's mock_runtime under the `test` feature has looser resolution
    // and accepted the flat shape — that's how this shipped in v0.1.0.)
    raw = await bridge.invoke(command, { args: parsed.data });
  } catch (err) {
    throw new IpcInvocationError(asIpcError(err));
  }
  // Per PR #6 cycle-1 review F19 (P3 security defense-in-depth):
  // Validate the backend's response when a schema is declared so a Rust
  // handler returning a malformed payload surfaces as an explicit
  // `IpcError.internal` rather than being silently consumed as the wrong
  // type. Commands without a declared response schema skip validation.
  const responseSchema = IPC_RESPONSE_SCHEMAS[command];
  if (responseSchema) {
    const validated = responseSchema.safeParse(raw);
    if (!validated.success) {
      const first = validated.error.issues[0];
      throw new IpcInvocationError({
        kind: 'internal',
        message: `backend returned malformed response for ${command}: ${
          first?.message ?? 'schema mismatch'
        } at ${first?.path.join('.') ?? '<root>'}`,
      });
    }
    return validated.data as R;
  }
  return raw as R;
}

type EventPayload<E extends IpcEventName> = Extract<IpcEvent, { name: E }>['payload'];

export async function listen<E extends IpcEventName>(
  event: E,
  handler: (payload: EventPayload<E>) => void,
): Promise<() => void> {
  const bridge = await getBridge();
  if (!bridge) throw new IpcUnavailableError();
  return bridge.listen<EventPayload<E>>(event, (e: { payload: EventPayload<E> }) =>
    handler(e.payload),
  );
}

// Convenience accessors — typed wrappers for the most-called commands ----

export async function readSettings(): Promise<Settings> {
  // F19: invoke() already validates the response against settingsSchema via
  // IPC_RESPONSE_SCHEMAS, so no double-parse here. The cast is safe.
  return invoke<Settings>('read_settings', {});
}

/**
 * Cycle-4.5 W1 (PR #21): persona threading is now mandatory at the IPC
 * boundary. The Rust handler rejects auditor with PersonaForbidden;
 * callers (M6SettingsModal, recent-sessions pinning) must source the
 * active persona from the App-level state and forward it. The previous
 * single-arg signature accepted a `Partial<Settings>` only and silently
 * sent NO persona — the Rust handler had no gate either, so the
 * defence-in-depth was completely missing.
 */
export async function writeSettings(
  partial: Partial<Settings>,
  persona: import('./contract').Persona,
): Promise<void> {
  await invoke<{ ok: true }>('write_settings', { partial, persona });
}

/**
 * Probe the user-supplied capture CLI path via the `cli_bridge` Rust
 * subprocess wrapper (Sprint 4 cycle-1.5 F3 fix; gh#11 criterion 11). The
 * Rust handler spawns the binary with `--version` argv and a 30s timeout;
 * the discriminated-union result distinguishes success (with version
 * string) from probe failure (with stable kebab-case `kind`). The IPC
 * client validates the response against the contract schema, so a Rust
 * regression that drops a field surfaces as `IpcError.internal`.
 */
export async function validateCaptureCliPath(
  path: string,
): Promise<ValidateCaptureCliPathResponse> {
  return invoke<ValidateCaptureCliPathResponse>('validate_capture_cli_path', { path });
}

/**
 * Auto-detect the `trail` CLI binary on this machine (gh#17). Probes
 * the login shell, well-known npm install paths, and the marker file
 * in order. Returns a discriminated union: `detected` carries the
 * resolved path + version; `failed` carries a classified failure_kind
 * and user-actionable suggested_fix. The Rust handler reserves the
 * IPC error channel for true system errors, so "no trail found" is
 * a routine response the UI renders inline.
 *
 * Called from the M6 Settings → Capture "Detect" button and from
 * FirstRun on first launch.
 */
export async function detectCaptureCli(): Promise<DetectCaptureCliResponse> {
  return invoke<DetectCaptureCliResponse>('detect_capture_cli', {});
}
