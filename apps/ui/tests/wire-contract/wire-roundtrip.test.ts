/**
 * Wire-roundtrip contract test — gh#2 Phase 1 (Option E).
 *
 * Reads JSON snapshots emitted by the Rust IPC dispatch test
 * (`apps/ui/src-tauri/tests/ipc_dispatch_smoke.rs::dispatch_and_snapshot`)
 * and asserts the TS Zod schemas from `apps/ui/src/ipc/contract.ts`
 * accept the wire shapes the production Tauri runtime would produce.
 *
 * This closes the gap that bricked v0.1.0–v0.1.2: the Rust side serialized
 * `Option::None` as JSON `null`, the TS Zod `.optional()` rejected `null`,
 * and the sidebar never mounted. Every layer in isolation passed its own
 * tests; nothing tested the cross-language boundary. This file IS that
 * boundary test — same data path the production renderer sees.
 *
 * Snapshot lifecycle:
 *   1. `cargo test --test ipc_dispatch_smoke --locked` (in src-tauri/)
 *      runs the IPC dispatch smoke. Each test calls `dispatch_and_snapshot`
 *      which writes the response body (Ok or Err — both are JSON wire
 *      shapes the TS side must parse) to
 *      `apps/ui/test-fixtures/wire-snapshots/<command>__<scenario>.json`.
 *   2. This vitest spec reads every *.json under that directory and
 *      validates the JSON against the correct schema:
 *      - if the body has a top-level `kind` field and no `ok` discriminator,
 *        it's an `IpcError` — validated via `ipcErrorSchema`
 *      - if the command is `validate_capture_cli_path`, it's a
 *        discriminated union (`ok: 'true' | 'false'`) — validated via
 *        `validateCaptureCliPathResponseSchema`
 *      - otherwise it's a happy-path response — validated via
 *        `IPC_RESPONSE_SCHEMAS[command]`
 *   3. Failures show the exact field that didn't parse. e.g., the v0.1.2
 *      bug would show `next_cursor: Expected string, received null`.
 *
 * Snapshots are gitignored (regenerated each cargo test run); stale
 * snapshots from renamed tests can't mask drift because the Rust side
 * clears the directory on first emit per cargo invocation.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

import {
  IPC_COMMAND_SCHEMAS,
  IPC_RESPONSE_SCHEMAS,
  ipcErrorSchema,
  validateCaptureCliPathResponseSchema,
  detectCaptureCliResponseSchema,
  listClaudeSessionsResponseSchema,
  spawnPacketGenerateResponseSchema,
  cancelPacketGenerateResponseSchema,
  type IpcCommandName,
} from '../../src/ipc/contract';

// vitest runs with cwd = apps/ui (the package root)
const SNAPSHOTS_DIR = join(process.cwd(), 'test-fixtures', 'wire-snapshots');

interface ParsedSnapshot {
  filename: string;
  command: string;
  scenario: string;
  body: unknown;
}

function loadSnapshots(): ParsedSnapshot[] {
  if (!existsSync(SNAPSHOTS_DIR)) {
    throw new Error(
      `wire-snapshots dir not found at ${SNAPSHOTS_DIR}. Run \`pnpm smoke:rust\` first (or \`cargo test --test ipc_dispatch_smoke --locked\` in src-tauri/).`,
    );
  }
  const files = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    throw new Error(
      `wire-snapshots dir is empty. Run \`pnpm smoke:rust\` first.`,
    );
  }
  return files.map((f) => {
    const base = basename(f, '.json');
    // Format: <command>__<scenario>, e.g. query_trail__empty
    const sep = base.indexOf('__');
    if (sep < 0) {
      throw new Error(
        `snapshot ${f} does not match <command>__<scenario>.json — emit_snapshot in ipc_dispatch_smoke.rs uses double-underscore as separator`,
      );
    }
    return {
      filename: f,
      command: base.slice(0, sep),
      scenario: base.slice(sep + 2),
      body: JSON.parse(readFileSync(join(SNAPSHOTS_DIR, f), 'utf-8')),
    };
  });
}

/**
 * Decide which schema applies to a snapshot:
 *
 *   1. `validate_capture_cli_path` returns a discriminated union with
 *      `ok: 'true' | 'false'`. Its error branch has a `kind` field but
 *      is NOT an IpcError — handled by its own schema.
 *   2. If the body is an object with a top-level `kind` field, it's an
 *      IpcError (the handler returned `Err(IpcError::*)`).
 *   3. Otherwise the body is the command's happy-path response —
 *      validate against `IPC_RESPONSE_SCHEMAS[command]`.
 */
