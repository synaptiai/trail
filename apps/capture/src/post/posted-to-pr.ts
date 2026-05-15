// Append-to-`posted_to_pr[]` helper. AB-2 (NEW v0.1.1).
// Reads the packet YAML, appends a new entry to the top-level array, and
// rewrites the packet via the Phase 1 atomic-write helper (tmp+rename).
//
// Phase 1 packets do NOT emit `posted_to_pr` (parity-locked). When this
// helper runs against a Phase 1 packet, the field is absent and we add it.
// Subsequent runs find the array and append.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NOOP_SIGNAL_CLEANUP, type SignalCleanup, atomicWrite } from "../io/atomic.js";
import type { ApprovalTrailEntry, PostedToPrEntry } from "../packet/types.js";
import { dumpYaml, loadYaml } from "../packet/yaml.js";

/**
 * Compute body_hash per AB-2: sha256 of the markdown body, full hex
 * (64 lowercase chars). Deterministic; the same markdown body always
 * produces the same hash.
 */
export function computeBodyHash(markdownBody: string): string {
  return createHash("sha256").update(markdownBody, "utf-8").digest("hex");
}

/**
 * Format an ISO-8601 timestamp with the +00:00 suffix mandated by schema
 * (NOT `Z`). Phase 1 generated_at follows the same convention.
 */
export function nowIso(now: Date = new Date()): string {
  // toISOString() emits "...Z"; replace with "+00:00" per schema §iso8601.
  return now.toISOString().replace(/Z$/, "+00:00");
}

interface MutablePacketShape {
  packet_version?: unknown;
  posted_to_pr?: unknown;
  approval_trail?: unknown;
  [key: string]: unknown;
}

function loadPacketYaml(packetPath: string): MutablePacketShape {
  const raw = readFileSync(packetPath, "utf-8");
  const parsed = loadYaml(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `packet at ${packetPath} did not parse as a YAML mapping (got ${typeof parsed})`
    );
  }
  return parsed as MutablePacketShape;
}

/**
 * Append `entry` to `packet.posted_to_pr[]` and atomically rewrite the file.
 * Creates the array if missing.
 */
export function appendPostedToPr(
  packetPath: string,
  entry: PostedToPrEntry,
  cleanup: SignalCleanup = NOOP_SIGNAL_CLEANUP
): void {
  const packet = loadPacketYaml(packetPath);

  // Defensive: validate that posted_to_pr is an array if present.
  if (packet.posted_to_pr !== undefined && !Array.isArray(packet.posted_to_pr)) {
    throw new Error(
      `packet at ${packetPath}: posted_to_pr exists but is not an array (got ${typeof packet.posted_to_pr})`
    );
  }
  const existing = (packet.posted_to_pr as PostedToPrEntry[] | undefined) ?? [];
  packet.posted_to_pr = [...existing, entry];

  const yaml = dumpYaml(packet);
  atomicWrite(packetPath, yaml, cleanup);
}

/**
 * Append `entry` to `packet.approval_trail[]` and atomically rewrite. Used by
 * `trail packet decide`. Creates the array if missing.
 */
export function appendApprovalTrail(
  packetPath: string,
  entry: ApprovalTrailEntry,
  cleanup: SignalCleanup = NOOP_SIGNAL_CLEANUP
): void {
  const packet = loadPacketYaml(packetPath);

  if (packet.approval_trail !== undefined && !Array.isArray(packet.approval_trail)) {
    throw new Error(
      `packet at ${packetPath}: approval_trail exists but is not an array (got ${typeof packet.approval_trail})`
    );
  }
  const existing = (packet.approval_trail as ApprovalTrailEntry[] | undefined) ?? [];
  packet.approval_trail = [...existing, entry];

  const yaml = dumpYaml(packet);
  atomicWrite(packetPath, yaml, cleanup);
}

/**
 * Read packet.summary.claims[] for cross-reference: caller validates that
 * a decide --claim X target actually exists in the packet before posting.
 */
export function readPacketClaimIds(packetPath: string): {
  ids: string[];
  stableIds: string[];
} {
  const packet = loadPacketYaml(packetPath);
  const summary = packet.summary;
  if (typeof summary !== "object" || summary === null) {
    return { ids: [], stableIds: [] };
  }
  const claims = (summary as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) return { ids: [], stableIds: [] };
  const ids: string[] = [];
  const stableIds: string[] = [];
  for (const c of claims) {
    if (typeof c !== "object" || c === null) continue;
    const id = (c as { id?: unknown }).id;
    const sid = (c as { stable_id?: unknown }).stable_id;
    if (typeof id === "string") ids.push(id);
    if (typeof sid === "string") stableIds.push(sid);
  }
  return { ids, stableIds };
}
