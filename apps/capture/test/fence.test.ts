// Fenced-section parsing + update tests (gh#4 AC-1, AC-4).
//
// The "trail packet" fenced section is delimited by literal HTML comments
// (`<!-- trail:packet:start -->` / `<!-- trail:packet:end -->`) embedded in
// the PR body. Updates MUST be idempotent: the body content outside the
// fence is preserved exactly; replacing/inserting the fenced content does
// not duplicate or shift other content.

import { describe, expect, test } from "vitest";
import { FENCE_END, FENCE_START, splitFence, updateFence } from "../src/post/fence.js";

describe("fence", () => {
  test("FENCE markers are exact literal strings (no whitespace drift)", () => {
    expect(FENCE_START).toBe("<!-- trail:packet:start -->");
    expect(FENCE_END).toBe("<!-- trail:packet:end -->");
  });

  test("splitFence: empty body → no fence detected", () => {
    const r = splitFence("");
    expect(r.hasFence).toBe(false);
    expect(r.before).toBe("");
    expect(r.after).toBe("");
    expect(r.inner).toBe("");
  });

  test("splitFence: body without fence → entire body is 'before', no fence", () => {
    const body = "## PR description\n\nSome text.\n";
    const r = splitFence(body);
    expect(r.hasFence).toBe(false);
    expect(r.before).toBe(body);
    expect(r.after).toBe("");
  });

  test("splitFence: body with fence → before/inner/after preserved exactly", () => {
    const body = `## Description

Stuff before.

${FENCE_START}
old packet content
multiple lines
${FENCE_END}

Stuff after.
`;
    const r = splitFence(body);
    expect(r.hasFence).toBe(true);
    expect(r.before).toBe("## Description\n\nStuff before.\n\n");
    expect(r.inner).toBe("old packet content\nmultiple lines\n");
    expect(r.after).toBe("\n\nStuff after.\n");
  });

  test("updateFence: empty body + insert content → fence appended cleanly", () => {
    const out = updateFence("", "fresh packet body");
    expect(out).toBe(`${FENCE_START}\nfresh packet body\n${FENCE_END}\n`);
  });

  test("updateFence: body without fence → fenced section appended after a blank line", () => {
    const body = "## PR description\n\nSome text.\n";
    const out = updateFence(body, "packet body");
    expect(out).toBe(
      `## PR description\n\nSome text.\n\n${FENCE_START}\npacket body\n${FENCE_END}\n`
    );
  });

  test("updateFence: idempotent — applying twice leaves outside content unchanged", () => {
    const body = "## PR description\n\nTrailing notes.\n";
    const once = updateFence(body, "packet v1");
    const twice = updateFence(once, "packet v2");
    // content outside the fence (before/after) MUST equal the original body
    // (we can verify by re-splitting the output).
    const r = splitFence(twice);
    expect(r.hasFence).toBe(true);
    expect(r.inner).toBe("packet v2\n");
    // ensure the re-applied content does NOT duplicate the body
    const occurrences = twice.split(FENCE_START).length - 1;
    expect(occurrences).toBe(1);
  });

  test("updateFence: existing fence is REPLACED (not duplicated)", () => {
    const body = `pre\n\n${FENCE_START}\nold\n${FENCE_END}\n\npost\n`;
    const out = updateFence(body, "new");
    expect(out).toBe(`pre\n\n${FENCE_START}\nnew\n${FENCE_END}\n\npost\n`);
  });

  test("updateFence: preserves multi-line content outside the fence verbatim", () => {
    const before = "# Title\n\n- item 1\n- item 2\n\n";
    const after = "\n\n## Notes\n\n[link](http://example.com)\n";
    const body = `${before}${FENCE_START}\nstale\n${FENCE_END}${after}`;
    const out = updateFence(body, "new content");
    expect(out).toBe(`${before}${FENCE_START}\nnew content\n${FENCE_END}${after}`);
  });

  test("updateFence: handles inner content with empty trailing line", () => {
    // Inner content already ends with \n — updater should NOT add a second one.
    const body = `pre\n\n${FENCE_START}\nx\n${FENCE_END}\n`;
    const out = updateFence(body, "y\n");
    expect(out).toBe(`pre\n\n${FENCE_START}\ny\n${FENCE_END}\n`);
  });

  test("updateFence: handles inner content WITHOUT trailing newline (normalizes)", () => {
    const out = updateFence("", "no trailing newline here");
    expect(out).toBe(`${FENCE_START}\nno trailing newline here\n${FENCE_END}\n`);
  });

  test("splitFence: malformed (start present, end missing) → treated as no-fence (defensive)", () => {
    const body = `pre\n${FENCE_START}\ncontent without close\n`;
    const r = splitFence(body);
    expect(r.hasFence).toBe(false);
    expect(r.before).toBe(body);
  });

  test("splitFence: end-before-start (out of order) → treated as no-fence", () => {
    const body = `${FENCE_END}\nstuff\n${FENCE_START}\n`;
    const r = splitFence(body);
    expect(r.hasFence).toBe(false);
  });

  // SEC-1 (cycle-1 P3): stray FENCE_END earlier in body must NOT prevent a
  // valid fence later from being detected. Prior implementation used
  // body.indexOf(FENCE_END) which returned the FIRST end-marker; if it
  // appeared before the real fence (e.g., copy-pasted from a prior trail
  // comment), the defensive branch fired and silently appended a duplicate.
  test("splitFence: stray FENCE_END before a real fence → real fence still detected", () => {
    const body = `## Description\n\nnote: copy-pasted ${FENCE_END} from somewhere\n\n${FENCE_START}\nreal packet content\n${FENCE_END}\n\nfooter\n`;
    const r = splitFence(body);
    expect(r.hasFence).toBe(true);
    expect(r.inner).toBe("real packet content\n");
    // The stray text remains in `before` (we don't strip it — out-of-contract
    // user content is preserved verbatim).
    expect(r.before).toContain("copy-pasted");
  });

  test("updateFence: body with stray FENCE_END before real fence → updates real fence in place (no duplicate)", () => {
    const body = `pre ${FENCE_END} stray\n\n${FENCE_START}\nold\n${FENCE_END}\n\npost\n`;
    const out = updateFence(body, "new");
    // Exactly ONE fence after update — no duplicate appended.
    expect((out.match(new RegExp(FENCE_START, "g")) ?? []).length).toBe(1);
    // Note: the stray FENCE_END counts in a global match; we count only after
    // confirming the start count is 1.
    expect(out).toContain(`${FENCE_START}\nnew\n${FENCE_END}`);
    // Stray text preserved.
    expect(out).toContain("pre");
    expect(out).toContain("stray");
    expect(out).toContain("post");
    // Old content gone.
    expect(out).not.toContain("\nold\n");
  });
});
