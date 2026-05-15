// Extraction edge cases (criteria 19, 20, 21, 23, 24, 26).

import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.js";
import { Redactor } from "../src/redaction/layer1.js";
import { loadPatterns } from "../src/redaction/patterns.js";

const TEST_RE = /\b(npm\s+test|pytest)\b/i;

function makeRedactor() {
  return new Redactor(loadPatterns(undefined, { useCache: false }).patterns);
}

describe("extract — pure unit", () => {
  test("strips XML tags but preserves content between them (matches py-reference)", () => {
    const records = [
      {
        type: "user",
        message: { content: "<x>tag</x>real text" },
      },
    ];
    const data = extract(records, {
      redactor: makeRedactor(),
      testCommandRe: TEST_RE,
      repoRoot: "/r",
    });
    expect(data.prompts).toHaveLength(1);
    // py-reference's regex is `<[^>]+>` (greedy single tags only) — content
    // between tags is preserved, only the tag delimiters are stripped.
    expect(data.prompts[0]!.text).toBe("tagreal text");
  });

  test("skips empty user messages (after tag-strip)", () => {
    const records = [{ type: "user", message: { content: "<x></x>" } }];
    const data = extract(records, {
      redactor: makeRedactor(),
      testCommandRe: TEST_RE,
      repoRoot: "/r",
    });
    expect(data.prompts).toHaveLength(0);
  });

  test("Bash → CMD-NNN; tests detected via regex", () => {
    const records = [
      {
        type: "assistant",
        message: {
          model: "haiku",
          content: [{ type: "tool_use", name: "Bash", id: "tu-1", input: { command: "npm test" } }],
        },
      },
    ];
    const data = extract(records, {
      redactor: makeRedactor(),
      testCommandRe: TEST_RE,
      repoRoot: "/r",
    });
    expect(data.commands).toHaveLength(1);
    expect(data.tests).toHaveLength(1);
    expect(data.tests[0]!.cmd_ref).toBe("CMD-001");
  });

  test("test_evidence.passed[].ref redacted (criterion 26)", () => {
    const records = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              id: "tu-1",
              input: { command: "npm test -- --token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
            },
          ],
        },
      },
    ];
    const data = extract(records, {
      redactor: makeRedactor(),
      testCommandRe: TEST_RE,
      repoRoot: "/r",
    });
    expect(data.tests[0]!.ref).toContain("[REDACTED:github-token]");
    expect(data.tests[0]!.ref).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  test("MultiEdit cap at 5 hunks, drop counter incremented (criterion 20)", () => {
    const records = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "MultiEdit",
              id: "tu-1",
              input: {
                file_path: "/r/x.ts",
                edits: [
                  { old_string: "a1", new_string: "b1" },
                  { old_string: "a2", new_string: "b2" },
                  { old_string: "a3", new_string: "b3" },
                  { old_string: "a4", new_string: "b4" },
                  { old_string: "a5", new_string: "b5" },
                  { old_string: "a6", new_string: "b6" },
                ],
              },
            },
          ],
        },
      },
    ];
    const data = extract(records, {
      redactor: makeRedactor(),
      testCommandRe: TEST_RE,
      repoRoot: "/r",
    });
    expect(data.diffs[0]!.excerpts).toHaveLength(10); // 5 before + 5 after
    expect(data.multiedit_dropped_hunks).toBe(1);
  });

  test("MultiEdit at exactly 5 hunks: no drop, no notice (criterion 20 boundary)", () => {
    const records = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "MultiEdit",
              id: "tu-1",
              input: {
                file_path: "/r/x.ts",
                edits: [
                  { old_string: "a1", new_string: "b1" },
                  { old_string: "a2", new_string: "b2" },
                  { old_string: "a3", new_string: "b3" },
                  { old_string: "a4", new_string: "b4" },
                  { old_string: "a5", new_string: "b5" },
                ],
              },
            },
          ],
        },
      },
    ];
    const data = extract(records, {
      redactor: makeRedactor(),
      testCommandRe: TEST_RE,
      repoRoot: "/r",
    });
    expect(data.diffs[0]!.excerpts).toHaveLength(10);
    expect(data.multiedit_dropped_hunks).toBe(0);
  });

  test("malformed Edit with no file_path: skipped, counter incremented", () => {
    const records = [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Edit", id: "tu-1", input: {} }],
        },
      },
    ];
    const data = extract(records, {
      redactor: makeRedactor(),
      testCommandRe: TEST_RE,
      repoRoot: "/r",
    });
    expect(data.diffs).toHaveLength(0);
    expect(data.skipped_changes).toBe(1);
  });

  test("models[] preserves first-encounter order across switches", () => {
    const records = [
      { type: "assistant", message: { model: "haiku", content: [] } },
      { type: "assistant", message: { model: "sonnet", content: [] } },
      { type: "assistant", message: { model: "haiku", content: [] } }, // re-encounter
      { type: "assistant", message: { model: "opus", content: [] } },
    ];
    const data = extract(records, {
      redactor: makeRedactor(),
      testCommandRe: TEST_RE,
      repoRoot: "/r",
    });
    expect(data.models).toEqual(["haiku", "sonnet", "opus"]);
    expect(data.model).toBe("opus");
  });

  test("started_at picks earliest, ended_at picks latest (timestamp lex)", () => {
    const records = [
      { type: "user", timestamp: "2026-05-01T12:00:00.000Z", message: { content: "a" } },
      { type: "user", timestamp: "2026-05-01T10:00:00.000Z", message: { content: "b" } },
      { type: "user", timestamp: "2026-05-01T15:00:00.000Z", message: { content: "c" } },
    ];
    const data = extract(records, {
      redactor: makeRedactor(),
      testCommandRe: TEST_RE,
      repoRoot: "/r",
    });
    expect(data.started_at).toBe("2026-05-01T10:00:00.000Z");
    expect(data.ended_at).toBe("2026-05-01T15:00:00.000Z");
  });

  test("modules_touched only contains repo-relative top-dirs", () => {
    const records = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Edit",
              id: "tu-1",
              input: { file_path: "/r/src/a.ts", old_string: "x", new_string: "y" },
            },
            {
              type: "tool_use",
              name: "Edit",
              id: "tu-2",
              input: { file_path: "/elsewhere/b.ts", old_string: "x", new_string: "y" },
            },
          ],
        },
      },
    ];
    const data = extract(records, {
      redactor: makeRedactor(),
      testCommandRe: TEST_RE,
      repoRoot: "/r",
    });
    expect(data.modules_touched).toEqual(["src"]);
  });

  test("[F4 / 2026-05-09] sibling-prefix paths (e.g. /repo-other/) are not treated as in-repo", () => {
    // Plain `startsWith(repoRoot)` would match `/Users/danielbentes/trail-other/foo.ts`
    // when repoRoot is `/Users/danielbentes/trail`, polluting modules_touched
    // with `trail-other`'s top-dir. Boundary-aware check rejects this.
    const records = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Edit",
              id: "tu-1",
              input: {
                file_path: "/Users/danielbentes/trail/src/a.ts",
                old_string: "x",
                new_string: "y",
              },
            },
            {
              type: "tool_use",
              name: "Edit",
              id: "tu-2",
              input: {
                file_path: "/Users/danielbentes/trail-other/lib/b.ts",
                old_string: "x",
                new_string: "y",
              },
            },
            {
              type: "tool_use",
              name: "Edit",
              id: "tu-3",
              input: {
                file_path: "/Users/danielbentes/trailish/c.ts",
                old_string: "x",
                new_string: "y",
              },
            },
          ],
        },
      },
    ];
    const data = extract(records, {
      redactor: makeRedactor(),
      testCommandRe: TEST_RE,
      repoRoot: "/Users/danielbentes/trail",
    });
    // Only the in-repo path's top-dir (`src`) should appear; sibling
    // directories `trail-other` and `trailish` MUST NOT.
    expect(data.modules_touched).toEqual(["src"]);
  });
});
