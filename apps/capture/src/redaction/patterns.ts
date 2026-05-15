// Redaction pattern loader — singleton per process (A4.7 R-SEC-2).
// Validation gates per spec §3 `--patterns` flag: 64KB cap, FAILSAFE schema,
// non-empty patterns array, regex compile, ReDoS guard via safe-regex.

import { type Stats, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jsYaml from "js-yaml";
import safeRegex from "safe-regex";

export interface CompiledPattern {
  name: string;
  regex: RegExp;
}

export interface PatternLoadResult {
  version: string;
  patterns: CompiledPattern[];
  origin: "bundled" | "user-supplied";
  sourcePath: string;
}

export class PatternLoadError extends Error {
  readonly subShape: string;
  constructor(subShape: string, message: string) {
    super(message);
    this.name = "PatternLoadError";
    this.subShape = subShape;
  }
}

const MAX_PATTERN_FILE_BYTES = 64 * 1024;

let cached: PatternLoadResult | undefined;

export function resetPatternCache(): void {
  cached = undefined;
}

export function defaultBundledPatternsPath(): string {
  return resolve(fileURLToPath(new URL("../../bin/trail-redaction-patterns.yml", import.meta.url)));
}

function isUtf8(buf: Buffer): boolean {
  // Reject NUL bytes outright; a well-formed YAML pattern file never contains them.
  if (buf.includes(0)) return false;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    // Round-trip check: re-encoding must produce the same bytes.
    return Buffer.from(decoded, "utf-8").equals(buf);
  } catch {
    return false;
  }
}