function parseSnapshot({ command, body }: ParsedSnapshot): {
  schema: string;
  result: { success: true } | { success: false; error: unknown };
} {
  if (command === 'validate_capture_cli_path') {
    return {
      schema: 'validateCaptureCliPathResponseSchema',
      result: validateCaptureCliPathResponseSchema.safeParse(body),
    };
  }

  // gh#17: detect_capture_cli also uses a discriminated union with a
  // top-level `kind` field. Without this branch the generic IpcError
  // path below would misroute it. Must come before the IpcError shape
  // check since detect responses ARE shaped like { kind: "..." }.
  if (command === 'detect_capture_cli') {
    return {
      schema: 'detectCaptureCliResponseSchema',
      result: detectCaptureCliResponseSchema.safeParse(body),
    };
  }

  // gh#18: list_claude_sessions uses a discriminated union with kind
  // 'ok' | 'failed'. Same routing rationale as detect_capture_cli.
  if (command === 'list_claude_sessions') {
    return {
      schema: 'listClaudeSessionsResponseSchema',
      result: listClaudeSessionsResponseSchema.safeParse(body),
    };
  }

  // gh#18 A3: spawn_packet_generate uses kind 'spawned' | 'failed';
  // cancel_packet_generate uses kind 'ok'. Both must route before the
  // generic IpcError shape check.
  if (command === 'spawn_packet_generate') {
    return {
      schema: 'spawnPacketGenerateResponseSchema',
      result: spawnPacketGenerateResponseSchema.safeParse(body),
    };
  }
  if (command === 'cancel_packet_generate') {
    return {
      schema: 'cancelPacketGenerateResponseSchema',
      result: cancelPacketGenerateResponseSchema.safeParse(body),
    };
  }

  const isErrorShape =
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    'kind' in (body as Record<string, unknown>);

  if (isErrorShape) {
    return {
      schema: 'ipcErrorSchema',
      result: ipcErrorSchema.safeParse(body),
    };
  }

  const cmdSchema = IPC_RESPONSE_SCHEMAS[command as IpcCommandName];
  if (!cmdSchema) {
    throw new Error(
      `No response schema in IPC_RESPONSE_SCHEMAS for command "${command}". Either add the schema in contract.ts or rename the snapshot prefix.`,
    );
  }
  return {
    schema: `IPC_RESPONSE_SCHEMAS["${command}"]`,
    result: cmdSchema.safeParse(body),
  };
}

describe('IPC wire-roundtrip contract', () => {
  const snapshots = loadSnapshots();

  it('snapshots directory is non-empty', () => {
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it.each(snapshots)(
    'parses $filename with the correct schema',
    (snapshot) => {
      const { schema, result } = parseSnapshot(snapshot);
      if (!result.success) {
        const error = result as { success: false; error: unknown };
        const issues =
          error.error && typeof error.error === 'object' && 'issues' in error.error
            ? JSON.stringify((error.error as { issues: unknown }).issues, null, 2)
            : String(error.error);
        throw new Error(
          `Zod ${schema} rejected snapshot ${snapshot.filename}:\n${issues}\n\nSnapshot body:\n${JSON.stringify(snapshot.body, null, 2)}`,
        );
      }
      expect(result.success).toBe(true);
    },
  );

  /**
   * Coverage drift detector — gh#2 Phase 1, P1-4.
   *
   * Every IPC command declared in `IPC_COMMAND_SCHEMAS` must have at
   * least one wire snapshot under `<command>__*.json`. If a new
   * #[tauri::command] handler ships without a corresponding dispatch
   * test in `ipc_dispatch_smoke.rs`, this check surfaces the gap before
   * the new command silently joins production with no cross-language
   * verification.
   *
   * Complements the existing TS-side `apps/ui/tests/unit/ipc-contract.test.ts`
   * (matches IPC_COMMAND_SCHEMAS keys to a literal 14-name list) and
   * the Rust-side `main.rs::ipc_handler_registration_pinned` (matches
   * generate_handler! to the same list). Those check the command
   * surface exists; this one checks the wire shape has been EXERCISED.
   */
  /**
   * PR #34 cycle-4: 5 IPC commands have their Rust dispatch tests marked
   * `#[cfg_attr(target_os = "linux", ignore)]` due to a deterministic
   * `tauri::test::MockRuntime` resource leak on ubuntu-latest CI. The
   * tests still run on macOS (developer + macOS-CI path) and emit
   * snapshots there; on Linux they're skipped so the snapshots are
   * absent. Exempt those commands from the coverage check on Linux
   * only, so the wire-roundtrip gate doesn't fail in CI.
   *
   * When tauri-upstream fixes the MockRuntime leak (or we migrate the
   * affected tests to a non-MockRuntime harness), remove the ignore
   * attrs in `ipc_dispatch_smoke.rs` and this allowlist together.
   */
  const LINUX_SKIPPED_IPC_COMMANDS: ReadonlySet<string> = new Set([
    'spawn_packet_generate',
    'subscribe_fs_watch',
    'subscribe_settings_change',
    'validate_capture_cli_path',
    'write_settings',
  ]);
  const IS_LINUX = process.platform === 'linux';

  it('every IPC command has at least one wire snapshot', () => {
    const commands = Object.keys(IPC_COMMAND_SCHEMAS);
    const snapshotPrefixes = new Set(snapshots.map((s) => s.command));
    const missing = commands.filter((cmd) => {
      if (snapshotPrefixes.has(cmd)) return false;
      if (IS_LINUX && LINUX_SKIPPED_IPC_COMMANDS.has(cmd)) return false;
      return true;
    });
    if (missing.length > 0) {
      throw new Error(
        `Missing wire snapshots for ${missing.length} IPC command(s): ${missing.join(', ')}. ` +
          `Add a dispatch test in apps/ui/src-tauri/tests/ipc_dispatch_smoke.rs that ` +
          `calls dispatch_and_snapshot() with the command name as the snapshot prefix.`,
      );
    }
    expect(missing).toEqual([]);
  });
});
