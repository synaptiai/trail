// Layer 2 — write-time validation. Spec §5.
// Operates entirely in-memory until atomic write. Snippet is sha256(match)[:8]
// (8 hex chars / 4 bytes). Locked across spec, schema, py-reference, TS port.

import { createHash } from "node:crypto";
import type { RedactionValidationError } from "../packet/types.js";
import type { CompiledPattern } from "./patterns.js";

const REDACTION_MARKER_RE = /\[REDACTED:[a-z0-9-]+\]/g;

export function snippetHash(match: string): string {
  return createHash("sha256").update(match, "utf8").digest("hex").slice(0, 8);
}

export function scanLayer2(
  serializedYaml: string,
  patterns: CompiledPattern[]
): RedactionValidationError[] {
  const scrubbed = serializedYaml.replace(REDACTION_MARKER_RE, "");
  const errors: RedactionValidationError[] = [];
  for (const { name, regex } of patterns) {
    // Use a non-global clone so .exec returns the first match deterministically.
    const probe = new RegExp(regex.source, regex.flags.replace("g", ""));
    const m = probe.exec(scrubbed);
    if (m?.[0]) {
      errors.push({ pattern: name, snippet: snippetHash(m[0]) });
    }
  }
  return errors;
}
