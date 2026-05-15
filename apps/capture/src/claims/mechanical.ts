// Mechanical claim synthesis — spec §6.
// Two grouping modes: per-file (default) and per-DIFF (--per-diff).
// Test rollup claim appended in both modes when test_evidence non-empty.

import type { ExtractData } from "../extract/extract.js";
import { deriveStableId } from "../packet/stable-id.js";
import type { Claim } from "../packet/types.js";

export interface SynthesisOptions {
  perDiff: boolean;
  sessionId: string;
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

export function synthesizeMechanical(data: ExtractData, opts: SynthesisOptions): Claim[] {
  const { perDiff, sessionId } = opts;
  const claims: Claim[] = [];
  let n = 0;

  if (perDiff) {
    for (const d of data.diffs) {
      n += 1;
      const fp = d.files[0];
      const action = d.tool.toLowerCase();
      const text = `${action} on ${fp} (${d.id})`;
      claims.push({
        id: `CLAIM-${pad3(n)}`,
        stable_id: deriveStableId(sessionId, text, n - 1),
        text,
        evidence_refs: [d.id],
        confidence: "supported",
        synthesis_mode: "mechanical",
      });
    }
  } else {
    // Insertion-ordered map preserves first-encountered order, matching py-reference's dict.
    const byFile = new Map<string, typeof data.diffs>();
    for (const d of data.diffs) {
      const f = d.files[0];
      const list = byFile.get(f) ?? [];
      list.push(d);
      byFile.set(f, list);
    }
    for (const [fp, ds] of byFile.entries()) {
      n += 1;
      const actions = [...new Set(ds.map((d) => d.tool.toLowerCase()))].sort();
      const text = `${actions.join("/")} on ${fp} (${ds.length} change(s))`;
      claims.push({
        id: `CLAIM-${pad3(n)}`,
        stable_id: deriveStableId(sessionId, text, n - 1),
        text,
        evidence_refs: ds.map((d) => d.id),
        confidence: "supported",
        synthesis_mode: "mechanical",
      });
    }
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

  return claims;
}
