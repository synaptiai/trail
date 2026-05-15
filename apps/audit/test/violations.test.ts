// Violation reporting tests — gh#3 acceptance criterion 3 (structured output).
//
// Verifies:
//   - Text mode: human-readable lines with `pattern=<name>  hash=<8hex>`,
//     banner header, summary footer with override hint.
//   - JSON mode: NDJSON, one well-formed object per line, snake_case keys
//     `{file, line, pattern, snippet_hash}`, no banner, no footer.
//   - SAFETY: NEVER includes the raw match — only sha256[:8] hash.

import { describe, expect, it } from "vitest";
import type { Finding } from "../src/scanner.js";
import { reportViolations } from "../src/violations.js";

function mkFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "/repo/.trail/sessions/abc/packet-1.yml",
    line: 42,
    pattern: "github-token",
    snippetHash: "ab12cd34",
    ...overrides,
  };
}

function captureWrites(): { write: (s: string) => void; output: () => string } {
  const buf: string[] = [];
  return {
    write: (s: string) => buf.push(s),
    output: () => buf.join(""),
  };
}

describe("reportViolations — text mode", () => {
  it("emits FAIL banner + per-finding line + summary footer", () => {
    const { write, output } = captureWrites();
    reportViolations([mkFinding()], { mode: "text", write, baseDir: "/repo" });
    const text = output();
    expect(text).toContain("[trail-audit] FAIL");
    expect(text).toContain(".trail/sessions/abc/packet-1.yml:42");
    expect(text).toContain("pattern=github-token");
    expect(text).toContain("hash=ab12cd34");
    expect(text).toContain("1 finding(s) across 1 file(s)");
    expect(text).toContain("git commit --no-verify");
  });

  it("counts unique files across multiple findings", () => {
    const { write, output } = captureWrites();
    reportViolations(
      [
        mkFinding({ file: "/repo/.trail/sessions/a/packet-1.yml", line: 10 }),
        mkFinding({ file: "/repo/.trail/sessions/a/packet-1.yml", line: 11 }),
        mkFinding({ file: "/repo/.trail/sessions/b/packet-1.yml", line: 5 }),
      ],
      { mode: "text", write, baseDir: "/repo" }
    );
    expect(output()).toContain("3 finding(s) across 2 file(s)");
  });

  it("renders paths relative to baseDir when contained", () => {
    const { write, output } = captureWrites();
    reportViolations([mkFinding()], { mode: "text", write, baseDir: "/repo" });
    expect(output()).toContain(".trail/sessions/abc/packet-1.yml");
    expect(output()).not.toContain("/repo/.trail/");
  });

  it("falls back to absolute path when baseDir is upstream of file", () => {
    const { write, output } = captureWrites();
    reportViolations([mkFinding({ file: "/elsewhere/packet-1.yml" })], {
      mode: "text",
      write,
      baseDir: "/repo",
    });
    // The relative form would start with '..' — reporter falls back to absolute.
    expect(output()).toContain("/elsewhere/packet-1.yml");
  });

  it("never surfaces raw-secret-shape strings", () => {
    // Construct a finding whose hash field is a recognizable hex digest;
    // the reporter MUST emit only the digest, not any raw secret.
    const { write, output } = captureWrites();
    reportViolations([mkFinding({ snippetHash: "deadbeef" })], {
      mode: "text",
      write,
      baseDir: "/repo",
    });
    expect(output()).toContain("hash=deadbeef");
    // Ensure the reporter never emits a `match=` token (the py-reference
    // form that includes the raw 60-char snippet) — Layer 3 spec §5 SEC-9
    // requires hash-only output.
    expect(output()).not.toContain("match=");
  });
});

describe("reportViolations — JSON mode", () => {
  it("emits NDJSON with snake_case keys", () => {
    const { write, output } = captureWrites();
    reportViolations([mkFinding()], { mode: "json", write, baseDir: "/repo" });
    const lines = output()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed).toEqual({
      file: ".trail/sessions/abc/packet-1.yml",
      line: 42,
      pattern: "github-token",
      snippet_hash: "ab12cd34",
    });
  });

  it("emits one JSON object per line for multiple findings", () => {
    const { write, output } = captureWrites();
    reportViolations(
      [
        mkFinding({ line: 1, pattern: "github-token" }),
        mkFinding({ line: 2, pattern: "openai-api-key", snippetHash: "11112222" }),
      ],
      { mode: "json", write, baseDir: "/repo" }
    );
    const lines = output()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    const a = JSON.parse(lines[0] ?? "{}");
    const b = JSON.parse(lines[1] ?? "{}");
    expect(a.pattern).toBe("github-token");
    expect(b.pattern).toBe("openai-api-key");
    expect(b.snippet_hash).toBe("11112222");
  });

  it("emits no banner / no footer in JSON mode (line-per-record contract)", () => {
    const { write, output } = captureWrites();
    reportViolations([mkFinding()], { mode: "json", write, baseDir: "/repo" });
    expect(output()).not.toContain("FAIL");
    expect(output()).not.toContain("finding(s)");
    expect(output()).not.toContain("--no-verify");
  });

  it("emits zero output for empty findings list", () => {
    const { write, output } = captureWrites();
    reportViolations([], { mode: "json", write, baseDir: "/repo" });
    expect(output()).toBe("");
  });
});
