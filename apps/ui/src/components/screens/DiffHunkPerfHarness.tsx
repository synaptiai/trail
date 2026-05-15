import { useEffect, useMemo, useRef } from 'react';
import { DiffTab } from './DiffTab';
import type { DiffSummaryShape, SemanticChangeShape } from '@/services/packet-loader';

/**
 * <DiffHunkPerfHarness> — Sprint 3b perf E2E harness (gh#10 criterion 6).
 *
 * Routed by App.tsx when the URL contains `?perf=diff-hunk-cold |
 * diff-hunk-warm | diff-hunk-stress`. Renders a synthetic 1/5/100-hunk
 * packet via DiffTab and records paint timestamps to
 * `window.__TRAIL_PERF_MEASUREMENTS__` so Playwright can assert against
 * the B3 §15.3 budgets.
 *
 * Strictness contract:
 *   - The harness DISABLES `prewarmHighlighter()` (App.tsx skips the call
 *     when perf mode is set) so the first hunk pays the full cold cost.
 *   - "Paint" is approximated by the next animation frame after the hunk's
 *     region is mounted in the DOM. A more precise measure would require a
 *     PerformanceObserver on the `paint` entry; rAF is the cheapest
 *     stable approximation that catches shiki's async tokenisation.
 *   - Per-hunk paint deltas are recorded by tagging each hunk with a
 *     `data-perf-hunk-id` attribute on its outer region; a MutationObserver
 *     records the first time each id appears.
 *
 * Why a separate harness component (vs. instrumenting DiffTab directly):
 *   The production DiffTab must NOT carry perf-instrumentation overhead.
 *   The harness composes a wrapper that stamps timestamps externally and
 *   leaves DiffTab pure.
 */

declare global {
  interface Window {
    __TRAIL_PERF_MODE__?: { kind: string; hunkCount: number };
    __TRAIL_PERF_MEASUREMENTS__?: {
      firstHunkPaintMs?: number;
      warmHunkPaintsMs?: number[];
    };
  }
}

export type PerfKind = 'diff-hunk-cold' | 'diff-hunk-warm' | 'diff-hunk-stress';

export interface DiffHunkPerfHarnessProps {
  kind: PerfKind;
}

function buildSyntheticDiff(hunkCount: number): DiffSummaryShape {
  const semantic_changes: SemanticChangeShape[] = [];
  for (let i = 0; i < hunkCount; i++) {
    semantic_changes.push({
      id: `DIFF-${String(i + 1).padStart(3, '0')}`,
      description: `Edited src/perf-${i}.ts`,
      files: [`src/perf-${i}.ts`],
      operation: 'edit',
      excerpts: [
        {
          kind: 'before',
          text: `export const value${i} = ${i};\nexport const next${i} = value${i} + 1;`,
          elided: false,
        },
        {
          kind: 'after',
          text: `export const value${i} = ${i + 100};\nexport const next${i} = value${i} + 1;`,
          elided: false,
        },
      ],
    });
  }
  return {
    base_sha: '0'.repeat(40),
    head_sha: '1'.repeat(40),
    files_changed: hunkCount,
    lines_added: hunkCount * 2,
    lines_deleted: hunkCount * 2,
    modules_touched: ['src'],
    semantic_changes,
  };
}

