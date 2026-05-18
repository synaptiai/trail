import { describe, expect, test } from "vitest";
import { Redactor } from "../src/redaction/layer1.js";
import { scanLayer2, snippetHash } from "../src/redaction/layer2.js";
import { defaultBundledPatternsPath, loadPatterns } from "../src/redaction/patterns.js";

describe("Layer 1 redaction", () => {
  const { patterns, version, origin } = loadPatterns(undefined, { useCache: false });
  test("loaded ≥1 pattern from bundled YAML", () => {
    expect(patterns.length).toBeGreaterThan(0);
    expect(version).toBe("0.1.4");
    expect(origin).toBe("bundled");
  });

  test("redacts a github token", () => {
    const r = new Redactor(patterns);
    const out = r.redact("token=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leaked");
    expect(out).toContain("[REDACTED:github-token]");
    expect(out).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(r.total).toBeGreaterThanOrEqual(1);
    expect(r.counts["github-token"]).toBeGreaterThanOrEqual(1);
  });

  test("redacts an AWS key prefix", () => {
    const r = new Redactor(patterns);
    const out = r.redact("aws AKIAIOSFODNN7EXAMPLE used");
    expect(out).toContain("[REDACTED:aws-access-key]");
  });

  test("does not redact a benign string", () => {
    const r = new Redactor(patterns);
    const text = "simple text without any secrets";
    expect(r.redact(text)).toBe(text);
    expect(r.total).toBe(0);
  });

  test("counts increment per match", () => {
    const r = new Redactor(patterns);
    r.redact(
      "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    );
    expect(r.counts["github-token"]).toBe(2);
    expect(r.total).toBe(2);
  });
});

describe("Layer 2 scan (criterion 6, 6a, 6b, 6c)", () => {
  const { patterns } = loadPatterns(undefined, { useCache: false });

  test("6: catches secret missed by Layer 1 (deliberate Layer-1 bypass)", () => {
    const yamlBytes = "command: 'export TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'\n";
    const errors = scanLayer2(yamlBytes, patterns);
    const names = errors.map((e) => e.pattern);
    expect(names).toContain("github-token");
  });

  test("6a (per-pattern): scan against secret with no markers anywhere", () => {
    for (const p of patterns) {
      // Construct a value matching this pattern.
      let secret: string | null = null;
      switch (p.name) {
        case "github-token":
          secret = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          break;
        case "aws-access-key":
          secret = "AKIAIOSFODNN7EXAMPLE";
          break;
        case "openai-api-key":
          secret = "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          break;
        case "anthropic-api-key":
          secret = "sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          break;
        case "slack-token":
          secret = "xoxb-aaaaaaaaaaaaaaaa";
          break;
        case "google-api-key":
          secret = `AIza${"a".repeat(35)}`;
          break;
        case "npm-token":
          secret = `npm_${"a".repeat(36)}`;
          break;
        case "github-fine-grained-token":
          secret = `github_pat_${"a".repeat(82)}`;
          break;
        default:
          continue;
      }
      const errors = scanLayer2(secret, patterns);
      const found = errors.find((e) => e.pattern === p.name);
      expect(found, `pattern ${p.name} missed its own positive case`).toBeDefined();
    }
  });

  test("6b (literal [REDACTED:fake] adjacent to real secret): real secret still caught", () => {
    const yamlBytes = "[REDACTED:fake-pattern] ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const errors = scanLayer2(yamlBytes, patterns);
    const names = errors.map((e) => e.pattern);
    expect(names).toContain("github-token");
  });

  test("6c (overlapping patterns): both reported", () => {
    // postgres-url pattern matches the connection string; high-entropy-string
    // is a catch-all for ≥40 base64-shape strings (without slash). Use a
    // postgres URL whose password segment contains a long base64-shape string
    // (no slashes). The connection string itself has slashes, but the embedded
    // password section can be matched independently by high-entropy-string.
    const yamlBytes = "url: postgresql://user:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP@db/trail";
    const errors = scanLayer2(yamlBytes, patterns);
    const names = errors.map((e) => e.pattern);
    expect(names).toContain("postgres-url");
    expect(names).toContain("high-entropy-string");
  });

  test("[F16 / 2026-05-09] 6c explicit non-overlapping span: both patterns reported independently", () => {
    // The original 6c test passed because postgres-url and
    // high-entropy-string happened to match overlapping spans; the test
    // didn't assert overlap semantics. Construct a string where the two
    // patterns match DISTINCT, non-overlapping substrings, and assert
    // both are still reported. This pins the "all patterns scan
    // independently" contract.
    const distinctSpan =
      "url: postgresql://u:p@db/trail; key: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP";
    //  └── postgres-url match ────────────┘ └── high-entropy-string match (42 chars) ──┘
    const errors = scanLayer2(distinctSpan, patterns);
    const names = errors.map((e) => e.pattern);
    expect(names).toContain("postgres-url");
    expect(names).toContain("high-entropy-string");

    // Find each finding and verify the matched spans are disjoint.
    const pgFinding = errors.find((e) => e.pattern === "postgres-url");
    const heFinding = errors.find((e) => e.pattern === "high-entropy-string");
    expect(pgFinding).toBeDefined();
    expect(heFinding).toBeDefined();
    // Each finding includes a snippet hash; we test span independence by
    // re-running each pattern's regex over the input and confirming the
    // matched substrings themselves don't overlap.
    const pgPattern = patterns.find((p) => p.name === "postgres-url")!;
    const hePattern = patterns.find((p) => p.name === "high-entropy-string")!;
    const pgMatch = distinctSpan.match(new RegExp(pgPattern.regex.source));
    const heMatch = distinctSpan.match(new RegExp(hePattern.regex.source));
    expect(pgMatch).not.toBeNull();
    expect(heMatch).not.toBeNull();
    const pgEnd = pgMatch!.index! + pgMatch![0].length;
    const heStart = heMatch!.index!;
    expect(heStart).toBeGreaterThanOrEqual(pgEnd);
  });

  test("snippet is exactly 8 hex chars", () => {
    expect(snippetHash("anything")).toMatch(/^[a-f0-9]{8}$/);
    expect(snippetHash("anything").length).toBe(8);
  });
});

// [gh#3 / 2026-05-18] Pure-hex shapes (git SHAs) bypass the
// high-entropy-string rule in both Layer 1 (capture-time replacement)
// and Layer 2 (write-time validation). Other catalog rules retain
// their behavior. See `layer1.ts:isGitShaShape` for the rationale.
describe("[gh#3] git-SHA shapes bypass high-entropy-string", () => {
  const { patterns } = loadPatterns(undefined, { useCache: false });

  test("AC#1 (Layer 1): pure-hex 40-char SHA is not redacted", () => {
    const r = new Redactor(patterns);
    const sha = "abc1234567890abcdef1234567890abcdef12345";
    const out = r.redact(`commit ${sha} message`);
    expect(out).toBe(`commit ${sha} message`);
    expect(r.counts["high-entropy-string"] ?? 0).toBe(0);
    expect(r.total).toBe(0);
  });

  test("AC#1 (Layer 2): pure-hex 40-char SHA produces no validation error", () => {
    const sha = "abc1234567890abcdef1234567890abcdef12345";
    const errors = scanLayer2(`commit ${sha}`, patterns);
    const heFinding = errors.find((e) => e.pattern === "high-entropy-string");
    expect(heFinding).toBeUndefined();
  });

  test("AC#2 (Layer 1): mixed-charset base64-shape still redacted", () => {
    const r = new Redactor(patterns);
    // 42 chars, mixed case alphanumeric — base64-shape, NOT pure hex.
    const blob = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP";
    const out = r.redact(`opaque ${blob} token`);
    expect(out).toContain("[REDACTED:high-entropy-string]");
    expect(r.counts["high-entropy-string"]).toBeGreaterThanOrEqual(1);
  });

  test("AC#2 (Layer 2): mixed-charset base64-shape still flagged", () => {
    const blob = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP";
    const errors = scanLayer2(`opaque ${blob} token`, patterns);
    const heFinding = errors.find((e) => e.pattern === "high-entropy-string");
    expect(heFinding).toBeDefined();
  });

  test("AC#5: short SHA (7-39 chars) is below high-entropy-string's 40-char floor and naturally ignored", () => {
    // The high-entropy-string regex has a 40-char minimum length, so short
    // SHAs are not matched in the first place — the new exclusion is only
    // active for the 40-char boundary case. This test pins that the floor
    // hasn't changed and the SHA exclusion doesn't paper over a regression
    // in the minimum-length contract.
    const r = new Redactor(patterns);
    const shortSha = "abc1234"; // 7 chars
    const out = r.redact(`see ${shortSha} for context`);
    expect(out).toBe(`see ${shortSha} for context`);
  });

  test("anchored secret patterns with hex tails still match (no false negative on aws-secret-key)", () => {
    // AC#3 says: a real hex-shaped secret SHOULD still be redacted if
    // some other catalog rule has anchoring context. `aws-secret-key`
    // requires the `aws_secret_access_key` prefix; the value is 40
    // base64-shape chars. Verify the SHA exclusion does not skip
    // matches from these anchored rules.
    const r = new Redactor(patterns);
    // 40-char pure-hex value with the aws prefix — must still redact.
    const value = "abc1234567890abcdef1234567890abcdef12345";
    const out = r.redact(`aws_secret_access_key=${value}`);
    expect(out).toContain("[REDACTED:aws-secret-key]");
    expect(out).not.toContain(value);
  });

  test("Layer 1 redactBoundary path also excludes git SHAs", () => {
    // LLM-prompt egress (redactBoundary) must apply the same exclusion
    // so SHA-bearing prompts don't get [REDACTED:high-entropy-string]
    // markers that lose code-review fidelity at the LLM boundary.
    const r = new Redactor(patterns);
    const sha = "abc1234567890abcdef1234567890abcdef12345";
    const out = r.redactBoundary(`see commit ${sha} for context`);
    expect(out).toBe(`see commit ${sha} for context`);
  });

  test("multiple SHAs interspersed with a real high-entropy secret: SHAs pass, secret redacted", () => {
    const r = new Redactor(patterns);
    const sha1 = "abc1234567890abcdef1234567890abcdef12345";
    const sha2 = "fed0987654321fedcba0987654321fedcba09876";
    const realSecret = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP";
    const input = `${sha1} log ${sha2} then key=${realSecret}`;
    const out = r.redact(input);
    expect(out).toContain(sha1);
    expect(out).toContain(sha2);
    expect(out).toContain("[REDACTED:high-entropy-string]");
    expect(out).not.toContain(realSecret);
    expect(r.counts["high-entropy-string"]).toBe(1);
  });

  test("AC#5: 40-char uppercase hex also excluded (case-insensitive SHA shape)", () => {
    // git emits lowercase SHAs but humans paste both forms.
    const r = new Redactor(patterns);
    const upperSha = "ABC1234567890ABCDEF1234567890ABCDEF12345";
    const out = r.redact(`commit ${upperSha} message`);
    expect(out).toBe(`commit ${upperSha} message`);
  });
});
