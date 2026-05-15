import { DiffHunk, type DiffHunkLine, EmptyState } from '@/components/primitives';
import { inferLanguage, type HighlightLanguage } from '@/services/highlight';
import type {
  DiffSummaryShape,
  ExcerptShape,
  SemanticChangeShape,
} from '@/services/packet-loader';
import './DiffTab.css';

/**
 * <DiffTab> — Sprint 3b (gh#10 criteria 1, 2; B4 §4.5).
 *
 * Renders the Diff tab body inside the four-tab packet view. Iterates
 * `diff_summary.semantic_changes` and shows one `<DiffHunk>` per entry.
 * Language is inferred from `files[0]` via the `inferLanguage` map; unknown
 * extensions degrade to plaintext rather than guessing.
 *
 * Excerpt → DiffHunkLine mapping (locked v0.1.1):
 *   - operation === "write"       → all excerpts render as additions (+).
 *   - operation === "edit"        → before/after excerpts pair to -/+ lines
 *                                   (multi-line excerpts split on \n).
 *   - operation === "multiedit"   → before#N/after#N hunks are paired by
 *                                   the trailing #N suffix; up to 5 hunks
 *                                   per schema.
 *
 * Performance notes (B3 §15.3):
 *   - The first DiffHunk paints triggers shiki cold-start (≤ 250ms budget),
 *     but Sprint 1's <App> mount-time prewarmHighlighter() generally pays
 *     this cost before the user reaches the Diff tab.
 *   - Subsequent same-language hunks share the warm tokenizer (≤ 30ms budget).
 *   - 100-claim packets are exercised by the perf E2E (sidebar-stress is
 *     scoped to TrailSidebar; diff-hunk-stress is the Sprint 3b deliverable).
 */

export interface DiffTabProps {
  diff_summary: DiffSummaryShape;
}

export function DiffTab({ diff_summary }: DiffTabProps) {
  const changes = diff_summary.semantic_changes;

  if (changes.length === 0) {
    return (
      <EmptyState
        variant="full"
        headline="No code changes captured."
        body="This packet has zero entries in diff_summary.semantic_changes. Either no Edit/Write/MultiEdit tool calls fired during the session, or capture filtered them out."
      />
    );
  }

  return (
    <div className="diff-tab" aria-label="Diff hunks">
      <header className="diff-tab__header type-mono-sm">
        <span>{diff_summary.files_changed} file(s)</span>
        <span aria-hidden="true">·</span>
        <span className="diff-tab__additions">+{diff_summary.lines_added}</span>
        <span aria-hidden="true">·</span>
        <span className="diff-tab__deletions">−{diff_summary.lines_deleted}</span>
      </header>
      <div className="diff-tab__hunks">
        {changes.map((change) => (
          <DiffHunkSection key={change.id} change={change} />
        ))}
      </div>
    </div>
  );
}

interface DiffHunkSectionProps {
  change: SemanticChangeShape;
}

function DiffHunkSection({ change }: DiffHunkSectionProps) {
  const file = change.files[0] ?? '(unknown file)';
  const language: HighlightLanguage = inferLanguage(file);
  const lines = excerptsToHunkLines(change);
  // Surface the DIFF-NNN id alongside the operation in a stable, query-able
  // wrapper so tests can locate the id as a single text node and screen
  // readers receive an unbroken pronunciation. The DIFF-NNN id is the
  // cross-reference key for claim → diff via evidence_refs (schema/$defs/
  // evidence_ref); reviewers rely on it visually.
  const header = (
    <>
      <span className="diff-tab__hunk-id">{change.id}</span>
      {' · '}
      <span className="diff-tab__hunk-op">{change.operation}</span>
    </>
  );
  return (
    <DiffHunk
      path={file}
      language={language}
      header={header}
      lines={lines}
    />
  );
}

/**
 * Map a semantic_change's excerpts to a DiffHunkLine[]. Centralized so the
 * DiffHunk's +/- gutter contract is the single source of truth.
 *
 * Locked enum semantics (schema/$defs/excerpt.kind):
 *   - "write" + "after"          → additions for every line of the excerpt
 *   - "edit"  + "before"         → removals
 *   - "edit"  + "after"          → additions
 *   - "multiedit" + "before#N"   → removals (paired with after#N to the
 *                                  same hunk; we render N before-N after).
 *   - "multiedit" + "after#N"    → additions
 *
 * For a write op the schema only emits "after" (no "before"); for edit
 * either or both may be present. Per B3 §12.2 the +/- characters are the
 * color-independent diff cue, so missing the kind metadata would degrade
 * legibility for users who can't perceive color.
 */
