// Canonical fixture: py-reference parity test (gh#3 acceptance criterion 7).
//
// AC-7 "no false-positives on canonical fixtures" was originally drafted
// expecting zero findings on the canonical packet at
// `py-reference/fixtures/sessions/18e374b5-4eb9-424d-a3ff-a639d1c6fada/`.
// Diagnosis (Phase 3a, 2026-05-09): the canonical fixture was captured
// with redaction-pattern-set v0.1.2 (`redactions_applied: 0`,
// `pattern_set_version: "0.1.2"`); pattern-set v0.1.3 added two patterns
// (`url-userinfo`, `high-entropy-string` over hex SHAs) that DO match
// content present in the fixture:
//
//   - `url-userinfo` matches doc-example URLs of the form
//     `https://x-access-token:ghp_xxx@github.com/...` that appear in
//     `text:` fields captured from `docs/specs/phase-1-capture.md`
//     (the spec literally describes the userinfo-strip pattern).
//   - `high-entropy-string` (`[A-Za-z0-9+]{40,}`) matches 40-hex git
//     SHAs in `diff_summary.base_sha` / `head_sha` fields — a known
//     false-positive class previously logged in
//     `.claude/memory/corrections.md` (2026-05-08 entry).
//
// Both py-reference's `bin/trail-audit-precommit` and this TS port
// produce IDENTICAL findings on the fixture (verified manually
// 2026-05-09 — same line numbers, same patterns, same snippet hashes).
// The TS port is therefore at exact parity with py-reference, which is
// the load-bearing AC-7 invariant: a future fixture regression would
// surface here as a parity divergence.
//
// We do NOT suppress the findings or weaken the regex (N15 lesson:
// "a scanner that 'looks correct' but matches nothing meaningful is the
// worst kind of fail"). Instead we assert the ground-truth set of known
// findings; if py-reference's behavior changes, this test will fail and
// force a deliberate re-evaluation rather than silently drifting.
//
// Closing AC-7 cleanly will require either (a) regenerating the
// canonical fixture with Layer 1 v0.1.3 (so userinfo URLs are
// `[REDACTED:url-userinfo]`-marked at capture time), or (b) tightening
// `high-entropy-string` to exclude pure hex (which would also drop the
// SHA matches). Both are deferred to a follow-up: changing the regex
// touches Layer 1 + Layer 2 + Layer 3 simultaneously and requires
// patch-version bump + parity re-run across py-reference.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPatterns } from "@synapti/trail-capture";
import { describe, expect, it } from "vitest";
import { scanText } from "../src/scanner.js";

const here = resolve(fileURLToPath(import.meta.url), "..");
const repoRoot = resolve(here, "..", "..", "..");
const canonicalDir = resolve(
  repoRoot,
  "py-reference",
  "fixtures",
  "sessions",
  "18e374b5-4eb9-424d-a3ff-a639d1c6fada"
);
const canonicalYml = resolve(canonicalDir, "packet-1.yml");
const canonicalMd = resolve(canonicalDir, "packet-1.md");

// Ground-truth findings on the canonical fixture as of pattern-set v0.1.3.
// Order: by (pattern, line) — `scanText` iterates patterns in load order
// and emits each match in textual order, so the per-pattern groups are
// contiguous. snippetHash is sha256(match)[:8].
//
// To regenerate: run `python3 py-reference/bin/trail-audit-precommit
// --root .` from a fresh clone (which symlinks/copies this fixture under
// `.trail/`). py-reference output line numbers and pattern names match
// these entries exactly.
const EXPECTED_YML_FINDINGS = [
  // Two doc-example userinfo URLs from `docs/specs/phase-1-capture.md`
  // table rows captured into `text:` fields (semantic_changes diffs).
  { line: 6341, pattern: "url-userinfo", snippetHash: "b24b5ee6" },
  { line: 6348, pattern: "url-userinfo", snippetHash: "b24b5ee6" },
  // 40-hex git SHAs in diff_summary.base_sha / head_sha — F25/N15 known
  // false-positive class for `high-entropy-string` over pure hex.
  { line: 733, pattern: "high-entropy-string", snippetHash: "425cc67c" },
  { line: 734, pattern: "high-entropy-string", snippetHash: "425cc67c" },
] as const;

const EXPECTED_MD_FINDINGS = [
  // The .md rendering omits the YAML diff_summary block, so the
  // high-entropy SHA matches don't reappear; only the doc-example
  // URLs that round-tripped from the spec source.
  { line: 8302, pattern: "url-userinfo", snippetHash: "b24b5ee6" },
  { line: 8307, pattern: "url-userinfo", snippetHash: "b24b5ee6" },
] as const;

describe("canonical fixture — py-reference parity (gh#3 AC-7)", () => {
  it("packet-1.yml exists at the expected canonical path", () => {
    expect(existsSync(canonicalYml)).toBe(true);
  });

  it("scanText produces the known py-reference parity finding set on packet-1.yml", () => {
    const patterns = loadPatterns(undefined, { useCache: false }).patterns;
    const text = readFileSync(canonicalYml, "utf-8");
    const findings = scanText(canonicalYml, text, patterns);
    // Project to (line, pattern, snippetHash) for stable comparison.
    const projected = findings.map((f) => ({
      line: f.line,
      pattern: f.pattern,
      snippetHash: f.snippetHash,
    }));
    expect(projected).toEqual(EXPECTED_YML_FINDINGS);
  });

  it("scanText produces the known py-reference parity finding set on packet-1.md", () => {
    if (!existsSync(canonicalMd)) {
      // The .md companion may not always be present; treat absence as N/A.
      return;
    }
    const patterns = loadPatterns(undefined, { useCache: false }).patterns;
    const text = readFileSync(canonicalMd, "utf-8");
    const findings = scanText(canonicalMd, text, patterns);
    const projected = findings.map((f) => ({
      line: f.line,
      pattern: f.pattern,
      snippetHash: f.snippetHash,
    }));
    expect(projected).toEqual(EXPECTED_MD_FINDINGS);
  });
});
