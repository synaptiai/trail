// Walks transcript records and produces the data tuple consumed by claim
// synthesis + packet build. Mirrors py-reference/cli/trail.py:extract().
//
// Length caps locked per spec §4. Layer 1 redaction applied at the designated
// fields (initial/followup prompts, command + stdout_summary, test refs).
// Excerpts on disk are NOT redacted (Decision #3); LLM-prompt boundary IS
// redacted in claims/llm.ts.

import type { Redactor } from "../redaction/layer1.js";
import type { TranscriptRecord } from "../transcript/reader.js";

const MAX_PROMPT_CHARS = 1200;
const MAX_CMD_CHARS = 500;
const MAX_STDOUT_CHARS = 1200;
const MAX_EXCERPT_CHARS = 1200;
const MAX_TEST_REF_CHARS = 140;

const TAG_RE = /<[^>]+>/g;

export interface ExtractedPrompt {
  id: string;
  text: string;
}

export interface ExtractedCommand {
  id: string;
  command: string;
  exit_code: number;
  duration_ms: number;
  stdout_summary: string;
  stderr_summary: "";
}

export interface ExtractedTest {
  id: string;
  ref: string;
  cmd_ref: string;
}

export interface ExtractedExcerpt {
  kind: string;
  text: string;
  elided: boolean;
}

export interface ExtractedDiff {
  id: string;
  description: string;
  files: [string];
  tool: "Write" | "Edit" | "MultiEdit";
  excerpts: ExtractedExcerpt[];
}

export interface ExtractData {
  prompts: ExtractedPrompt[];
  commands: ExtractedCommand[];
  tests: ExtractedTest[];
  diffs: ExtractedDiff[];
  files_changed: string[];
  modules_touched: string[];
  started_at: string;
  ended_at: string;
  model: string;
  models: string[];
  multiedit_dropped_hunks: number;
  skipped_changes: number;
}

export interface ExtractOptions {
  redactor: Redactor;
  testCommandRe: RegExp;
  repoRoot: string;
}

function flattenTextBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const blk of content) {
      if (!blk || typeof blk !== "object") continue;
      const b = blk as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

function clipExcerpt(text: string): { text: string; elided: boolean } {
  // Code-point semantics throughout (matches py-reference behavior on strings
  // with non-BMP chars). Iterate via spread for correct slicing.
  const cps = [...text];
  if (cps.length <= MAX_EXCERPT_CHARS) return { text, elided: false };
  const head = MAX_EXCERPT_CHARS - 200;
  const tail = 150;
  const elision = cps.length - head - tail;
  const headPart = cps.slice(0, head).join("");
  const tailPart = cps.slice(-tail).join("");
  return {
    text: `${headPart}\n... [elided ${elision} chars] ...\n${tailPart}`,
    elided: true,
  };
}

function sliceCp(s: string, n: number): string {
  if (s.length <= n) return s;
  // Fast path for ASCII-only.
  let isAscii = true;
  for (let i = 0; i < s.length && i < n + 4; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      isAscii = false;
      break;
    }
  }
  if (isAscii) return s.slice(0, n);
  return [...s].slice(0, n).join("");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function codePointLength(s: string): number {
  // Counts Unicode code points (matches Python's len(str)).
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // high surrogate — skip the low surrogate
      i++;
    }
    n++;
  }
  return n;
}

