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
