// Layer 3 scanner — re-runs all redaction patterns against staged or on-disk
// packet files to catch any secret-like content that escaped Layer 1
// (capture-time redaction) or Layer 2 (write-time validation).
//
// Behavioral parity with py-reference/bin/trail-audit-precommit:
//   - Strip existing `[REDACTED:<name>]` markers BEFORE running patterns
//     (the marker text itself contains characters that would otherwise
//     re-match high-entropy patterns).
//   - Per-pattern `regex.finditer` over the scrubbed text: every distinct
//     match is a finding (NOT first-match-per-pattern like Layer 2's
//     `regex.search`). Layer 3 reports ALL violations to the user so they
//     can investigate one place at a time.
//   - Line numbers: 1-indexed; computed from `scrubbed[:m.start()].count("\n")`.
//   - Snippet: first 60 chars of the match (truncated; see py-reference line 54).
//     The snippet is HASHED before being surfaced (sha256[:8]) so raw secret
//     bytes never appear in stderr/stdout — issue acceptance criterion 3
//     ("structured error output") + spec §5 SEC-9 8-hex-char snippet rule.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CompiledPattern } from "@synapti/trail-capture";

// Same regex shape as apps/capture/src/redaction/layer2.ts:9 and
// py-reference/bin/trail-audit-precommit:22 (pattern names are
// `[a-z0-9-]+` per the bundled YAML naming convention).
const REDACTION_MARKER_RE = /\[REDACTED:[a-z0-9-]+\]/g;

export interface Finding {
  /** Absolute path to the offending file. */
  file: string;
  /** 1-indexed line number where the match starts. */
  line: number;
  /** Pattern name from the bundled YAML (e.g., `github-token`). */
  pattern: string;
  /** sha256(match)[:8] — 8 hex chars, NEVER the raw match. Spec §5 SEC-9. */
  snippetHash: string;
}

export function snippetHash(match: string): string {
  return createHash("sha256").update(match, "utf8").digest("hex").slice(0, 8);
}

/**
 * Read a file as UTF-8 text. Returns null if the file cannot be read
 * (mirroring py-reference's `try: text = path.read_text(errors="replace")
 * except Exception: return findings`). Layer 3 is best-effort: an
 * unreadable packet file is treated as "no findings here" — the
 * pre-commit hook still completes for the OTHER staged files. A truly
 * unreadable .trail/ packet is a separate problem (corrupt index,
 * permissions) the user will surface via normal git operations.
 */
function readTextOrNull(path: string): string | null {
  try {
    // `errors: "replace"` parity: Node's TextDecoder does this by default
    // for `encoding: "utf8"` when `fatal: false` (the default).
    return readFileSync(path, { encoding: "utf8" });
  } catch {
    return null;
  }
}

/**
 * Scan a single file's text content for unredacted patterns.
 *
 * Behavior matches py-reference exactly:
 *   1. Strip `[REDACTED:<name>]` markers from the text → scrubbed.
 *   2. For each pattern (in load order), `regex.finditer(scrubbed)` —
 *      every match is a finding.
 *   3. Line number computed against the SCRUBBED text (since py-reference
 *      does the same — keeps marker-shifted line counts honest).
 *
 * The line number against the scrubbed text differs from the pre-strip
 * line number only when redaction markers themselves contain newlines,
 * which they cannot (the marker grammar is single-line `[REDACTED:<name>]`).
 * So scrubbed-line == original-line in practice.
 */
export function scanText(filePath: string, text: string, patterns: CompiledPattern[]): Finding[] {
  const findings: Finding[] = [];
  const scrubbed = text.replace(REDACTION_MARKER_RE, "");
  for (const { name, regex } of patterns) {
    // Clone the regex with the global flag set so we get all matches; the
    // bundled patterns are loaded with `g` already (apps/capture/src/redaction/
    // patterns.ts:192) but cloning is defensive against future refactors and
    // resets `lastIndex` deterministically per pattern.
    const probe = new RegExp(
      regex.source,
      regex.flags.includes("g") ? regex.flags : `${regex.flags}g`
    );
    let m: RegExpExecArray | null = probe.exec(scrubbed);
    while (m !== null) {
      const start = m.index;
      const matchText = m[0];
      // 1-indexed line number: count `\n` chars in the prefix + 1.
      const line = countNewlines(scrubbed, start) + 1;
      findings.push({
        file: filePath,
        line,
        pattern: name,
        snippetHash: snippetHash(matchText),
      });
      // Advance past zero-length matches to avoid infinite loops; the
      // bundled patterns never produce zero-length matches but a
      // user-supplied pattern might (e.g., a stray `(?:)`). Treat zero-length
      // as "no progress" and step forward by 1.
      if (matchText.length === 0) {
        probe.lastIndex = start + 1;
      }
      m = probe.exec(scrubbed);
    }
  }
  return findings;
}

/**
 * Scan a file at path. Convenience wrapper around scanText that handles
 * I/O errors per py-reference's silent-skip semantics.
 */
export function scanFile(filePath: string, patterns: CompiledPattern[]): Finding[] {
  const text = readTextOrNull(filePath);
  if (text === null) return [];
  return scanText(filePath, text, patterns);
}

/**
 * Count `\n` characters in `s.slice(0, end)`. Hot path: keep linear.
 * For typical packet sizes (~100KB) this is well under the ms budget;
 * we avoid `slice` to skip the intermediate string allocation.
 */
function countNewlines(s: string, end: number): number {
  let count = 0;
  for (let i = 0; i < end; i++) {
    if (s.charCodeAt(i) === 10) count++;
  }
  return count;
}
