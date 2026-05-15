// [F7 / 2026-05-09] Storage best-effort fallback path coverage.
// [F21 / 2026-05-09] Cycle-2 refinement: replace shallow contract test
//   with a real end-to-end run of generate() that drives a failing
//   StorageWriter through the production catch-block. The previous
//   contract test asserted only that the error type and message
//   formatting were correct; it never invoked generate(), so a refactor
//   that dropped the try/catch or changed the format string would not
//   have failed the test.
//
// SqliteStorageWriter.create() throws StorageUnavailableError when
// better-sqlite3 is missing OR fails to load (e.g., Node version without
// prebuilt binaries — this happens on Node 26 dev environments). The
// caller (programmatic generate() user) is expected to swallow the
// error and fall back to NoopStorageWriter; generate.ts emits a
// single-line stderr note (`note: storage write failed (best-effort):
// ...`) and returns exitCode 0 (best-effort tolerates DB failure).
//
// This test wires a fake transcript fixture, passes a storageWriter
// that throws StorageUnavailableError from writePacket, runs generate()
// end-to-end, and asserts the documented format hits stderr while
// exitCode stays 0. Pattern mirrors generate-integration.test.ts.

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { generate } from "../src/generate.js";
import { NoopStorageWriter } from "../src/storage/noop.js";
import { StorageUnavailableError } from "../src/storage/sqlite.js";
import type { StorageWriter } from "../src/storage/types.js";

const SESSION_ID = "18e374b5-4eb9-424d-a3ff-a639d1c6fada";
const TRANSCRIPT_PATH = join(
  homedir(),
  ".claude",
  "projects",
  "-Users-danielbentes-trail",
  `${SESSION_ID}.jsonl`
);

const transcriptAvailable = existsSync(TRANSCRIPT_PATH);

