// Violation reporting. Two output modes:
//
//   1. Text (default): py-reference-compatible stderr lines, e.g.
//      `  .trail/sessions/<sid>/packet-1.yml:42  pattern=github-token  hash=ab12cd34`
//      followed by a summary footer + remediation hint.
//      DIVERGES from py-reference in one critical way: the snippet is HASHED
//      (sha256[:8]) instead of raw. Spec §5 SEC-9 + the orchestrator's
//      explicit "snippet HASHED, never raw" rule. The hash is debuggable
//      across builds (same secret → same hash) but non-recoverable for any
//      practical secret length.
//
//   2. JSON (--json): one JSON object per line (NDJSON), shape:
//      `{"file": "<abs-or-rel>", "line": 42, "pattern": "github-token", "snippet_hash": "ab12cd34"}`
//      Designed for CI integration (jq pipelines, GitHub Actions matrix).
//
// Both modes write to stderr (not stdout) to match the unix-tool convention
// for diagnostic output and to keep stdout clean for any future
// `--list-only` flag that emits offending paths to stdout for `xargs -0`.

import { relative } from "node:path";
import type { Finding } from "./scanner.js";

export type OutputMode = "text" | "json";

export interface ReportOptions {
  /** Anchor for relative-path display in text mode. Defaults to cwd. */
  baseDir?: string;
  /** Output mode. */
  mode: OutputMode;
  /** Sink for stderr writes (default: process.stderr.write). Test seam. */
  write: (line: string) => void;
}

/**
 * Format the leading FAIL banner. Always written before per-finding lines.
 */
function failBanner(mode: OutputMode): string {
  if (mode === "json") {
    // JSON mode: no banner — each line is a self-describing record. CI
    // pipelines that consume NDJSON expect well-formed-line-per-violation,
    // not interspersed prose.
    return "";
  }
  return "[trail-audit] FAIL — unredacted secret-like patterns found in .trail/:\n\n";
}

/**
 * Format a single finding for the configured mode.
 */
function formatFinding(f: Finding, mode: OutputMode, baseDir: string): string {
  const rel = toRelative(f.file, baseDir);
  if (mode === "json") {
    // JSON.stringify guarantees safe escaping for any path/pattern content.
    // Using snake_case for the JSON keys aligns with the existing
    // packet schema convention (snake_case throughout the on-disk format).
    return `${JSON.stringify({ file: rel, line: f.line, pattern: f.pattern, snippet_hash: f.snippetHash })}\n`;
  }
  return `  ${rel}:${f.line}  pattern=${f.pattern}  hash=${f.snippetHash}\n`;
}

/**
 * Format the trailing summary + remediation hint. Text mode only;
 * JSON mode is summary-free per the line-per-record contract.
 */
function summaryFooter(findings: Finding[], mode: OutputMode): string {
  if (mode === "json") return "";
  const fileCount = new Set(findings.map((f) => f.file)).size;
  return [
    "",
    `[trail-audit] ${findings.length} finding(s) across ${fileCount} file(s).`,
    "[trail-audit] Investigate before committing. To override (NOT recommended):",
    "[trail-audit]   git commit --no-verify  # bypasses ALL pre-commit hooks",
    "",
  ].join("\n");
}

/**
 * Emit the full violation report.
 */
export function reportViolations(findings: Finding[], options: ReportOptions): void {
  const baseDir = options.baseDir ?? process.cwd();
  const banner = failBanner(options.mode);
  if (banner.length > 0) options.write(banner);
  for (const f of findings) {
    options.write(formatFinding(f, options.mode, baseDir));
  }
  const footer = summaryFooter(findings, options.mode);
  if (footer.length > 0) options.write(footer);
}

/**
 * Try to express path relative to baseDir; fall back to absolute if the
 * relative form would escape upward (`..`-prefixed) — that's confusing to
 * a reader who expects "in this repo, at this path".
 */
function toRelative(absOrRel: string, baseDir: string): string {
  try {
    const r = relative(baseDir, absOrRel);
    if (r.length === 0) return absOrRel;
    if (r.startsWith("..")) return absOrRel;
    return r.replace(/\\/g, "/");
  } catch {
    return absOrRel;
  }
}