export function DiffHunkPerfHarness({ kind }: DiffHunkPerfHarnessProps) {
  const hunkCount = window.__TRAIL_PERF_MODE__?.hunkCount ?? 1;
  const diff = useMemo(() => buildSyntheticDiff(hunkCount), [hunkCount]);
  const startedAtRef = useRef<number>(performance.now());
  const seenIds = useRef<Set<string>>(new Set());
  const paintTimes = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // Reset timing baseline at mount; this is what we measure paint
    // deltas relative to.
    startedAtRef.current = performance.now();
    if (typeof window !== 'undefined') {
      window.__TRAIL_PERF_MEASUREMENTS__ = {};
    }

    const root = document.querySelector('.diff-hunk-perf-harness');
    if (!root) return;

    /**
     * "Paint" semantics for the perf budget:
     *   We measure the moment shiki's tokens are actually rendered into
     *   the DOM — NOT the moment DiffHunk's outer <section role="region">
     *   appears. DiffHunk paints a placeholder while shiki resolves
     *   asynchronously; if we recorded the placeholder we'd report 1-2ms
     *   times that bypass the cold-start budget the spec actually pins
     *   (B3 §15.3: oniguruma WASM + grammar JSON load).
     *
     *   The signal: a `.diff-hunk__line` with a styled span (shiki tokens
     *   carry `style="color:..."` attributes) inside it. The placeholder
     *   has `.diff-hunk__placeholder` instead.
     */
    const isHunkPainted = (region: HTMLElement): boolean => {
      // Token spans carry a style attribute (color, etc.). Plaintext
      // language returns single-token spans without color, so we ALSO
      // accept any span inside `.diff-hunk__line` (which only mounts
      // post-shiki). The placeholder div is `.diff-hunk__placeholder`.
      return (
        region.querySelector('.diff-hunk__line') !== null &&
        region.querySelector('.diff-hunk__placeholder') === null
      );
    };

    const recordHunk = (region: HTMLElement) => {
      const id = region.getAttribute('aria-label') ?? '';
      if (seenIds.current.has(id)) return;
      // Only record once shiki tokens are in the DOM. The MutationObserver
      // fires for both the initial placeholder mount AND the post-shiki
      // re-render, so we wait for the painted state.
      if (!isHunkPainted(region)) return;
      seenIds.current.add(id);
      requestAnimationFrame(() => {
        const elapsed = performance.now() - startedAtRef.current;
        paintTimes.current.set(id, elapsed);
        const allSorted = [...paintTimes.current.entries()].sort((a, b) => a[1] - b[1]);
        const ordered = allSorted.map(([, t]) => t);
        if (typeof window !== 'undefined') {
          // exactOptionalPropertyTypes (tsconfig.base.json): only set
          // firstHunkPaintMs when ordered has ≥1 entry; otherwise omit
          // the key entirely so the type stays `undefined`-free at the
          // declared property slot.
          window.__TRAIL_PERF_MEASUREMENTS__ = {
            ...(ordered.length > 0 ? { firstHunkPaintMs: ordered[0]! } : {}),
            warmHunkPaintsMs: ordered,
          };
        }
      });
    };

    // Catch hunks already rendered by the time the effect runs.
    const initial = root.querySelectorAll<HTMLElement>('.diff-hunk[role="region"]');
    initial.forEach(recordHunk);

    const observer = new MutationObserver((mutations) => {
      // For each mutation, walk the affected region (or its hunk
      // ancestor) and check the "painted" predicate. We re-walk all
      // existing regions since shiki's setHighlighted fires a re-render
      // that mutates a DESCENDANT (not a fresh region insertion).
      for (const m of mutations) {
        const target = m.target as Element | null;
        if (target instanceof HTMLElement) {
          const region = target.closest<HTMLElement>('.diff-hunk[role="region"]');
          if (region) recordHunk(region);
        }
        m.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (node.classList.contains('diff-hunk') && node.getAttribute('role') === 'region') {
            recordHunk(node);
          }
          // Descendants
          node.querySelectorAll<HTMLElement>('.diff-hunk[role="region"]').forEach(recordHunk);
        });
      }
      // Also re-scan ALL regions on every batch — shiki's re-render
      // replaces the placeholder div in-place, which produces a
      // childList mutation on `.diff-hunk__body` (not on the region
      // itself). The closest() walk above catches most of these, but
      // a periodic re-scan is a cheap belt-and-braces.
      const all = root.querySelectorAll<HTMLElement>('.diff-hunk[role="region"]');
      all.forEach(recordHunk);
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [kind]);

  return (
    <div className="diff-hunk-perf-harness" data-perf-mode={kind}>
      <DiffTab diff_summary={diff} />
    </div>
  );
}
