// AB-9 / spec §3 step 9a: re-capture detection + versioned packet path.
// Scan `<repo>/.trail/sessions/<session-id>/` for `^packet-(\d+)\.yml$`.
// next_n = max(N) + 1; parent_packet_id = prior packet's _meta.packet_id (or null).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import jsYaml from "js-yaml";

const PACKET_NAME_RE = /^packet-(\d+)\.yml$/;

export interface RecaptureInfo {
  nextN: number;
  parentPacketId: string | null;
  parentReadFailed: boolean;
}

export function detectRecapture(sessionDir: string): RecaptureInfo {
  if (!existsSync(sessionDir)) {
    return { nextN: 1, parentPacketId: null, parentReadFailed: false };
  }
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return { nextN: 1, parentPacketId: null, parentReadFailed: false };
  }
  const versions: Array<{ n: number; path: string }> = [];
  for (const entry of entries) {
    const m = PACKET_NAME_RE.exec(entry);
    if (!m) continue;
    const full = join(sessionDir, entry);
    let st: import("node:fs").Stats;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    versions.push({ n: Number(m[1]), path: full });
  }
  if (versions.length === 0) {
    return { nextN: 1, parentPacketId: null, parentReadFailed: false };
  }
  versions.sort((a, b) => a.n - b.n);
  const prev = versions[versions.length - 1]!;
  const nextN = prev.n + 1;
  let parentPacketId: string | null = null;
  let parentReadFailed = false;
  try {
    const text = readFileSync(prev.path, "utf-8");
    const parsed = jsYaml.load(text) as Record<string, unknown> | null;
    const meta =
      parsed && typeof parsed === "object"
        ? (parsed._meta as Record<string, unknown> | undefined)
        : undefined;
    const pid = meta?.packet_id;
    if (typeof pid === "string" && pid) {
      parentPacketId = pid;
    } else {
      parentReadFailed = true;
    }
  } catch {
    parentReadFailed = true;
  }
  return { nextN, parentPacketId, parentReadFailed };
}
