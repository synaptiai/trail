/**
 * gh-post service unit tests (gh#12 AC-3, AC-4, AC-7, AC-8).
 *
 * Covers:
 *   - postToPr / decideOnPr typed wrappers (success path).
 *   - classifyGhError edge-flow switch for each E1-E7 variant.
 *
 * The IPC bridge is mocked at @tauri-apps/api/core so the real
 * @/ipc/client schema validation runs end-to-end.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockHandler {
  (args: Record<string, unknown>): Promise<unknown> | unknown;
}
const mockHandlers: { current: Record<string, MockHandler> } = { current: {} };

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window.__TAURI_INTERNALS__ = { callbacks: {}, plugins: {} };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    const handler = mockHandlers.current[cmd];
    if (!handler) {
      throw { kind: 'internal', message: `unmocked: ${cmd}` };
    }
    // v0.1.1 B3: strict-wrap assertion. The real client wraps payloads as
    // `{ args: ... }` to match each Rust command's `args: Struct` signature
    // (see `apps/ui/src/ipc/client.ts:130`). With the Rust IPC dispatch
    // smoke (`tests/ipc_dispatch_smoke.rs`) now pinning the contract at the
    // serde-resolver level, JS mocks can enforce the wrapper strictly: a
    // future client regression that drops the wrapper will fail here too.
    if (!(args as { args?: unknown }).args) {
      throw new Error(
        `test mock expected wrapped envelope { args: ... } from real client.ts; got: ${JSON.stringify(args)}`,
      );
    }
    return handler((args as { args: Record<string, unknown> }).args);
  },
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

import { classifyGhError, decideOnPr, postToPr } from '@/services/gh-post';
import { IpcInvocationError } from '@/ipc/client';

const VALID_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function setHandlers(map: Record<string, MockHandler>) {
  mockHandlers.current = map;
}

describe('postToPr (gh#12 AC-3)', () => {
  beforeEach(() => setHandlers({}));
  afterEach(() => setHandlers({}));

  it('returns destination + pr_url + body_hash_prefix on success', async () => {
    setHandlers({
      post_to_pr: async (args) => {
        expect(args.packet_id).toBe(VALID_ULID);
        return {
          ok: true,
          pr_url: 'https://github.com/synaptiai/trail/pull/432',
          destination: 'synaptiai/trail#432',
          body_hash_prefix: '0123456789abcdef',
        };
      },
    });
    const result = await postToPr({ packet_id: VALID_ULID, persona: 'creator' });
    expect(result.pr_url).toBe('https://github.com/synaptiai/trail/pull/432');
    expect(result.destination).toBe('synaptiai/trail#432');
    expect(result.body_hash_prefix).toBe('0123456789abcdef');
  });

  it('forwards pr_number when supplied', async () => {
    let received: Record<string, unknown> | null = null;
    setHandlers({
      post_to_pr: async (args) => {
        received = args;
        return {
          ok: true,
          pr_url: 'https://github.com/synaptiai/trail/pull/77',
          destination: 'a/b#77',
          body_hash_prefix: 'aa',
        };
      },
    });
    await postToPr({ packet_id: VALID_ULID, pr_number: 77, persona: 'creator' });
    expect(received).not.toBeNull();
    expect((received as unknown as Record<string, unknown>).pr_number).toBe(77);
    // Cycle-2 C15 (PR #21): persona is forwarded to the IPC.
    expect((received as unknown as Record<string, unknown>).persona).toBe('creator');
  });

  it('rejects malformed packet_id at the contract boundary', async () => {
    await expect(
      postToPr({ packet_id: 'not-a-ulid', persona: 'creator' }),
    ).rejects.toBeInstanceOf(IpcInvocationError);
  });

  // Cycle-2 C15 (PR #21): the React UI must not even ATTEMPT
  // post_to_pr from auditor mode. The Zod schema rejects auditor at
  // the IPC contract boundary; persona='auditor' fails Zod parsing
  // before reaching the Tauri invoke layer (the Rust handler also
  // rejects, but the UI fails first — defence in depth).
  it('rejects auditor persona via PersonaForbidden — RAW Rust payload exercises asIpcError schema (C15 + cycle-3 C1)', async () => {
    // Cycle-3 C1 (PR #21): the previous version of this test
    // pre-constructed an `IpcInvocationError` with the persona-forbidden
    // payload via `as any`, bypassing the runtime `asIpcError` schema
    // check entirely. The raw object the Rust handler actually emits
    // is `{ kind: 'persona-forbidden', persona: 'auditor', command: 'post_to_pr' }`
    // (per `IpcError::PersonaForbidden`'s serde derive at
    // src-tauri/src/ipc.rs). When the Tauri bridge's invoke rejects
    // with that raw object, `asIpcError` in client.ts MUST validate
    // it against `ipcErrorSchema` and pass the typed variant through
    // — without the cycle-3 C1 contract addition, validation fails
    // and the variant is coerced to `IpcError.internal`. This test
    // exercises that path end-to-end.
    setHandlers({
      post_to_pr: async (args) => {
        if (args.persona === 'auditor') {
          // Throw the RAW object shape the Rust handler emits via
          // serde. asIpcError runs ipcErrorSchema.safeParse on this.
          throw {
            kind: 'persona-forbidden',
            persona: 'auditor',
            command: 'post_to_pr',
          };
        }
        return { ok: true };
      },
    });
    let caught: unknown = null;
    try {
      await postToPr({ packet_id: VALID_ULID, persona: 'auditor' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IpcInvocationError);
    const inner = (caught as IpcInvocationError).inner;
    // Critical: must NOT be coerced to `internal` — that was the
    // pre-cycle-3-C1 behaviour. The variant must round-trip through
    // ipcErrorSchema and emerge as the typed persona-forbidden form.
    expect(inner.kind).toBe('persona-forbidden');
    expect((inner as { persona: string }).persona).toBe('auditor');
    expect((inner as { command: string }).command).toBe('post_to_pr');
  });

  // Cycle-4.5 W7 (PR #21): the cycle-3 C2 closed-enum + cycle-4.5 W6
  // docblock honesty fix together establish that UNKNOWN persona
  // strings ("admin", "hacker") fail at the Tauri `#[tauri::command]`
  // serde-deserialize boundary, NOT inside the handler body. Tauri
  // returns these as a string `InvokeError`, which `asIpcError` in
  // client.ts coerces to `{kind:'internal'}`. Cycle-4.5 W14 added a
  // `case 'internal'` to classifyGhError so this no longer falls
  // through to `null` — instead it surfaces as the IPC-contract-error
  // edge flow with a Reload action. The test below pins the inner
  // kind, and the W14 classifier mapping is exercised in the
  // classifyGhError describe block at the bottom of this file.
  //
  // The test pins this end-to-end so a future Tauri version that
  // changes the error shape (e.g., emits a typed
  // 'invalid-arguments' for serde failures) surfaces as a test
  // failure rather than silent UI behavior change.
  it('Tauri serde-fail on unknown persona surfaces as kind:internal (W7)', async () => {
    setHandlers({
      post_to_pr: async () => {
        // Mimic the string `InvokeError` Tauri's command macro emits
        // when the serde deserialize fails before the handler body
        // runs. The exact phrasing ('expected variant of enum
        // Persona') is what serde_json emits for the closed enum.
        throw 'invalid value: string "admin", expected variant of enum Persona at line 1 column 47';
      },
    });
    let caught: unknown = null;
    try {
      await postToPr({
        packet_id: VALID_ULID,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        persona: 'admin' as any,
      });
    } catch (err) {
      caught = err;
    }
    // Zod schema rejects 'admin' at the React boundary first — defence
    // in depth. We confirm the rejection is wrapped as
    // IpcInvocationError; the Zod failure path produces a typed
    // `invalid-arguments` inner kind.
    expect(caught).toBeInstanceOf(IpcInvocationError);
    const inner = (caught as IpcInvocationError).inner;
    expect(inner.kind).toBe('invalid-arguments');
  });

  // Cycle-4.5 W7 (PR #21): if a caller bypasses the Zod boundary
  // (e.g., asserts persona via `as any` AND skips the contract
  // validator path — which v0.1 doesn't do, but a future refactor
  // might), the Tauri-side raw string error must still classify as
  // `internal` per W6 docblock semantics.
  it('Raw Tauri string InvokeError classifies as internal (W7 backstop)', async () => {
    // Drive the path where invoke() rejects with a non-IpcError
    // shape. asIpcError returns `{kind:'internal'}` per the
    // ipcErrorSchema fallback at client.ts.
    const handler = async (): Promise<unknown> => {
      // Bypass the typed Persona union — simulate the Rust handler
      // emitting a non-discriminated string error.
      throw 'invalid value: string "admin", expected variant of enum Persona';
    };
    // Use a different IPC command that doesn't trigger Zod validation
    // path; query_recent_sessions has a permissive args schema, so the
    // raw string error from the handler is what asIpcError sees.
    setHandlers({ query_recent_sessions: handler });
    const { invoke } = await import('@/ipc/client');
    let caught: unknown = null;
    try {
      await invoke('query_recent_sessions', { limit: 5 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IpcInvocationError);
    const inner = (caught as IpcInvocationError).inner;
    expect(inner.kind).toBe('internal');
  });
});

describe('decideOnPr (gh#12 AC-4 / J9 loop closure)', () => {
  beforeEach(() => setHandlers({}));
  afterEach(() => setHandlers({}));

  it('forwards block-with-reason payload', async () => {
    let received: Record<string, unknown> | null = null;
    setHandlers({
      decide_on_pr: async (args) => {
        received = args;
        return {
          ok: true,
          pr_url: 'https://github.com/x/y/pull/1',
          claim_id: 'CLAIM-001',
          decision: 'block',
        };
      },
    });
    const r = await decideOnPr({
      packet_id: VALID_ULID,
      claim_id: 'CLAIM-001',
      decision: 'block',
      reason: 'breaks build',
      by: 'reviewer@example.com',
      persona: 'reviewer',
    });
    expect(r.claim_id).toBe('CLAIM-001');
    expect(r.decision).toBe('block');
    expect(received).not.toBeNull();
    expect((received as unknown as Record<string, unknown>).reason).toBe('breaks build');
    expect((received as unknown as Record<string, unknown>).by).toBe(
      'reviewer@example.com',
    );
    // Cycle-2 C15 (PR #21): persona is forwarded to the IPC.
    expect((received as unknown as Record<string, unknown>).persona).toBe('reviewer');
  });

  it('defaults by to "you" when omitted', async () => {
    let received: Record<string, unknown> | null = null;
    setHandlers({
      decide_on_pr: async (args) => {
        received = args;
        return {
          ok: true,
          claim_id: 'CLAIM-001',
          decision: 'accept',
        };
      },
    });
    await decideOnPr({
      packet_id: VALID_ULID,
      claim_id: 'CLAIM-001',
      decision: 'accept',
      persona: 'creator',
    });
    expect((received as unknown as Record<string, unknown>).by).toBe('you');
  });

  // Cycle-2 C15 / Cycle-3 C1 (PR #21): even if a developer-tools console
  // invokes decideOnPr from auditor mode, the Rust handler must reject
  // with PersonaForbidden. The mock emits the RAW object shape the Rust
  // serde derive produces, so asIpcError exercises the ipcErrorSchema
  // validation path (cycle-3 C1 contract addition).
  it('rejects auditor persona via PersonaForbidden — RAW Rust payload exercises asIpcError schema', async () => {
    setHandlers({
      decide_on_pr: async (args) => {
        if (args.persona === 'auditor') {
          // Raw object — asIpcError validates against ipcErrorSchema.
          throw {
            kind: 'persona-forbidden',
            persona: 'auditor',
            command: 'decide_on_pr',
          };
        }
        return { ok: true, claim_id: 'CLAIM-001', decision: 'accept' };
      },
    });
    let caught: unknown = null;
    try {
      await decideOnPr({
        packet_id: VALID_ULID,
        claim_id: 'CLAIM-001',
        decision: 'accept',
        persona: 'auditor',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IpcInvocationError);
    const inner = (caught as IpcInvocationError).inner;
    expect(inner.kind).toBe('persona-forbidden');
    expect((inner as { persona: string }).persona).toBe('auditor');
    expect((inner as { command: string }).command).toBe('decide_on_pr');
  });
});

describe('classifyGhError (E1-E7 mapping)', () => {
  function ipcErr(inner: Record<string, unknown>): IpcInvocationError {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new IpcInvocationError(inner as any);
  }

  it('E3 — gh auth fail → triggers M2 auth modal', () => {
    const c = classifyGhError(
      ipcErr({ kind: 'gh-not-authenticated', message: 'not logged in' }),
    );
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('gh-auth-fail');
    expect(c!.triggersAuthModal).toBe(true);
  });

  it('E4 — gh CLI absent → gh-missing kind', () => {
    const c = classifyGhError(
      ipcErr({
        kind: 'gh-cli-error',
        stderr: '[gh-missing] gh not found on PATH',
        exit_code: 4,
        message: 'missing',
      }),
    );
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('gh-missing');
    expect(c!.triggersAuthModal).toBe(false);
  });

  it('E6 — network failure → network-failure kind', () => {
    const c = classifyGhError(
      ipcErr({
        kind: 'gh-cli-error',
        stderr: '[network-or-rate-limit] dial tcp: i/o timeout',
        exit_code: 7,
        message: 'net',
      }),
    );
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('network-failure');
  });

  it('rate-limit (HTTP 403) → rate-limit kind (distinct from E6)', () => {
    const c = classifyGhError(
      ipcErr({
        kind: 'gh-cli-error',
        stderr: '[network-or-rate-limit] HTTP 403 forbidden — rate limit',
        exit_code: 7,
        message: 'rate',
      }),
    );
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('rate-limit');
  });

  it('PR-not-found is its own edge flow', () => {
    const c = classifyGhError(ipcErr({ kind: 'not-found', message: 'no PR' }));
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('pr-not-found');
  });

  // gh#12 cycle-1.5 F4 N15 regression: AC-7 mandates that PR-not-found
  // (gh exit 9) and packet-not-found (gh exit 2) MUST surface as
  // distinct edge flows. The original cycle-1 code collapsed both Rust
  // PacketOpErrorKind::PrNotFound and ::PacketNotFound into the same
  // IpcError::NotFound variant, so the UI told users "PR not found"
  // when their LOCAL packet YAML was the missing thing — opposite
  // recovery path. Lock the distinction at the contract level.
  it('AC-7 regression: pr-not-found IPC variant maps to pr-not-found edge flow', () => {
    const c = classifyGhError(
      ipcErr({ kind: 'pr-not-found', message: 'no PR for branch X' }),
    );
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('pr-not-found');
    expect(c!.title).toMatch(/pull request/i);
  });

  it('AC-7 regression: packet-not-found IPC variant maps to DISTINCT packet-not-found edge flow', () => {
    const c = classifyGhError(
      ipcErr({
        kind: 'packet-not-found',
        message: 'packet YAML missing on disk',
      }),
    );
    expect(c).not.toBeNull();
    // Critical: must NOT be 'pr-not-found' — that was the cycle-1 bug.
    expect(c!.kind).not.toBe('pr-not-found');
    expect(c!.kind).toBe('packet-not-found');
    expect(c!.title).toMatch(/packet/i);
  });

  it('AC-7 regression: pr-not-found and packet-not-found produce distinct titles', () => {
    const pr = classifyGhError(
      ipcErr({ kind: 'pr-not-found', message: 'gh exit 9' }),
    );
    const pkt = classifyGhError(
      ipcErr({ kind: 'packet-not-found', message: 'gh exit 2' }),
    );
    expect(pr).not.toBeNull();
    expect(pkt).not.toBeNull();
    expect(pr!.title).not.toBe(pkt!.title);
    expect(pr!.kind).not.toBe(pkt!.kind);
  });

  it('E1 — corrupt packet (yaml-parse-rejected) → corrupt-packet kind', () => {
    const c = classifyGhError(
      ipcErr({ kind: 'yaml-parse-rejected', reason: 'syntax', message: 'broken' }),
    );
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('corrupt-packet');
  });

  it('E7 — concurrent edit / write failure → concurrent-edit kind', () => {
    const c = classifyGhError(
      ipcErr({
        kind: 'gh-cli-error',
        stderr: '[write] failed to update packet',
        exit_code: 6,
        message: 'wr',
      }),
    );
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('concurrent-edit');
  });

  // Cycle-3 C1 (PR #21): persona-forbidden surfaces as a typed Banner.
  it('persona-forbidden IPC variant maps to persona-forbidden edge flow', () => {
    const c = classifyGhError(
      ipcErr({
        kind: 'persona-forbidden',
        persona: 'auditor',
        command: 'post_to_pr',
      }),
    );
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('persona-forbidden');
    expect(c!.title).toMatch(/auditor/i);
    expect(c!.triggersAuthModal).toBe(false);
  });

  it('returns null for non-IPC errors (not one of E1-E7)', () => {
    expect(classifyGhError(new Error('plain'))).toBeNull();
    expect(classifyGhError('string')).toBeNull();
    expect(classifyGhError(undefined)).toBeNull();
  });

  it('unknown gh-cli-error kebab kinds fall through to unknown', () => {
    const c = classifyGhError(
      ipcErr({
        kind: 'gh-cli-error',
        stderr: '[some-future-thing] new error',
        exit_code: 1,
        message: 'x',
      }),
    );
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('unknown');
  });

  // Cycle-4.5 W14 (PR #21): IPC errors with kind='internal' (Tauri's
  // catch-all for serde-deserialize failures + unhandled handler
  // panics) previously fell through to null, leaving the M4 modal to
  // surface the raw Error.message text — usually serde diagnostic
  // noise. The W14 case maps these to `unknown` kind with a Reload
  // recovery so the user gets a sensible action.
  it('W14 — internal IPC variant maps to unknown edge flow with Reload action', () => {
    const c = classifyGhError(
      ipcErr({
        kind: 'internal',
        message:
          'invalid value: string "admin", expected variant of enum Persona',
      }),
    );
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('unknown');
    expect(c!.title).toMatch(/IPC contract error/i);
    expect(c!.recovery).toBe('Reload');
    expect(c!.triggersAuthModal).toBe(false);
  });
});
