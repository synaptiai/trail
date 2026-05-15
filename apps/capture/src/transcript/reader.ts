// Streaming JSONL transcript reader.
// Phase 1 spec §4: parse `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl`.
// Inline tool_result blocks come from `user`-typed records' `message.content`
// arrays. Phase 1 explicitly does NOT consult `tool-results/*` directories.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type TranscriptRecord = Record<string, unknown>;

export class TranscriptNotFoundError extends Error {
  readonly subShape: "a" | "b" | "c";
  constructor(subShape: "a" | "b" | "c", message: string) {
    super(message);
    this.name = "TranscriptNotFoundError";
    this.subShape = subShape;
  }
}

export function claudeProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

export async function findTranscript(sessionId: string): Promise<string> {
  const root = claudeProjectsRoot();
  if (!existsSync(root)) {
    throw new TranscriptNotFoundError("a", `no Claude Code projects directory at ${root}`);
  }
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    throw new TranscriptNotFoundError("a", `cannot read projects directory at ${root}`);
  }
  for (const entry of entries) {
    const projectDir = join(root, entry);
    let st: import("node:fs").Stats;
    try {
      st = statSync(projectDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const candidate = join(projectDir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  throw new TranscriptNotFoundError("c", `session id ${sessionId} not found in ${root}`);
}

export async function readTranscript(path: string): Promise<TranscriptRecord[]> {
  const records: TranscriptRecord[] = [];
  const stream = createReadStream(path, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip malformed JSON lines (matches py-reference behaviour).
    }
  }
  return records;
}

export function readTranscriptSync(path: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  const text = readFileSync(path, "utf-8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // ignore malformed JSON
    }
  }
  return records;
}
