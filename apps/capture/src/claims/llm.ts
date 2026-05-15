// LLM-augmented claim synthesis. Spec §6.
// Pure logic + DI'd subprocess runner. Excerpts crossing the LLM boundary are
// Layer-1-redacted (A4.5 SEC-3 / spec §5).

import type { ExtractData } from "../extract/extract.js";
import { trackSubprocess, untrackSubprocess } from "../io/signals.js";
import { deriveStableId } from "../packet/stable-id.js";
import type { Claim } from "../packet/types.js";
import type { Redactor } from "../redaction/layer1.js";

export type LlmFailureReason =
  | "cli-absent"
  | "exit-non-zero"
  | "timeout"
  | "non-json"
  | "quality-gate"
  | "file-mismatch";

export interface LlmRunnerInput {
  prompt: string;
  model: string;
  budgetUsd: number;
  timeoutSeconds: number;
}

export interface LlmRunnerOutput {
  status: "ok" | "exit-non-zero" | "timeout" | "cli-absent";
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type LlmRunner = (input: LlmRunnerInput) => Promise<LlmRunnerOutput>;

export interface LlmSynthesisOptions {
  model: string;
  budgetUsd: number;
  timeoutSeconds: number;
  redactor: Redactor;
  sessionId: string;
  runner: LlmRunner;
}

interface FileGroup {
  file: string;
  operations: string[];
  diff_count: number;
  diff_ids: string[];
  excerpt_preview: string;
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function groupByFile(data: ExtractData): FileGroup[] {
  const map = new Map<string, typeof data.diffs>();
  for (const d of data.diffs) {
    const list = map.get(d.files[0]) ?? [];
    list.push(d);
    map.set(d.files[0], list);
  }
  return [...map.entries()].map(([file, ds]) => ({
    file,
    operations: [...new Set(ds.map((d) => d.tool))].sort(),
    diff_count: ds.length,
    diff_ids: ds.map((d) => d.id),
    excerpt_preview: "",
  }));
}

function buildExcerptPreview(
  diffs: { excerpts: { kind: string; text: string }[] }[],
  redactor: Redactor
): string {
  const lines: string[] = [];
  for (const d of diffs.slice(0, 3)) {
    for (const ex of d.excerpts.slice(0, 2)) {
      const redactedFull = redactor.redactBoundary(ex.text ?? "");
      const t = redactedFull.slice(0, 200);
      lines.push(`  [${ex.kind ?? "?"}] ${t}`);
    }
  }
  return lines.join("\n").slice(0, 1200);
}

export function buildLlmPrompt(
  data: ExtractData,
  redactor: Redactor
): { promptText: string; fileGroups: FileGroup[] } {
  const fileGroups = groupByFile(data);
  for (let i = 0; i < fileGroups.length; i++) {
    const fg = fileGroups[i]!;
    const ds = data.diffs.filter((d) => d.files[0] === fg.file);
    fg.excerpt_preview = buildExcerptPreview(ds, redactor);
  }
  const initialPrompt = data.prompts[0]?.text.slice(0, 600) ?? "";
  let promptText = `You are summarizing a Claude Code session for a PR Change Packet. For each file group, write ONE interpretive sentence that says WHAT was done and WHY (intent, not just operation). Keep each sentence under 25 words. Avoid filler like 'this change' or 'the developer'. Lead with the verb.\n\nSESSION INTENT (from initial prompt): ${JSON.stringify(initialPrompt)}\n\nFILE GROUPS (${fileGroups.length}):\n\n`;
  fileGroups.forEach((fg, i) => {
    promptText +=
      `--- group ${i + 1} ---\n` +
      `file: ${fg.file}\n` +
      `operations: ${fg.operations.join(",")} (${fg.diff_count} change(s))\n` +
      `sample excerpts:\n${fg.excerpt_preview}\n\n`;
  });
  promptText +=
    "Reply with ONLY a JSON array, no prose, no code fence:\n" +
    '[{"file": "<path>", "claim": "<interpretive sentence>"}]\n' +
    "One entry per file group, in the same order.";
  return { promptText, fileGroups };
}

export interface LlmSynthesisResult {
  claims: Claim[] | null;
  reason: LlmFailureReason | null;
  detail?: string;
}

export async function synthesizeLlm(
  data: ExtractData,
  opts: LlmSynthesisOptions
): Promise<LlmSynthesisResult> {
  const { model, budgetUsd, timeoutSeconds, redactor, sessionId, runner } = opts;
  const { promptText, fileGroups } = buildLlmPrompt(data, redactor);

  const result = await runner({
    prompt: promptText,
    model,
    budgetUsd,
    timeoutSeconds,
  });

  if (result.status === "cli-absent") {
    return { claims: null, reason: "cli-absent", detail: "claude CLI not on PATH" };
  }
  if (result.status === "timeout") {
    return {
      claims: null,
      reason: "timeout",
      detail: `claude CLI timed out after ${timeoutSeconds}s`,
    };
  }
  if (result.status === "exit-non-zero") {
    return {
      claims: null,
      reason: "exit-non-zero",
      detail: `claude CLI exit ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
    };
  }

  let raw = result.stdout.trim();
  raw = raw
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      claims: null,
      reason: "non-json",
      detail: `claude returned non-JSON: ${(e as Error).message}; first 200 chars: ${raw.slice(0, 200)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      claims: null,
      reason: "non-json",
      detail: `expected JSON array, got ${typeof parsed}`,
    };
  }
  const byFilePath = new Map(fileGroups.map((fg) => [fg.file, fg]));
  const claims: Claim[] = [];
  let n = 0;
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const er = entry as Record<string, unknown>;
    const fp = String(er.file ?? "");
    const text = String(er.claim ?? "").trim();
    if (!fp || !text || !byFilePath.has(fp)) continue;
    n += 1;
    const fg = byFilePath.get(fp)!;
    claims.push({
      id: `CLAIM-${pad3(n)}`,
      stable_id: deriveStableId(sessionId, text, n - 1),
      text,
      evidence_refs: fg.diff_ids,
      confidence: "supported",
      synthesis_mode: "llm",
    });
  }

  if (data.tests.length > 0) {
    n += 1;
    const text = `Ran ${data.tests.length} test/validation command(s) during the session`;
    claims.push({
      id: `CLAIM-${pad3(n)}`,
      stable_id: deriveStableId(sessionId, text, n - 1),
      text,
      evidence_refs: data.tests.map((t) => t.id),
      confidence: "supported",
      synthesis_mode: "mechanical",
    });
  }

  const interpretiveCount = data.tests.length > 0 ? claims.length - 1 : claims.length;
  if (interpretiveCount < fileGroups.length) {
    return {
      claims: null,
      reason: "quality-gate",
      detail: `LLM returned ${interpretiveCount} claims for ${fileGroups.length} groups; falling back`,
    };
  }
  if (interpretiveCount === 0 && fileGroups.length === 0) {
    // No diffs, no LLM claims expected. Still return ok so caller can append rollup.
  }

  return { claims, reason: null };
}

export function spawnClaudeRunner(): LlmRunner {
  return async ({ prompt, model, budgetUsd, timeoutSeconds }) => {
    const { spawn } = await import("node:child_process");
    return new Promise<LlmRunnerOutput>((resolve) => {
      let child: import("node:child_process").ChildProcessWithoutNullStreams;
      try {
        // [F2 / 2026-05-09] `detached: true` makes the child a process-group
        // leader so `process.kill(-pid, "SIGKILL")` in signals.ts:cleanup()
        // delivers a tree-kill (parent + grandchildren). Without this,
        // `claude` itself spawns model subprocesses that survive SIGINT.
        // `child.unref()` is called below after the process is registered so
        // the parent event loop is not held open by the subprocess.
        child = spawn(
          "claude",
          [
            "-p",
            "--model",
            model,
            "--output-format",
            "text",
            "--no-session-persistence",
            "--max-budget-usd",
            String(budgetUsd),
          ],
          { stdio: ["pipe", "pipe", "pipe"], detached: true }
        );
      } catch {
        resolve({ status: "cli-absent", stdout: "", stderr: "", exitCode: -1 });
        return;
      }
      // [F1 / 2026-05-09] Register the child with the global signal-cleanup
      // singleton so SIGINT/SIGTERM during the subprocess lifecycle delivers
      // tree-kill via `process.kill(-pid, "SIGKILL")`. Untracked in
      // close/error handlers below to avoid stale references.
      trackSubprocess(child);
      child.unref();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      // [F20 / 2026-05-09] Capture the SIGKILL-escalation inner timer ref so
      // `child.on("close", ...)` can clearTimeout it. Without this, after the
      // child exits (clearing the outer timer) the inner 5s timer keeps the
      // event loop alive and the CLI takes up to 5 extra seconds to exit on
      // the timeout path. `.unref()` is applied defensively below so the
      // timer can never block process exit even if a clear path is missed.
      let killEscalationTimer: NodeJS.Timeout | null = null;
      const settle = (output: LlmRunnerOutput): void => {
        if (settled) return;
        settled = true;
        if (killEscalationTimer !== null) {
          clearTimeout(killEscalationTimer);
          killEscalationTimer = null;
        }
        untrackSubprocess();
        resolve(output);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          // Tree-kill on timeout, mirroring the SIGINT path. `-pid` requires
          // the child to be a process-group leader (set via detached:true).
          if (child.pid) process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
        }
        killEscalationTimer = setTimeout(() => {
          killEscalationTimer = null;
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        }, 5000);
        // Defence-in-depth: even if a settle() path forgets to clear, the
        // unref'd timer cannot keep the event loop alive past process exit.
        killEscalationTimer.unref();
      }, timeoutSeconds * 1000);
      child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          settle({ status: "cli-absent", stdout, stderr, exitCode: -1 });
        } else {
          settle({ status: "exit-non-zero", stdout, stderr, exitCode: -1 });
        }
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          settle({ status: "timeout", stdout, stderr, exitCode: code ?? -1 });
        } else if (code === 0) {
          settle({ status: "ok", stdout, stderr, exitCode: 0 });
        } else {
          settle({ status: "exit-non-zero", stdout, stderr, exitCode: code ?? -1 });
        }
      });
      child.stdin?.write(prompt);
      child.stdin?.end();
    });
  };
}