export function extract(records: TranscriptRecord[], opts: ExtractOptions): ExtractData {
  const { redactor, testCommandRe, repoRoot } = opts;

  const prompts: ExtractedPrompt[] = [];
  const commands: ExtractedCommand[] = [];
  const tests: ExtractedTest[] = [];
  const diffs: ExtractedDiff[] = [];
  const filesChanged = new Set<string>();
  const modulesTouched = new Set<string>();
  let startedAt = "";
  let endedAt = "";
  let model = "";
  const modelsSeen: string[] = [];
  let multieditDroppedHunks = 0;
  let skippedChanges = 0;

  // First pass: collect tool_results from user-typed records.
  const toolResults = new Map<string, string>();
  for (const rec of records) {
    if ((rec as Record<string, unknown>).type !== "user") continue;
    const message = (rec as Record<string, unknown>).message;
    if (!message || typeof message !== "object") continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (!blk || typeof blk !== "object") continue;
      const b = blk as Record<string, unknown>;
      if (b.type !== "tool_result") continue;
      const tuId = b.tool_use_id;
      if (typeof tuId !== "string") continue;
      const trc = b.content;
      let resultText = "";
      if (typeof trc === "string") {
        resultText = trc;
      } else if (Array.isArray(trc)) {
        const parts: string[] = [];
        for (const tr of trc) {
          if (
            tr &&
            typeof tr === "object" &&
            typeof (tr as Record<string, unknown>).text === "string"
          ) {
            parts.push((tr as Record<string, unknown>).text as string);
          }
        }
        resultText = parts.join("");
      }
      toolResults.set(tuId, resultText);
    }
  }

  let promptN = 0;
  let cmdN = 0;
  let diffN = 0;
  let testN = 0;

  for (const rec of records) {
    const r = rec as Record<string, unknown>;
    const ts = r.timestamp;
    if (typeof ts === "string" && ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
    }

    const message = (r.message as Record<string, unknown> | undefined) ?? {};

    if (r.type === "user") {
      const content = message.content;
      let text: string | null = null;
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = flattenTextBlocks(content);
      }
      if (!text) continue;
      const stripped = text.replace(TAG_RE, "").trim();
      if (!stripped) continue;
      promptN += 1;
      prompts.push({
        id: `PROMPT-${pad3(promptN)}`,
        text: redactor.redact(sliceCp(stripped, MAX_PROMPT_CHARS)),
      });
    } else if (r.type === "assistant") {
      const mdl = message.model;
      if (typeof mdl === "string" && mdl) {
        model = mdl;
        if (!modelsSeen.includes(mdl)) modelsSeen.push(mdl);
      }
      const content = message.content;
      if (!Array.isArray(content)) continue;
      for (const blk of content) {
        if (!blk || typeof blk !== "object") continue;
        const b = blk as Record<string, unknown>;
        if (b.type !== "tool_use") continue;
        const toolName = String(b.name ?? "");
        const tuId = String(b.id ?? "");
        const inp = (b.input as Record<string, unknown> | undefined) ?? {};

        if (toolName === "Bash") {
          const cmd = String(inp.command ?? "");
          const out = toolResults.get(tuId) ?? "";
          const isTest = testCommandRe.test(cmd);
          // Reset lastIndex if testCommandRe is global (defensive).
          testCommandRe.lastIndex = 0;
          cmdN += 1;
          const cmdId = `CMD-${pad3(cmdN)}`;
          commands.push({
            id: cmdId,
            command: redactor.redact(sliceCp(cmd, MAX_CMD_CHARS)),
            exit_code: 0,
            duration_ms: 0,
            stdout_summary: redactor.redact(sliceCp(out, MAX_STDOUT_CHARS)),
            stderr_summary: "",
          });
          if (isTest) {
            testN += 1;
            tests.push({
              id: `TEST-${pad3(testN)}`,
              ref: redactor.redact(sliceCp(cmd, MAX_TEST_REF_CHARS)),
              cmd_ref: cmdId,
            });
          }
        } else if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
          const fp = String(inp.file_path ?? "");
          if (!fp) {
            skippedChanges += 1;
            continue;
          }
          filesChanged.add(fp);
          // [F4 / 2026-05-09] Boundary-aware prefix check. Plain
          // `startsWith(repoRoot)` admits `/repo-other/...` when `repoRoot`
          // is `/repo`. Compare with a trailing-separator boundary (or
          // exact equality) so `/repo-other/foo.ts` does not falsely match.
          const rootWithSep = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
          if (fp === repoRoot || fp.startsWith(rootWithSep)) {
            const rel = fp.slice(repoRoot.length).replace(/^\/+/, "");
            const top = rel.split("/")[0] ?? "";
            if (top) modulesTouched.add(top);
          }
          diffN += 1;
          const excerpts: ExtractedExcerpt[] = [];
          let descr = "";
          if (toolName === "Write") {
            const ctext = String(inp.content ?? "");
            // Match py-reference's len(str) semantics (code points, not UTF-16 units).
            descr = `Wrote ${fp} (${codePointLength(ctext)} chars)`;
            if (ctext) {
              const clipped = clipExcerpt(ctext);
              excerpts.push({ kind: "after", text: clipped.text, elided: clipped.elided });
            }
          } else if (toolName === "Edit") {
            const oldS = String(inp.old_string ?? "");
            const newS = String(inp.new_string ?? "");
            descr = `Edited ${fp}`;
            if (oldS) {
              const c = clipExcerpt(oldS);
              excerpts.push({ kind: "before", text: c.text, elided: c.elided });
            }
            if (newS) {
              const c = clipExcerpt(newS);
              excerpts.push({ kind: "after", text: c.text, elided: c.elided });
            }
          } else {
            // MultiEdit
            const editsRaw = inp.edits;
            const edits = Array.isArray(editsRaw) ? editsRaw : [];
            descr = `MultiEdit on ${fp} (${edits.length} hunk(s))`;
            const cap = 5;
            for (let i = 0; i < Math.min(edits.length, cap); i++) {
              const e = edits[i];
              if (!e || typeof e !== "object") continue;
              const er = e as Record<string, unknown>;
              const oldS = String(er.old_string ?? "");
              const newS = String(er.new_string ?? "");
              if (oldS) {
                const c = clipExcerpt(oldS);
                excerpts.push({ kind: `before#${i + 1}`, text: c.text, elided: c.elided });
              }
              if (newS) {
                const c = clipExcerpt(newS);
                excerpts.push({ kind: `after#${i + 1}`, text: c.text, elided: c.elided });
              }
            }
            if (edits.length > cap) {
              multieditDroppedHunks += edits.length - cap;
            }
          }
          diffs.push({
            id: `DIFF-${pad3(diffN)}`,
            description: descr,
            files: [fp],
            tool: toolName as "Write" | "Edit" | "MultiEdit",
            excerpts,
          });
        }
      }
    }
  }

  return {
    prompts,
    commands,
    tests,
    diffs,
    files_changed: [...filesChanged].sort(),
    modules_touched: [...modulesTouched].sort(),
    started_at: startedAt,
    ended_at: endedAt,
    model,
    models: modelsSeen,
    multiedit_dropped_hunks: multieditDroppedHunks,
    skipped_changes: skippedChanges,
  };
}