export function loadPatterns(
  pathOverride: string | undefined,
  options: { useCache?: boolean } = {}
): PatternLoadResult {
  if (
    options.useCache !== false &&
    cached &&
    cached.sourcePath === (pathOverride ?? defaultBundledPatternsPath())
  ) {
    return cached;
  }

  const sourcePath = pathOverride ?? defaultBundledPatternsPath();
  const origin: "bundled" | "user-supplied" = pathOverride ? "user-supplied" : "bundled";

  let stat: Stats;
  try {
    stat = statSync(sourcePath);
  } catch {
    throw new PatternLoadError("a", `failed to load ${sourcePath}: file not found`);
  }
  if (stat.size > MAX_PATTERN_FILE_BYTES) {
    throw new PatternLoadError(
      "f",
      `failed to load ${sourcePath}: file size ${stat.size} bytes exceeds 64KB cap`
    );
  }
  const buf = readFileSync(sourcePath);
  if (!isUtf8(buf)) {
    throw new PatternLoadError(
      "g",
      `failed to load ${sourcePath}: file contains binary content (non-UTF-8 / non-YAML bytes)`
    );
  }

  let parsed: unknown;
  try {
    parsed = jsYaml.load(buf.toString("utf-8"), { schema: jsYaml.FAILSAFE_SCHEMA });
  } catch (err) {
    throw new PatternLoadError(
      "b",
      `failed to load ${sourcePath}: YAML parse error: ${(err as Error).message}`
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new PatternLoadError(
      "b",
      `failed to load ${sourcePath}: YAML parse error: top-level must be a mapping`
    );
  }

  const obj = parsed as Record<string, unknown>;
  const version = obj.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new PatternLoadError(
      "c",
      `failed to load ${sourcePath}: 'version' field missing or empty`
    );
  }

  const rawPatterns = obj.patterns;
  if (!Array.isArray(rawPatterns) || rawPatterns.length === 0) {
    throw new PatternLoadError(
      "e",
      `failed to load ${sourcePath}: 'patterns' array empty or missing — refusing to run with zero redaction patterns`
    );
  }

  const compiled: CompiledPattern[] = [];
  for (const entry of rawPatterns) {
    if (!entry || typeof entry !== "object") {
      throw new PatternLoadError(
        "d",
        `failed to compile pattern '<malformed>': entry is not a mapping`
      );
    }
    const name = (entry as Record<string, unknown>).name;
    const pattern = (entry as Record<string, unknown>).pattern;
    const rawFlagsField = (entry as Record<string, unknown>).flags;
    if (typeof name !== "string" || name.length === 0) {
      throw new PatternLoadError(
        "d",
        `failed to compile pattern '<unnamed>': 'name' missing or empty`
      );
    }
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new PatternLoadError(
        "d",
        `failed to compile pattern '${name}': 'pattern' missing or empty`
      );
    }
    // [§Y.3 / 2026-05-09] Per-pattern `flags` field is the canonical form for
    // bundled patterns (drops Python `(?i)` inline-flag prefix). The translator
    // below REMAINS as defense-in-depth for user-supplied patterns that may
    // still use Python-style `(?i)` syntax.
    let declaredFlags = "";
    if (rawFlagsField !== undefined) {
      if (typeof rawFlagsField !== "string") {
        throw new PatternLoadError(
          "d",
          `failed to compile pattern '${name}': 'flags' must be a string (subset of 'ims'); got ${typeof rawFlagsField}`
        );
      }
      // JS `RegExp` accepts 'i', 'm', 's' from the spec'd 'imsx' set ('x'
      // extended mode is Python-only). Reject any character outside this set.
      for (const f of rawFlagsField) {
        if (f !== "i" && f !== "m" && f !== "s") {
          throw new PatternLoadError(
            "d",
            `failed to compile pattern '${name}': 'flags' contains unsupported character '${f}' (allowed: 'i', 'm', 's')`
          );
        }
      }
      declaredFlags = rawFlagsField;
    }

    // Translate Python-style inline flags `(?i)` (case-insensitive) into a JS
    // RegExp `i` flag. Python regex allows `(?i)` anywhere; we accept it only
    // at the start of the pattern. Bundled patterns no longer use this form
    // (see §Y.3); kept as defense-in-depth for user-supplied patterns.
    //
    // [F17 / 2026-05-09] **Documented limitation**: this translator handles
    // ONLY the inline-flag-at-start subset (e.g., `(?i)foo`). It does NOT:
    //   - handle mid-pattern inline flags (`foo(?i)bar` — JS treats this as
    //     an unknown construct → SyntaxError surfaced as PatternLoadError(d)),
    //   - handle group-scoped inline flags (`(?i:foo)` — JS treats this
    //     identically to mid-pattern; SyntaxError surfaced as exit 4(d)),
    //   - support the `x` flag (Python VERBOSE) — JS RegExp has no equivalent;
    //     `x` in `flags` field is rejected as unsupported character at exit 4(d).
    //
    // Recommended path for user-supplied patterns: use the per-pattern
    // `flags` field (see §Y.3) instead of inline-flag prefixes. The
    // translator remains as a graceful fallback for users porting Python
    // regex literals; complex Python patterns may need rewriting.
    let source = pattern;
    let flags = "g";
    const inlineFlagMatch = source.match(/^\(\?([imsx]+)\)/);
    if (inlineFlagMatch) {
      const flagSet = inlineFlagMatch[1] ?? "";
      source = source.slice(inlineFlagMatch[0].length);
      for (const f of flagSet) {
        if (f === "i" || f === "m" || f === "s") {
          if (!flags.includes(f)) flags += f;
        }
      }
    }
    // Apply declared `flags` field on top of any inline-flag translation.
    for (const f of declaredFlags) {
      if (!flags.includes(f)) flags += f;
    }
    let regex: RegExp;
    try {
      regex = new RegExp(source, flags);
    } catch (err) {
      throw new PatternLoadError(
        "d",
        `failed to compile pattern '${name}': ${(err as Error).message}`
      );
    }
    // Static-analysis ReDoS guard (A4.9 R8-COUPLING-03). Applied only to
    // user-supplied patterns: bundled patterns are vetted and may legitimately
    // contain shapes safe-regex over-flags (e.g., `[A-Za-z0-9/+=]{40}` —
    // bounded quantifier, not catastrophic).
    if (origin === "user-supplied" && !safeRegex(pattern)) {
      throw new PatternLoadError(
        "h",
        `failed to load ${sourcePath}: pattern '${name}' has catastrophic backtracking shape (safe-regex check failed)`
      );
    }
    compiled.push({ name, regex });
  }

  const result: PatternLoadResult = { version, patterns: compiled, origin, sourcePath };
  if (options.useCache !== false) {
    cached = result;
  }
  return result;
}
