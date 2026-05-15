// Layer 1 — capture-time redaction. Spec §5.
// Replacement format: matched substring -> "[REDACTED:<pattern-name>]".
// Counter semantics: each substitution increments the winning pattern's count.
// Patterns are evaluated in declaration order (matching py-reference's
// `re.compile`-loop behaviour).

import type { CompiledPattern } from "./patterns.js";

export class Redactor {
  readonly patterns: CompiledPattern[];
  readonly counts: Record<string, number>;
  total: number;

  constructor(patterns: CompiledPattern[]) {
    this.patterns = patterns;
    this.counts = {};
    this.total = 0;
  }

  redact(text: string): string {
    if (!text) return text;
    let out = text;
    for (const { name, regex } of this.patterns) {
      const replacement = `[REDACTED:${name}]`;
      out = out.replace(resetGlobal(regex), () => {
        this.counts[name] = (this.counts[name] ?? 0) + 1;
        this.total += 1;
        return replacement;
      });
    }
    return out;
  }

  /**
   * One-shot redaction without mutating capture-time counters. Used by the
   * LLM-prompt boundary (spec §5 / SEC-3) where redaction is defense-in-depth
   * for egress, not a packet-counted event.
   */
  redactBoundary(text: string): string {
    if (!text) return text;
    let out = text;
    for (const { name, regex } of this.patterns) {
      out = out.replace(resetGlobal(regex), `[REDACTED:${name}]`);
    }
    return out;
  }
}

function resetGlobal(regex: RegExp): RegExp {
  // Global regexes maintain `lastIndex` between `.replace()` calls when used
  // outside replace, which is benign here but defensive: re-construct each call.
  return new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
}