export function excerptsToHunkLines(change: SemanticChangeShape): DiffHunkLine[] {
  if (change.operation === 'multiedit') {
    return multiEditHunkLines(change.excerpts);
  }
  // write / edit — group all "before*" excerpts as removals, all "after*"
  // as additions, in source order. The schema does NOT promise a strict
  // before-then-after sequence so we explicitly partition then concatenate
  // (removals first, then additions; this matches `git diff`'s convention).
  const removals: DiffHunkLine[] = [];
  const additions: DiffHunkLine[] = [];
  for (const ex of change.excerpts) {
    const kind = excerptKind(ex);
    const target = kind === '-' ? removals : additions;
    for (const lineText of splitExcerpt(ex.text)) {
      target.push({ kind, content: lineText });
    }
    // Surface elision honestly so the user knows the excerpt was clipped
    // — without this the diff reads as "complete" when it isn't.
    if (ex.elided) {
      target.push({ kind: ' ', content: '… [excerpt clipped during capture; see Settings → Redaction → preview]' });
    }
  }
  return [...removals, ...additions];
}

/**
 * MultiEdit pairing: kinds are "before#1", "after#1", "before#2", ...
 * We pair by N and emit each pair as (before lines, after lines) in N-order.
 * Hunks beyond #5 are silently dropped per the schema.
 */
function multiEditHunkLines(excerpts: ExcerptShape[]): DiffHunkLine[] {
  const byN = new Map<number, { before?: ExcerptShape; after?: ExcerptShape }>();
  for (const ex of excerpts) {
    const m = /^(before|after)#(\d+)$/.exec(ex.kind);
    if (!m) continue;
    const n = parseInt(m[2]!, 10);
    if (n < 1 || n > 5) continue;
    const slot = byN.get(n) ?? {};
    if (m[1] === 'before') slot.before = ex;
    else slot.after = ex;
    byN.set(n, slot);
  }
  const sortedNs = [...byN.keys()].sort((a, b) => a - b);
  const out: DiffHunkLine[] = [];
  for (const n of sortedNs) {
    const slot = byN.get(n)!;
    if (slot.before) {
      for (const lineText of splitExcerpt(slot.before.text)) {
        out.push({ kind: '-', content: lineText });
      }
      if (slot.before.elided) {
        out.push({ kind: ' ', content: '… [excerpt clipped during capture]' });
      }
    }
    if (slot.after) {
      for (const lineText of splitExcerpt(slot.after.text)) {
        out.push({ kind: '+', content: lineText });
      }
      if (slot.after.elided) {
        out.push({ kind: ' ', content: '… [excerpt clipped during capture]' });
      }
    }
  }
  return out;
}

function excerptKind(ex: ExcerptShape): '+' | '-' {
  // Sprint 3b: "before"/"before#N" → -; "after"/"after#N" → +.
  // Cycle-1 self-review F2 — explicit positive case rather than
  // permissive default. A future schema kind that doesn't start with
  // either prefix would now be a runtime hint rather than silently
  // rendering as +. The schema's locked enum (write/edit/multiedit
  // operations + before/after/before#N/after#N kinds) means this is
  // a defensive guardrail today.
  if (ex.kind.startsWith('before')) return '-';
  if (ex.kind.startsWith('after')) return '+';
  // Unknown kind — log and treat as addition. The DiffHunk's +/- gutter
  // is the color-independent diff cue (B3 §12.2); rendering as a
  // context line ' ' would lose the addition-or-removal distinction
  // entirely. Defaulting to + matches schema.write semantics.
  console.warn(`[Trail] DiffTab: unknown excerpt.kind="${ex.kind}"; defaulting to addition.`);
  return '+';
}

function splitExcerpt(text: string): string[] {
  if (text.length === 0) return [''];
  // Schema permits embedded \n. CRLF is normalised so the split lines up
  // with the highlighter's tokenization (services/highlight.ts does the
  // same normalisation when computing token rows).
  return text.replace(/\r\n/g, '\n').split('\n');
}
