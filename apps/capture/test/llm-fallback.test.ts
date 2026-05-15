// LLM fallback triggers (criterion 9 / spec §6).
// Six triggers each → mechanical fallback unless --strict-llm.

import { describe, expect, test } from "vitest";
import { type LlmRunner, synthesizeLlm } from "../src/claims/llm.js";
import type { ExtractData } from "../src/extract/extract.js";
import { Redactor } from "../src/redaction/layer1.js";
import { loadPatterns } from "../src/redaction/patterns.js";

const SAMPLE_DATA: ExtractData = {
  prompts: [{ id: "PROMPT-001", text: "fix the bug" }],
  commands: [],
  tests: [],
  diffs: [
    {
      id: "DIFF-001",
      description: "Edited /repo/a.ts",
      files: ["/repo/a.ts"],
      tool: "Edit",
      excerpts: [],
    },
    {
      id: "DIFF-002",
      description: "Edited /repo/b.ts",
      files: ["/repo/b.ts"],
      tool: "Edit",
      excerpts: [],
    },
  ],
  files_changed: ["/repo/a.ts", "/repo/b.ts"],
  modules_touched: ["repo"],
  started_at: "2026-05-01T10:00:00.000Z",
  ended_at: "2026-05-01T10:01:00.000Z",
  model: "x",
  models: ["x"],
  multiedit_dropped_hunks: 0,
  skipped_changes: 0,
};

function makeOpts(runner: LlmRunner) {
  return {
    model: "haiku",
    budgetUsd: 0.5,
    timeoutSeconds: 120,
    redactor: new Redactor(loadPatterns(undefined, { useCache: false }).patterns),
    sessionId: "sess",
    runner,
  };
}

describe("LLM fallback triggers (criterion 9)", () => {
  test("(a) CLI absent", async () => {
    const r = await synthesizeLlm(
      SAMPLE_DATA,
      makeOpts(async () => ({
        status: "cli-absent",
        stdout: "",
        stderr: "",
        exitCode: -1,
      }))
    );
    expect(r.claims).toBeNull();
    expect(r.reason).toBe("cli-absent");
  });

  test("(b) Subprocess non-zero exit (stdout ignored)", async () => {
    const r = await synthesizeLlm(
      SAMPLE_DATA,
      makeOpts(async () => ({
        status: "exit-non-zero",
        stdout: '[{"file":"/repo/a.ts","claim":"x"}]',
        stderr: "boom",
        exitCode: 1,
      }))
    );
    expect(r.claims).toBeNull();
    expect(r.reason).toBe("exit-non-zero");
  });

  test("(c) Timeout", async () => {
    const r = await synthesizeLlm(
      SAMPLE_DATA,
      makeOpts(async () => ({
        status: "timeout",
        stdout: "",
        stderr: "",
        exitCode: -1,
      }))
    );
    expect(r.claims).toBeNull();
    expect(r.reason).toBe("timeout");
  });

  test("(d) stdout non-JSON", async () => {
    const r = await synthesizeLlm(
      SAMPLE_DATA,
      makeOpts(async () => ({
        status: "ok",
        stdout: "not json at all",
        stderr: "",
        exitCode: 0,
      }))
    );
    expect(r.claims).toBeNull();
    expect(r.reason).toBe("non-json");
  });

  test("(e) JSON parsed but len(parsed) < len(file_groups) (quality gate)", async () => {
    const r = await synthesizeLlm(
      SAMPLE_DATA,
      makeOpts(async () => ({
        status: "ok",
        stdout: '[{"file":"/repo/a.ts","claim":"only one"}]',
        stderr: "",
        exitCode: 0,
      }))
    );
    expect(r.claims).toBeNull();
    expect(r.reason).toBe("quality-gate");
  });

  test("(f) JSON parsed but file paths don't match", async () => {
    const r = await synthesizeLlm(
      SAMPLE_DATA,
      makeOpts(async () => ({
        status: "ok",
        stdout: '[{"file":"/wrong/path.ts","claim":"x"},{"file":"/another/wrong.ts","claim":"y"}]',
        stderr: "",
        exitCode: 0,
      }))
    );
    expect(r.claims).toBeNull();
    expect(r.reason).toBe("quality-gate");
  });

  test("happy path: JSON parsed correctly with all file groups present", async () => {
    const r = await synthesizeLlm(
      SAMPLE_DATA,
      makeOpts(async () => ({
        status: "ok",
        stdout:
          '[{"file":"/repo/a.ts","claim":"refactored a"},{"file":"/repo/b.ts","claim":"refactored b"}]',
        stderr: "",
        exitCode: 0,
      }))
    );
    expect(r.claims).not.toBeNull();
    expect(r.claims!.length).toBe(2);
    expect(r.claims![0]!.synthesis_mode).toBe("llm");
  });

  test("fence-stripping: ```json prefix removed", async () => {
    const r = await synthesizeLlm(
      SAMPLE_DATA,
      makeOpts(async () => ({
        status: "ok",
        stdout:
          '```json\n[{"file":"/repo/a.ts","claim":"a"},{"file":"/repo/b.ts","claim":"b"}]\n```',
        stderr: "",
        exitCode: 0,
      }))
    );
    expect(r.claims).not.toBeNull();
    expect(r.claims!.length).toBe(2);
  });
});
