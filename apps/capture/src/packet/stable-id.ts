// AB-5 / Phase 1 spec §6 Universal rule.
// stable_id = sha256(session_id || '|' || claim_text || '|' || position).hexdigest()[:16]
// 16 lowercase hex chars. Deterministic across re-captures of the same session.

import { createHash } from "node:crypto";

export function deriveStableId(sessionId: string, claimText: string, position: number): string {
  const seed = `${sessionId}|${claimText}|${position}`;
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16);
}