describe.runIf(transcriptAvailable)("storage best-effort fallback (F7 / F21 e2e)", () => {
  test("StorageUnavailableError thrown by writer is caught by generate(); fallback emits documented stderr note + exit 0", async () => {
    // Set up a real transcript-backed run targeting a fresh session
    // workspace, exactly like generate-integration.test.ts. The only
    // delta from a vanilla success run is the injected failing
    // storageWriter and `noStorage: false` so the storage block runs.
    const cwd = mkdtempSync(join(tmpdir(), "trail-storage-fallback-"));
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd });
    execSync("git config user.email test@example.com", { cwd });
    execSync("git config user.name test", { cwd });
    writeFileSync(join(cwd, ".gitignore"), ".trail/\n");

    const sessionDir = join(cwd, ".trail", "sessions", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });

    // Fake writer modeling a Node-version-without-prebuilt-binary failure:
    // create() succeeded (the writer is constructed) but writePacket
    // throws at first use because the binary isn't loadable. The error
    // type and message shape mirror the real SqliteStorageWriter.create()
    // failure that the F7 fix is designed to handle.
    let writePacketCalled = 0;
    let closeCalled = 0;
    const failingWriter: StorageWriter = {
      writePacket: async () => {
        writePacketCalled += 1;
        throw new StorageUnavailableError(
          "better-sqlite3 prebuilt binary missing (NODE_MODULE_VERSION mismatch)"
        );
      },
      close: () => {
        closeCalled += 1;
      },
    };

    // Capture stderr writes. quiet:false is required for stderr() to
    // pass through (per generate.ts:73-76). Without it, the note is
    // swallowed at the helper layer and the user sees nothing.
    //
    // Direct monkey-patch because vi.spyOn(process.stderr, "write")
    // produced an empty mock.calls array under vitest 2.1.9 + threads
    // pool — possibly because vitest installs its own write tap on
    // process.stderr at module load that captures the same property
    // accessor before the spy lands. The direct patch bypasses any
    // such tap and captures every Buffer/string write the runtime
    // attempts during this test.
    // [F27 / 2026-05-09] try/finally restore: if any expect() between
    // the patch and the manual restore throws, the original stderr.write
    // would leak into subsequent tests (and the patched closure would
    // hold a stale writeCalls reference). The finally block ensures
    // restoration happens unconditionally on the failure path too.
    const writeCalls: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      writeCalls.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await generate({
        sessionId: SESSION_ID,
        cwd,
        noLlm: true,
        llmModel: "haiku",
        llmBudgetUsd: 0.5,
        llmTimeoutSeconds: 120,
        perDiff: false,
        format: "yaml",
        strictRedaction: false,
        strictLlm: false,
        dryRun: false,
        noStorage: false, // F21 e2e: storage block MUST run for fallback to fire
        quiet: false, // stderr() requires non-quiet to write the note
        transcriptPath: TRANSCRIPT_PATH,
        packetId: "01F21F21F21F21F21F21F21F21",
        generatedAt: "2026-05-09T03:05:20.148537+00:00",
        storageWriter: failingWriter,
      });

      // F21 contract A: writer was actually invoked end-to-end through
      // generate(), proving the storage block runs.
      expect(writePacketCalled).toBe(1);

      // F21 contract B: fallback tolerates the failure — exit 0, packet
      // file still landed on disk via atomic write.
      expect(result.exitCode).toBe(0);
      expect(result.yamlPath).toBe(join(sessionDir, "packet-1.yml"));
      expect(existsSync(result.yamlPath!)).toBe(true);

      // F21 contract C: the documented stderr format ("note: storage
      // write failed (best-effort): <msg>") was emitted exactly once with
      // the underlying error message preserved verbatim.
      const expectedPrefix = "note: storage write failed (best-effort):";
      const matchedNotes = writeCalls.filter((m) => m.startsWith(expectedPrefix));
      expect(matchedNotes.length, `stderr writes seen: ${JSON.stringify(writeCalls)}`).toBe(1);
      expect(matchedNotes[0]).toContain(
        "better-sqlite3 prebuilt binary missing (NODE_MODULE_VERSION mismatch)"
      );
      // Tail newline must be present so log readers see one note per line.
      expect(matchedNotes[0]).toMatch(/\n$/);

      // Sanity: the failing writer's close() was NOT called by generate
      // (the storage block doesn't manage close in the best-effort path —
      // the producer owns lifecycle). This pins the contract so future
      // changes to close-handling are intentional.
      expect(closeCalled).toBe(0);
    } finally {
      process.stderr.write = origWrite as typeof process.stderr.write;
    }
  }, 60_000);

  test("non-StorageUnavailableError throw is also caught with the same stderr format", async () => {
    // F7 catch is `try { ... } catch (err) { ... (err as Error).message }`,
    // so it tolerates any throw, not just StorageUnavailableError. This
    // test pins that contract so a future narrowed catch (e.g.,
    // `catch (err) if (err instanceof StorageUnavailableError)`) would
    // fail loudly rather than silently re-throw.
    const cwd = mkdtempSync(join(tmpdir(), "trail-storage-fallback-"));
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd });
    execSync("git config user.email test@example.com", { cwd });
    execSync("git config user.name test", { cwd });
    writeFileSync(join(cwd, ".gitignore"), ".trail/\n");

    const sessionDir = join(cwd, ".trail", "sessions", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });

    const failingWriter: StorageWriter = {
      writePacket: async () => {
        throw new Error("disk full");
      },
      close: () => {},
    };

    // Direct monkey-patch — see fallback test above for rationale.
    // [F27 / 2026-05-09] try/finally restore — see fallback test above.
    const writeCalls: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      writeCalls.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await generate({
        sessionId: SESSION_ID,
        cwd,
        noLlm: true,
        llmModel: "haiku",
        llmBudgetUsd: 0.5,
        llmTimeoutSeconds: 120,
        perDiff: false,
        format: "yaml",
        strictRedaction: false,
        strictLlm: false,
        dryRun: false,
        noStorage: false,
        quiet: false,
        transcriptPath: TRANSCRIPT_PATH,
        packetId: "01F21F21F21F21F21F21F21F22",
        generatedAt: "2026-05-09T03:05:20.148537+00:00",
        storageWriter: failingWriter,
      });

      expect(result.exitCode).toBe(0);
      const matchedNotes = writeCalls.filter((m) =>
        m.startsWith("note: storage write failed (best-effort):")
      );
      expect(matchedNotes.length, `stderr writes seen: ${JSON.stringify(writeCalls)}`).toBe(1);
      expect(matchedNotes[0]).toContain("disk full");
    } finally {
      process.stderr.write = origWrite as typeof process.stderr.write;
    }
  }, 60_000);

  test("NoopStorageWriter is the default when no writer is supplied (regression guard)", async () => {
    // Smoke: NoopStorageWriter swallows writes and never throws. Pinned
    // because generate.ts:339 falls back to it when opts.storageWriter
    // is undefined.
    const noop = new NoopStorageWriter();
    await expect(
      noop.writePacket(
        { _meta: { packet_id: "x" } } as never,
        { pattern_set_version: "0.0.0", pattern_set_origin: "bundled" } as never,
        [],
        []
      )
    ).resolves.toBeUndefined();
  });
});
