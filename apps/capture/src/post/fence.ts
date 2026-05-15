// Fenced-section parsing + idempotent update for PR-body integration.
// Spec: docs/specs/phase-2-ui-flows.md §3.4 P3 step 4.
//
// The "trail packet" fenced section is delimited by literal HTML comments:
//   <!-- trail:packet:start -->
//   ...content...
//   <!-- trail:packet:end -->
// HTML comments are chosen because GitHub's PR body is markdown and HTML
// comments do not render visibly to readers — they survive round-trips
// through the gh API and are conventional for marker-based sections.
//
// Markers are LITERAL strings (no whitespace tolerance). This is deliberate:
// a regex with whitespace tolerance creates a footgun where users could write
// `<!--trail:packet:start-->` (no spaces) and we silently drop it / collide.
// Users who edit the markers directly are out of contract; v0.1 owns the
// generation surface and only it should ever produce these markers.

export const FENCE_START = "<!-- trail:packet:start -->";
export const FENCE_END = "<!-- trail:packet:end -->";

export interface FenceSplit {
  hasFence: boolean;
  before: string;
  inner: string;
  after: string;
}

/**
 * Locate the trail-packet fenced section in `body`. If both markers are
 * present in the correct order, return the slices around them. Otherwise
 * return the entire body as `before` with `hasFence=false`.
 *
 * Edge cases handled defensively:
 *   - empty body → hasFence=false, all empty
 *   - start marker only (no end) → hasFence=false (whole body is `before`)
 *   - end appears before start → hasFence=false
 *   - multiple start markers → first wins (deterministic; subsequent markers
 *     pass through as content; users are not expected to embed nested fences)
 */
export function splitFence(body: string): FenceSplit {
  const startIdx = body.indexOf(FENCE_START);
  // SEC-1 (cycle-1 review): search for FENCE_END *after* startIdx, not the
  // first occurrence in the entire body. A PR body containing a stray
  // `<!-- trail:packet:end -->` text BEFORE a real fence (e.g., copy-pasted
  // from a prior trail comment) would otherwise trigger the endIdx<startIdx
  // defensive branch and silently append a duplicate fence — quiet data
  // drift. By scanning forward from startIdx + FENCE_START.length, the real
  // closing marker is found regardless of stray text earlier in the body.
  const endIdx = startIdx === -1 ? -1 : body.indexOf(FENCE_END, startIdx + FENCE_START.length);

  if (startIdx === -1 || endIdx === -1) {
    return { hasFence: false, before: body, inner: "", after: "" };
  }

  const innerStart = startIdx + FENCE_START.length;
  const innerEnd = endIdx;
  const afterStart = endIdx + FENCE_END.length;

  // Strip exactly ONE leading newline after start marker (if present) and
  // ONE trailing newline before the end marker (if present). This makes
  // the inner round-trip clean: updateFence(body, splitFence(body).inner)
  // must equal body.
  let inner = body.slice(innerStart, innerEnd);
  if (inner.startsWith("\n")) inner = inner.slice(1);
  // Note: we do NOT strip the trailing `\n` because the update path
  // canonicalises with exactly one trailing newline — keeping it asymmetric
  // here would cause idempotency to fail. So preserve the raw trailing
  // segment so callers comparing inner can do so exactly.
  return {
    hasFence: true,
    before: body.slice(0, startIdx),
    inner,
    after: body.slice(afterStart),
  };
}

/**
 * Update or insert the trail-packet fenced section. Outside-fence content is
 * preserved exactly. The inner content is canonicalised: exactly one newline
 * after the start marker, exactly one newline between content and end marker,
 * exactly one newline after the end marker if appending to a body that did not
 * already have one.
 *
 * Idempotency property:
 *   updateFence(updateFence(body, x), x) === updateFence(body, x)
 *   updateFence(updateFence(body, x), y) === updateFence(body, y) when the
 *     non-fence content is the same in both invocations.
 */
export function updateFence(body: string, content: string): string {
  // Normalise content: strip exactly one trailing newline if present.
  // Then canonical block always emits as:
  //   <FENCE_START>\n<content>\n<FENCE_END>\n
  let canonContent = content;
  while (canonContent.endsWith("\n")) {
    canonContent = canonContent.slice(0, -1);
  }
  const block = `${FENCE_START}\n${canonContent}\n${FENCE_END}`;

  const split = splitFence(body);

  if (split.hasFence) {
    // Replace existing fenced section in place. Preserve before/after exactly.
    return `${split.before}${block}${split.after}`;
  }

  if (body === "") {
    return `${block}\n`;
  }

  // Append: separate from existing body with a blank line and ensure trailing
  // newline. If body already ends with two newlines, do not add a third.
  const sep = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${sep}${block}\n`;
}
