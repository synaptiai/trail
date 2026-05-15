// [F11 / 2026-05-09] Transcript reader CRLF + edge-case coverage.
//
// Cycle-1 review flagged a concern that `readTranscriptSync` splits on `\n`
// without stripping `\r`, so Windows transcripts (CRLF) would be silently
// dropped via the `// ignore malformed JSON` catch. Inspection shows the
// implementation calls `line.trim()` BEFORE `JSON.parse`, which removes
// trailing `\r`. This test pins that contract so a regression in the trim
// step would surface immediately.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readTranscript, readTranscriptSync } from "../src/transcript/reader.js";

describe("transcript reader — F11 CRLF + malformed-line handling", () => {
  test("readTranscriptSync handles CRLF (Windows) line endings", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-tr-"));
    const path = join(dir, "crlf.jsonl");
    // Hand-crafted CRLF content: each line terminated by \r\n.
    const content = '{"a":1}\r\n{"b":2}\r\n{"c":3}\r\n';
    writeFileSync(path, content, { encoding: "utf-8" });

    const records = readTranscriptSync(path);
    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({ a: 1 });
    expect(records[1]).toEqual({ b: 2 });
    expect(records[2]).toEqual({ c: 3 });
  });

  test("readTranscriptSync handles LF (POSIX) line endings", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-tr-"));
    const path = join(dir, "lf.jsonl");
    writeFileSync(path, '{"a":1}\n{"b":2}\n', { encoding: "utf-8" });

    const records = readTranscriptSync(path);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ a: 1 });
  });

  test("readTranscriptSync skips truly malformed JSON lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-tr-"));
    const path = join(dir, "mixed.jsonl");
    writeFileSync(path, '{"a":1}\nnot-json-at-all\n{"b":2}\n{incomplete\n{"c":3}\n', {
      encoding: "utf-8",
    });

    const records = readTranscriptSync(path);
    // 3 valid out of 5 lines; 2 malformed silently skipped.
    expect(records).toHaveLength(3);
    expect(records.map((r) => Object.keys(r)[0])).toEqual(["a", "b", "c"]);
  });

  test("readTranscriptSync skips empty lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-tr-"));
    const path = join(dir, "empties.jsonl");
    writeFileSync(path, '\n{"a":1}\n\n\n{"b":2}\n\n', { encoding: "utf-8" });

    const records = readTranscriptSync(path);
    expect(records).toHaveLength(2);
  });

  test("readTranscript (async) handles CRLF (matches sync behavior)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-tr-"));
    const path = join(dir, "async-crlf.jsonl");
    writeFileSync(path, '{"a":1}\r\n{"b":2}\r\n', { encoding: "utf-8" });

    const records = await readTranscript(path);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ a: 1 });
  });
});
