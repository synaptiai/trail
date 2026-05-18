// Layer 1 — capture-time redaction. Spec §5.
// Replacement format: matched substring -> "[REDACTED:<pattern-name>]".
// Counter semantics: each substitution increments the winning pattern's count.
// Patterns are evaluated in declaration order (matching py-reference's
// `re.compile`-loop behaviour).

import type { CompiledPattern } from "./patterns.js";

// [gh#3 / 2026-05-18] Pure-hex shapes between 7 and 40 chars are
// indistinguishable from git SHAs (commit, tree, blob, short SHA) and
// dominate the `validation_errors` list in real captures (the
// 1047-claim AC#9 dogfood capture). The `high-entropy-string` pattern's
// char class `[A-Za-z0-9+]{40,}` matches them by virtue of being a
// superset of `[0-9a-f]`. Rust's `regex` crate does not support
// lookaround, so a pattern-level exclusion is not portable across the
// TS port + py-reference + the Tauri shell saga; the cleanest fix is a
// post-match predicate applied only to the `high-entropy-string`
// pattern name in the production redaction path. Other secret patterns
// whose surface shape happens to be pure-hex are unaffected because
// they have anchoring context the SHA shape lacks (e.g. aws-secret-key
// requires an `aws_secret_access_key` prefix).
//
// Residual risk: a 40-char hex token that IS a genuine secret (e.g. an
// HMAC, an opaque API token) passes through unredacted. No catalog
// rule today distinguishes "hex secret" from "git SHA" without
// surrounding context; the issue's AC#3 acknowledges this and defers
// to the secrets-scan pre-commit catalog at `bin/secrets-scan.mjs` for
// repo-level coverage.
const GIT_SHA_HEX = /^[0-9a-fA-F]{7,40}$/;

function isGitShaShape(match: string): boolean {
  return GIT_SHA_HEX.test(match);
}

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
      out = out.replace(resetGlobal(regex), (match) => {
        if (name === "high-entropy-string" && isGitShaShape(match)) {
          return match;
        }
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
      const replacement = `[REDACTED:${name}]`;
      out = out.replace(resetGlobal(regex), (match) => {
        if (name === "high-entropy-string" && isGitShaShape(match)) {
          return match;
        }
        return replacement;
      });
    }
    return out;
  }
}

function resetGlobal(regex: RegExp): RegExp {
  // Global regexes maintain `lastIndex` between `.replace()` calls when used
  // outside replace, which is benign here but defensive: re-construct each call.
  return new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
}
