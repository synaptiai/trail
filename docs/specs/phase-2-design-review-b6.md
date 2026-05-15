## Lens 1 — UX coherence

**Reviewer**: B6 design review, UX lens (story / persona / scenario / screen coherence and user-facing friction).
**Scope**: B1 stories, B2 flows, B3 design system, B4 screens, B5 architecture reconciliation. Read against `.claude/canvas/scenarios.yml` (scn-001..007) and `.claude/canvas/jobs-to-be-done.yml#job-001..job-003`.
**Out of scope**: tokens / fonts / Tauri stack / libSQL schema correctness / IPC allowlist / WCAG-ARIA correctness / AB items already in B5 §8 / v0.2+ scope.
**Method**: trace each B1 story to its B2 flow and B4 screen; walk scn-001..007 against flows; surface friction, modality mismatches, and mode/state-coverage gaps.

The spec stack is unusually tight — the §7 traceability matrix in B2 closes (24/24 with one intentional empty), and B5 demonstrates that all but five AB items are now structurally resolved at the libSQL or saga layer. This review finds **no coverage gaps** at the story-to-flow level. The findings below concentrate on (a) friction inside golden paths the spec does deliver, (b) mode-and-state corners that are described in prose but not yet pinned down on screens, and (c) two cognitive-load reductions worth applying before build.

Findings count: **P1 = 1, P2 = 7, P3 = 4** (12 total).

Overall: **specs are tight on coverage; the remaining work is friction-trim and a handful of clarifications that will save Sprint 4 from re-spec.** No coherence gap blocks Phase 2 build; the one P1 is a missing onboarding affordance for the GitHub-only reviewer arrival mode (J6) that the spec describes but does not actually screen-spec.

---

### P1 — GitHub-only reviewer (no Trail installed) has no rendered fallback for the deep-drilldown link

**Where**: `phase-2-ui-flows.md:§4.1 (J6 "v0.1 limitation")`; `phase-2-screen-specs.md:§4.6` covers only the in-Tauri reviewer.
**Issue**: J6 acknowledges drive-by OSS contributors will not have Tauri installed and the markdown is their only surface, but neither B2 nor B4 specs what happens when the `trail://` link is clicked with no app registered — on macOS/Linux, that's a silent no-op or generic OS error.
**Why it matters**: scn-003 (Maya, on a phone, `failure_state: "Tauri not installed at all"`) is marked "doable for v0.1," but doable requires the markdown to be self-sufficient when the deep-drilldown is dead. Phase 2 is where this gets decided — defaulting to "click `trail://` and pray" makes job-002.firing_criteria fire ("I have to leave the review tool to verify a claim").
**Suggested fix**: Add to B4 §6 a markdown-fallback spec for the `trail://` link: `[deep drilldown ↗](trail://...) — requires Trail desktop app · [install](https://...)`. For J6's "high-risk claim — needs deep review" branch, also commit now to a GitHub-Files-Changed URL-fragment fallback (`#diff-<hash>L<line>`) so an evidence link still works without Tauri.
**Confidence**: high.

---

### P2 — Mode resolution (creator/reviewer/audit) is under-specified for the J6→J7 arrival path

**Where**: `phase-2-screen-specs.md:§1.4 (routing)`, `§4.6` (Reviewer mode); `phase-2-ui-flows.md:§2.2 / §2.3` (URL handler).
**Issue**: B4 §1.4 says modes are selected via `?mode=creator|reviewer|audit`, but B2 §2.2's URL handler form is `trail://packet/<id>?focus=<claim-id>` — no mode param. Where does `mode=reviewer` come from? The YAML carries no current-user role. If hardcoded by arrival path, scn-005 (Daniel resuming his own session) and scn-007 (Riya intending audit) can land in the wrong mode.
**Why it matters**: scn-004 (Aman drilling in) and scn-007 (Riya auditing) need different modes. If audit mode is auto-entered or never-entered, Riya sees "Sync decisions to PR" buttons on a read-only audit, undermining job-003.hiring_criteria ("trail as institutional answer").
**Suggested fix**: Pin in B4 §1.4: (a) settings stores per-user default (creator if `created_by` matches user; reviewer if not); (b) Phase 3b markdown emits explicit `?mode=reviewer` in deep-drilldown URLs; (c) trail-browser clicks honor user default; (d) audit mode is a deliberate toggle (`⌥+a` in §9), never auto-entered.
**Confidence**: high.

---

### P2 — Carry-forward suggestion UX (J2 / scn-002) buries the "what changed" affordance in a one-line summary

**Where**: `phase-2-ui-flows.md:§3.2 (J2 step 8–10)`; `phase-2-screen-specs.md:§4.4 (Carry-forward panel)`.
**Issue**: B4 renders the carry-forward as one collapsible bar: `8 claims unchanged · 4 prior decisions to apply`. It doesn't show which claims are new vs carried, and "unchanged" is an assertion the user must trust. scn-002.failure_state explicitly worries about "subtly different claims" carrying forward wrongly.
**Why it matters**: This is the highest-frequency loop in the dogfood path; friction compounds. job-001.firing_criteria fires on "doesn't add ceremony to the dogfood loop" — a summary that hides what's new drives either trust-and-LGTM or a manual YAML diff.
**Suggested fix**: 3-column inline summary (`✓ 3 unchanged · ⊕ 2 new · ⊖ 0 removed`) and prefix each claim row in the list with `↻` (carryover, decision applied), `⊕` (new), or unprefixed (carryover needing review). Trailing badge slot next to the risk glyph keeps the layout cost zero.
**Confidence**: high.

---

### P2 — M1 risk-override modal wireframe missing the reviewer-mode three-row variant

**Where**: `phase-2-screen-specs.md:§7.1 (M1 modal)`.
**Issue**: §7.1's wireframe shows two rows (Agent + Your override). Trailing prose says reviewer mode shows three rows (agent → creator → your override), but engineering builds the wireframe, not the prose. J3 (creator) needs two rows; J8 (reviewer) needs three.
**Why it matters**: scn-004 (Aman overriding HIGH after creator Priya's MED override) — if M1 collapses creator's override into "agent classification," Aman writes his reason against the wrong baseline, confusing the trail. B3 §4.4 specs the three-layer stacked-dot visual on claim rows; the modal must mirror it.
**Suggested fix**: Add an M1-Reviewer wireframe in §7.1 mirroring §4.4's stacked-dot pattern: Agent (read-only), Creator override (read-only with reason text), Your override (interactive). Or annotate the existing wireframe with `{reviewer mode: insert Creator row}`.
**Confidence**: high.

---

### P2 — Empty + filter-active state combination is missing from B4 §3.6

**Where**: `phase-2-screen-specs.md:§3.6 (Trail sidebar states)`.
**Issue**: B4 §3.6 lists Empty / Loading / Error / Filtered-no-results as orthogonal. Real combinations are missing: empty trail + filter pre-applied; loading + active filter; error + previously-active filter. scn-007 (Riya pinning HIGH+Q2 filter, then opening a fresh `.trail/`) lands on "no matches" instead of "no packets yet."
**Why it matters**: First-impression states for the auditor flow drive job-003.emotional ("trust that 'the trail says X' is dispositive") — landing on misleading copy erodes trust on first interaction.
**Suggested fix**: Add a state-combination matrix to §3.6 with copy for: empty+filter ("No packets captured yet. Filter active — clear to confirm."), loading+filter (skeleton with dimmed filter chips), error+filter (retry preserves filter). Apply same pattern to "Your recent sessions" pin.
**Confidence**: medium.

---

### P2 — "Post to PR" has no markdown preview before posting; CR-GH-01 acceptance is silent on it

**Where**: `phase-2-ui-stories.md:§3.4 (CR-GH-01)`; `phase-2-screen-specs.md:§7.4 (M4)`.
**Issue**: M4 only shows PR number + confirm. Re-post (CR-GH-02 / J5) has a "diff vs. last post" view but the first post does not. CR-GH-01 acceptance bullets don't mention previewing the markdown.
**Why it matters**: scn-001 — Daniel posting on a public OSS repo, "packet visible to potential collaborators" — should see the rendered markdown once before it lands. F1 Part B v2 established markdown render as the primary surface; not previewing it before public post regresses that learning. The first time Daniel sees any gap between Phase 2's claim-list and Phase 3b's markdown render is when his PR body looks wrong.
**Suggested fix**: Add a collapsible Preview section to M4 (default-collapsed; `g` keyboard shortcut still posts directly for power users). Render via Phase 3b `trail packet post --dry-run`. Add to CR-GH-01 acceptance: "post preview is visible before confirm."
**Confidence**: high.

---

### P2 — Keyboard shortcut count (19) exceeds first-run discoverability budget

**Where**: `phase-2-screen-specs.md:§9`.
**Issue**: 19 shortcuts is a lot. `j/k`, `n/p`, and `↑/↓` give three overlapping claim-navigation modes; `Space/Enter` adds a fourth for expand. GitHub's PR view ships ~8 shortcuts.
**Why it matters**: scn-001 (Daniel) uses all; scn-004 (Aman, junior, unfamiliar code) is cognitively overloaded. job-002.firing_criteria fires on flow-break — "wait, was it n or j?" is that break. The `?` overlay becomes long enough to need a search input — sign of over-supply.
**Suggested fix**: Drop `n/p` (subsumed by `j/k` after filter); drop `[/]` (use sidebar click + ⌘+arrow); drop `Shift+a` (panel button is one click). New count ~13. Defer dropped ones to "v0.2 power-user." Keep `?` overlay but pin a "Most-used" section showing 5 essentials (`j k a c b`) — that's what new users actually read.
**Confidence**: medium.

---

### P2 — First-run covers only "no packets"; the first-packet-open onboarding gap is unaddressed

**Where**: `phase-2-screen-specs.md:§5`; `phase-2-ui-flows.md:§2.1` Branch A.
**Issue**: B4 §5 handles empty `.trail/`. The user who runs `trail packet generate`, has the watcher miss (scn-001.failure_state), then opens Tauri cold gets the trail browser with one packet — but no onboarding to the four-tab structure (Claims / Diff / Redaction / Trail) on first open. They must discover tabs.
**Why it matters**: scn-001's success path (first time anyone uses Trail, founder demoing to OSS contributor) is less smooth than it could be. A small first-packet coachmark is not ceremony — it's reduction of discovery cost.
**Suggested fix**: Add §5.5 "First-packet-open" sub-spec: when trail has exactly 1 packet AND it has no decisions, show a one-time `--type-body-sm` strip in the packet header: "Tabs: claims, diff, redaction, trail. `j/k` to navigate · `a` to accept." Dismissible; auto-dismisses after first decision; never re-shows.
**Confidence**: medium.

---

### P3 — M3 redaction preview's 30-second timer is uncalibrated and cuts mid-read

**Where**: `phase-2-screen-specs.md:§7.3`.
**Issue**: 30s auto-dismiss is a magic number; B3 OQ-B3-6 calibrated the heavy-redaction threshold (15) but not preview duration. Users reading a multi-line snippet get cut off mid-read.
**Why it matters**: Affects only the opt-in power-user cohort (default OFF), but the cut-off may drive them to disable preview entirely.
**Suggested fix**: Configurable in Settings → Redaction (15s/30s/60s/explicit-dismiss; default 30s). Add an "extend 30s" inline button that resets the timer once.
**Confidence**: low.

---

### P3 — M5 re-capture drift and M6 settings are mis-modeled as modals

**Where**: `phase-2-screen-specs.md:§7.5, §7.6`.
**Issue**: M5 forces a binary choice ("treat as separate" vs "force carry-forward") before the user has seen the packet content that should inform that choice. M6 is a 720px/80vh modal with internal tab navigation — effectively a screen rendered as a modal.
**Why it matters**: scn-002 hits M5 every uncertain re-capture; upfront-binary-modal interrupts the dogfood loop.
**Suggested fix**: M5 → inline banner on packet view (like E5): "Session detected but claims diverged. [Treat as separate] [Force carry-forward]." Lets user see content first. M6 → leave as modal in v0.1 (defer route conversion to v0.2+); document as known compromise.
**Confidence**: low.

---

### P3 — `<RiskDistribution>` per-claim glyph row over-specifies; histogram reads better

**Where**: `phase-2-screen-specs.md:§4.2`.
**Issue**: B4 §4.2 specs one inline glyph per claim above the horizon. For a 50-claim packet that's 50 glyphs across 1080px — noisy and sparse. CR-UI-03 acceptance only needs the count histogram, not per-claim x-positions.
**Why it matters**: scn-001 (12 claims) works; scn-004 (28) gets cluttered; 80-claim packets become unreadable.
**Suggested fix**: Render as a 4-bin histogram with width proportional to count (`▮▮▮▮▮▮▮ ▮▮▮ ▮` for 7 LOW + 3 MED + 1 HIGH). Hover still cross-links to rows. Trims one application of the horizon motif without touching the brand mark.
**Confidence**: low.

---

### P3 — Audit mode's Trail-tab empty state is unspecified; "no approvals on HIGH packet" should be loud signal

**Where**: `phase-2-screen-specs.md:§4.7`.
**Issue**: Audit mode promotes Trail tab to default. For a packet with 0 approval-trail entries (abandoned mid-flow), the tab is empty. scn-007 (Riya filtering HIGH-risk Q2) might land on this if a HIGH packet was captured but never reviewed.
**Why it matters**: For the auditor, "no approvals on a HIGH-risk packet" IS the audit finding. Treating it as a blank tab loses signal.
**Suggested fix**: Add to §4.7: when Trail tab is empty in audit mode AND packet risk ≥ HIGH, render "No approval decisions recorded. Audit-relevant: HIGH-risk packet without recorded approval." Otherwise: "No approval decisions recorded for this packet."
**Confidence**: low.

---

**End of Lens 1.**

---

## Lens 2 — Design execution & feasibility

**Reviewer**: B6 design review, design-execution lens (token-discipline, aesthetic execution, brand consistency, performance feasibility).
**Scope**: B3 (primary), B4 (primary); B1/B2/B5 only where execution leaks across boundaries.
**Out of scope**: UX coherence (Lens 1); architecture / IPC / libSQL / WCAG-contrast verification (Lens 3); AB items in B5 §8; Phase 1.
**Method**: walk B3's commitments (Forensic Instrument three pillars; tokens; horizon in 6 places; primitive list; perf budgets) against B4's wireframes, composition table (§11), and sprint plan (§13.1).

Findings concentrate on (a) **token-discipline leaks** in B4 wireframes (raw px, unsourced shapes), (b) **horizon-line under-delivery** (6 commitments, 4 actually wired), (c) gap between B3's primitive list and B4's screen-level dependencies, (d) one perf budget that is optimistic given the chosen tech.

Findings count: **P1 = 2, P2 = 8, P3 = 4** (14 total).

Overall: **the design system is strong and the screens largely honor it; gaps are execution-layer, not direction.** Two P1s — a missing primitive (`<Tabs>`) screens lean on but B3 never promised, and a 50ms diff-hunk budget unrealistic for shiki cold-start. Both are catchable in Sprint 1/3 with small spec amendments.

---

### P1 — `<Tabs>` primitive consumed by B4 §4.3 but never declared in B3 §15.2

**Where**: `phase-2-design-system.md:§15.2`; `phase-2-screen-specs.md:§4.3, §7.6, §11`.
**Issue**: B4 §4.3 specifies a four-tab packet view (Claims · Diff · Redaction · Trail) with "1px copper underline on active." B4 §11's 15 screen-level components don't list `<Tabs>` and B3 §15.2's 10 primitives stop at `<DiffHunk>`. The component is also required by M6 settings (§7.6, vertical tablist). No spec for keyboard semantics (Left/Right/Home/End), ARIA `role="tablist"`, or compact/vertical variants.
**Why it matters**: Tabs determine navigability of every packet view (3 modes × 4 tabs). Building ad-hoc in Sprint 3 risks generic shadcn defaults — the "drift toward generic SaaS UI" B3 §1 names as the failure mode. Audit-mode default-tab (Trail) and reviewer-mode tab emphasis both presume a `<Tabs>` API that doesn't exist.
**Suggested fix**: Add `<Tabs>` as B3 primitive #11: horizontal/vertical orientation, 1px copper underline on active, full ARIA wiring, Left/Right/Home/End traversal, `compact` density, optional `emphasize` prop. Add to B4 §11 and to Sprint 1 deliverables (must precede Sprint 3).
**Confidence**: high.

---

### P1 — Diff-hunk 50ms render budget is unrealistic for shiki cold-start

**Where**: `phase-2-screen-specs.md:§4.9, §12`; `phase-2-design-system.md:§15.3`.
**Issue**: B4 commits to "Diff hunk render per claim: 50ms" via async shiki. Shiki cold-start (WASM oniguruma + grammar JSON load) is 100-300ms on a modern MBP; warm-cache hunks are 5-15ms. The bundle-size win over monaco (~50KB+grammars vs ~5MB) comes with a cold-start cost the budget does not acknowledge.
**Why it matters**: The 200ms P1 open-to-summary (CR-UI-03) gate is at risk. B4 §4.4 shows the default-expanded first claim's evidence containing a diff hunk; 50ms cold is impossible, so first paint includes a skeleton — violating "summary panel render" completeness. The budget passes in dev (HMR warm) and fails in production Tauri cold-launch.
**Suggested fix**: Split budget: cold first hunk = 250ms, warm same-language = 30ms. Pre-warm shiki at `<App>` mount with the top 4 grammars (typescript, python, go, rust) — trades 200-400ms idle work at launch for sub-50ms hunks throughout the session. Acknowledge in §4.9 that the first-claim diff lazy-loads outside the 200ms summary budget.
**Confidence**: high.

---

### P2 — Horizon line under-delivered: B3 §10 names 6 contexts; B4 wires 4

**Where**: `phase-2-design-system.md:§10`; `phase-2-screen-specs.md:§1.1, §3.1, §3.4, §4.2, §5.1, §7.1`.
**Issue**: B3 §10 commits the horizon to six contexts: app chrome, trail timeline, packet header, override stack, first-run, J11 resume tick. B4 wires four (chrome, timeline, packet header, first-run). **Missing**: (a) override stack — M1 modal wireframe (§7.1) shows two/three radio rows with no copper vertical connector; the reviewer-mode three-row variant (Lens 1 P2) is where B3 §4.4's stacked-dot-with-horizon would appear; (b) J11 tick highlight — §3.4 describes the "Continue from here" pin but not the 320ms `--ease-record` tick brightening from B3 §10.6.
**Why it matters**: B3 §1 names the horizon "the one detail every user remembers." Dropping 2-of-6 wirings drops the two most differentiation-relevant uses: the override stack (where horizon literally encodes audit-trail history — the product's core value prop) and the resume-position tick (where the brand metaphor becomes functional).
**Suggested fix**: (a) Add to M1 wireframe a `<HorizonLine variant="override-stack" orientation="vertical" />` connecting override rows. (b) Add to §3.4: "On 'Continue from here' click, the corresponding tick brightens for 320ms with `--ease-record`; respects reduced-motion." (c) Update B4 §11 to enumerate `<HorizonLine>` variants: `app-chrome`, `packet-header`, `sidebar-divider`, `override-stack-vertical`, `first-run-hero`, `timeline-rail-vertical` — six variants for six contexts.
**Confidence**: high.

---

### P2 — Raw px values in B4 wireframes outside `tokens.ts` discipline

**Where**: `phase-2-screen-specs.md:§3.1, §3.2, §3.3, §4.4, §7`.
**Issue**: B3 §15.1 commits to "ESLint rule rejects raw hex / px outside `tokens.ts`." B4 uses raw px liberally: 280px sidebar, 56px icon-rail, 32px row, 480/640/720px modal widths, 14ch/80ch truncation, 1080px content max. None have token equivalents in B3 §5 (largest is `--space-9: 136`). Modal widths form an implicit `sm/md/lg` scale that is undeclared.
**Why it matters**: A Sprint-4 engineer hardcodes `width: 480px`; the lint rule either blocks the PR or gets relaxed. Either way, the design-system credibility takes a hit: strict discipline defeated by the screens that consume it. Tauri-vs-webapp parity (B3 §14) suffers — webapp needs `min(90vw, 480px)` with no token to anchor.
**Suggested fix**: Add a layout-size scale to B3 §5: `--size-modal-sm/md/lg: 480/640/720px`, `--size-sidebar: 280px`, `--size-sidebar-rail: 56px`, `--size-content-max: 1080px`, `--size-row-compact: 32px`, `--size-row-comfortable: 44px`. Add `--size-truncate-claim: 80ch`, `--size-truncate-sidebar: 14ch`. Update B4 wireframes to reference these. Glyph sizes already exist in B3 §9.2 — reference those.
**Confidence**: high.

---

### P2 — Risk-distribution glyph row (B4 §4.2) violates B3 §4's three-signal rule

**Where**: `phase-2-screen-specs.md:§4.2`; `phase-2-design-system.md:§4`.
**Issue**: B3 §4 specifies two patterns — chip (with bg+border) and dot (glyph+label). B4 §4.2's risk-distribution row above the packet-header horizon shows `●·····◯◯◯◯◐◐◐····◯◯` — bare glyphs, no labels. This is a third undeclared pattern (glyph-only positional row) that violates B3 §4's "color is never the sole signal" and WCAG 1.4.1 redundancy.
**Why it matters**: Risk encoding is B3's strongest accessibility commitment. The packet-header risk row is the most prominent risk surface in the app — the headline glyph row of every packet. A screen-reader user encounters either nothing (decorative) or a dozen unlabeled glyphs. Lens 1 P3 also flags this for clutter at scale (50+ claims).
**Suggested fix**: Preferred — replace per-claim glyph row with `<RiskHistogram>`: 4 bars labeled "7 LOW · 3 MED · 1 HIGH · 0 CRIT" tinted by risk color. Pairs glyph + label + color in one compact row; scales to any claim count. Alternative: keep per-claim glyphs but require `aria-label` on the row + hover tooltips on each glyph. Either way, declare as a third pattern in B3 §4.
**Confidence**: high.

---

### P2 — Newsreader opsz axis specified in B3 §2.3 but not wired in B4

**Where**: `phase-2-design-system.md:§2.2, §2.3`; `phase-2-screen-specs.md:§4.2, §11`.
**Issue**: B3 §2.3 specifies per-token opsz (display-1=36, display-2=28, h1=22, h2=18). B3 §1 warns "without this, headings look bloated and small text looks weak." But B3 §2.2's `@font-face` sets `font-variation-settings: "opsz" 14` — which becomes the default for all sizes unless every type-token CSS class overrides it. B4 §4.2's `<PacketHeader>` composition just says `--type-display-2 (Newsreader 28/2rem)` — no mention of variation-settings.
**Why it matters**: Quiet shipping risk. 28px headings render at opsz 14 — bloated, exactly what B3 warns against. Bug invisible in early dev (small differences); appears at QA. Without explicit token CSS, engineers won't know to set `font-variation-settings` per token.
**Suggested fix**: Add a B3 §2.5 "Token-to-CSS mapping" showing each type token as a complete class, e.g. `.type-display-1 { font-family: Newsreader; font-size: 36px; ...; font-variation-settings: "opsz" 36, "wght" 400; }`. Storybook story renders all type tokens side-by-side at declared opsz to catch regressions visually.
**Confidence**: high.

---

### P2 — Three-mode packet view under-enumerates differences in prose form

**Where**: `phase-2-screen-specs.md:§4.6, §4.7`.
**Issue**: B4 §4.6 (reviewer) and §4.7 (audit) describe differences from creator mode as bulleted prose. Three modes × six surfaces (header primary, header secondary, tabs visible, tab default, claim filter default, decision actions, modal variant) = 21 cells; B4 specifies ~12. Missing: audit-mode header right-side controls (theme toggle? settings cog?), creator-mode default filter (`undecided` assumed but never stated), reviewer-mode primary-button color (still copper `--accent` or demoted to ghost?), audit-mode read-only affordance (no "read-only" chip declared).
**Why it matters**: Bulleted prose hides gaps that a 3×N table would surface. Once Sprint 4 wires decisions, an audit user is confused whether buttons are disabled-or-just-hidden.
**Suggested fix**: Replace §4.6 + §4.7 prose with a single mode-comparison table in §4. Columns: creator / reviewer / audit. Rows: header primary, header secondary, tabs visible, tab default, claim filter default, decision actions, modal variant, read-only affordance. Fill every cell ("(same)" for inheritance). Add explicit `<Chip variant="read-only">` to audit-mode header.
**Confidence**: medium.

---

### P2 — `--type-mono-sm` (11px, 500, +0.04em, UPPERCASE) risks readability on critical surface

**Where**: `phase-2-design-system.md:§2.3, §3.4, §4.1`.
**Issue**: `--type-mono-sm` is 11px Commit Mono / 500 / 0.04em / uppercase, used for risk labels and keyboard keys. The risk label is the **only** text in the chip pattern, so its readability IS the WCAG 1.4.1 fallback for color blindness. B3 §3.4 puts risk-low-text contrast at 5.2:1 dark / 5.4:1 light — AA but below AAA. Combined: small + medium-weight + tracked-out + uppercase + AA-not-AAA on the most-critical small-text surface in the app.
**Why it matters**: When a user can't distinguish sage (LOW) from mustard (MED), the label IS the signal. Borderline-readable degrades the redundancy. On a 13" MBP Retina at ~50cm, 11px subtends ~0.18° — within angular acuity but at the edge.
**Suggested fix**: Cheapest fix — keep 11px but raise weight to 600 and drop tracking to 0.02em (denser, more readable). Alternatives: bump to 12px, or require AAA contrast on risk labels (would shift risk-color tints). Document the chosen rationale in §2.3.
**Confidence**: medium.

---

### P2 — Density modes (B3 §5.2) under-specified per-screen in B4

**Where**: `phase-2-design-system.md:§5.2`; `phase-2-screen-specs.md:§3, §4, §7.6`.
**Issue**: B3 §5.2 declares comfortable + compact and defers per-screen specs to B4. B4 §3 implicitly uses compact (32px row); B4 §4 (packet view) doesn't say. M6 settings exposes density as a user setting but doesn't say what it controls. CSS-variable resolution is ambiguous: does `[data-density="compact"]` on `<html>` apply to `<TrailSidebar>` only or to `<ClaimRow>` too?
**Why it matters**: Tauri min window is 960×600; a 50-claim packet at comfortable density may overflow. Without an answer, Sprint 2 ships sidebar-only-compact, Sprint 3 hardcodes comfortable, Sprint 6 retrofits consistency.
**Suggested fix**: Add a B4 §1.5 density matrix: trail sidebar = compact (always), claim list = comfortable (default, user-toggleable), settings/modals = comfortable. CSS scope: `[data-density]` applies on `<TrailSidebar>` always; on `<ClaimList>` only when user setting active; never on modals.
**Confidence**: medium.

---

### P2 — Sprint 3 (packet view foundation) is over-loaded; should split

**Where**: `phase-2-screen-specs.md:§13.1`.
**Issue**: Sprint 3 packs 8 contracts into 2 PRs: `<PacketHeader>`, `<RiskDistribution>`, horizon variant, `<ClaimRow>` + virtualization, `<DiffHunk>` shiki, four tabs + four tab contents. The two most novel components (`<DiffHunk>`, risk-aware `<ClaimRow>`) have no shadcn equivalents. Sprint 4 (decisions) blocks on Sprint 3's claim row.
**Why it matters**: Critical path. Tabs + claim list + diff hunk together gate CR-UI-03 (200ms summary) and the diff-budget P1 above. Optimizing under a tight perf rubric on the same PRs that introduce the components compounds risk.
**Suggested fix**: Split into 3a (1 PR): `<PacketHeader>`, `<RiskHistogram>`, horizon variant, `<Tabs>` shell with empty panels. 3b (1-2 PRs): `<ClaimRow>` + virtualization, `<DiffHunk>` shiki + cold-start strategy, four tab contents. Sprint 4 starts against 3a shell while 3b lands in parallel. PR count: 9 → 10; risk drops materially.
**Confidence**: medium.

---

### P3 — Pulse-warning's reduced-motion fallback loses the "this is new" semantic

**Where**: `phase-2-design-system.md:§8.3, §8.4`.
**Issue**: B3 §8.3 pulse-warning is "two cycles then settle"; §8.4 reduced-motion replaces it with "static high-contrast border." But "freshly raised" is a semantic, not a visual — a static border doesn't distinguish a banner just-shown from one that's been there 10 minutes.
**Why it matters**: J12 tamper warning is the most consequential alert (audit integrity). Reduced-motion users (~5-10%) lose the salience signal.
**Suggested fix**: Add a `⚠ NEW` chip (`--risk-high`, `--type-mono-sm`) to the banner that auto-dismisses after first render. Restores the "newness" semantic without motion. Document in §8.4.
**Confidence**: low.

---

### P3 — `<EmptyState>` and `<Skeleton>` implicitly required but not declared

**Where**: `phase-2-design-system.md:§15.2`; `phase-2-screen-specs.md:§3.6, §4.8, §6`.
**Issue**: B4 §3.6 ("Skeleton rows with shimmer pulse"), §4.8 ("Header skeleton + 5 claim row skeletons"), and multiple empty-state copy patterns ("No packets captured yet", "No matches") imply primitives B3 §15.2 doesn't declare.
**Why it matters**: Each screen will ship a slightly different skeleton color, timing, or empty-state hierarchy. For first-impression states, inconsistency reads as unfinished.
**Suggested fix**: Add `<Skeleton>` (`variant="text"|"block"|"row"`) and `<EmptyState>` (`icon`, `headline`, `body`, optional `action`) as B3 primitives 12-13. Add "skeleton-shimmer" to §8.3.
**Confidence**: low.

---

### P3 — Theme-handoff for shiki diff colors not specified

**Where**: `phase-2-design-system.md:§3.3, §11.3`; `phase-2-screen-specs.md:§4.5`.
**Issue**: Shiki ships its own theme JSON (`github-dark`, `github-light`, etc.). Neither B3 nor B4 says which shiki theme pairs with Trail dark/light, or whether a custom theme matches the ink/paper palette. On theme switch, does shiki re-tokenize?
**Why it matters**: Without a spec, Sprint 3 picks `github-dark` — VSCode's blue/green/orange clashing with copper, undermining "Forensic Instrument." Diff tab is high-time-on-screen.
**Suggested fix**: Add B3 §3.5 code-syntax-color spec (comment, keyword, string, number, function, variable, type, constant) mapped to Trail palette tokens. Generate `trail-dark.json` + `trail-light.json` shiki themes in Sprint 1. Theme switch swaps shiki theme.
**Confidence**: low.

---

### P3 — First-run horizon "inscribe-in" needs reduced-motion clause

**Where**: `phase-2-screen-specs.md:§5.2`; `phase-2-design-system.md:§8.4, §10.6`.
**Issue**: B4 §5.2's "inscribe-in on first render" is the second horizon-animation exception (alongside J11), but §10.6 only enumerates J11. Reduced-motion behavior is ambiguous: does the horizon draw instantly or stay un-drawn?
**Why it matters**: First-run is the brand intro. A horizon that fails to render under reduced-motion is a nasty edge-case (blank screen with brand mark and CTA, no horizon).
**Suggested fix**: Update §10.6 to enumerate first-run as the second functional-animation exception. Both render at final state under reduced-motion. Mirror in B4 §5.2.
**Confidence**: low.

---

**End of Lens 2.**

---

## Lens 3 — Architecture, security & accessibility

**Reviewer**: B6 design review, architecture / security / a11y lens (saga correctness, IPC threat surface, WCAG conformance, technical feasibility).
**Scope**: B5 (architecture reconciliation) primary; B3 §3.4/§4/§8.4/§12 (a11y); B4 §6.4/§6.8/§7 (modals + tamper banner); cross-cuts to Phase 1 v1.2 where Phase 2 is coupled. Read against `docs/architecture.md` Layer 2/3 baseline.
**Out of scope**: UX coherence (Lens 1); aesthetic execution (Lens 2); AB items already triaged in B5 §8; Phase 5+ commercial; sync layer / GitHub App / multi-tenant.
**Method**: trace each saga step against §3.2 failure matrix; walk §6.1 IPC commands for authorization; verify B3 §3.4 contrast claims against the actual on-bg pairings B4 specs render; threat-model §6.2 allowlist for arg injection / token leak / settings spoof.

The B5 spec is structurally sound: the saga ordering (YAML-first, libSQL-derived) is the correct choice and the §4 watcher contract elegantly solves three problems with one mechanism. Most findings concentrate on (a) a small number of saga gaps where the failure matrix is incomplete in ways that admit data loss or perpetual `libsql_dirty` states, (b) one WCAG AA contrast violation hidden by the §3.4 table only listing the `text` pairing (not the `glyph` pairing), and (c) hardening of the `gh` shell-execute path and YAML parse path against well-known attack patterns.

Findings count: **P1 = 4, P2 = 9, P3 = 5** (18 total).

Overall: **architecture is correct in shape; security and a11y need targeted hardening before build.** No finding requires re-architecting the saga or the watcher. The four P1s are: a crash-window between saga steps 6 and 7 that strands packets without recovery; a WCAG AA failure on the CRIT glyph in dark mode; arg-injection in the `gh` shell-execute path; and an unsafe-default YAML parser in a context that ingests untrusted git-pulled packets.

---

### P1 — Saga crash window between rename (step 6) and libSQL update (step 7-8) leaves packet permanently stranded with no `libsql_dirty` flag set

**Where**: `phase-2-architecture-reconciliation.md:§3.1, §3.2`
**Issue**: §3.2's failure matrix covers step 5 (tmp write fails), step 6 (rename fails), step 8 (libSQL TX fails), but is silent on the case where step 6 SUCCEEDS, the process is killed (SIGKILL, OS reboot, OOM kill, Tauri crash) BEFORE step 8 begins. The recovery hook in §3.2 row "Step 8 libSQL TX fails" depends on `packets.libsql_dirty = TRUE` being set — but if the crash happens before any libSQL touch, `libsql_dirty` is still its previous value (likely `FALSE`), and `last_known_hash` still reflects the OLD YAML. On next P1 open, the watcher (§4) will compare the NEW YAML hash against the STALE `last_known_hash` — hash mismatch — and surface the J12 tamper banner for what is actually the user's own write.
**Why it matters**: This converts a normal crash into a false-positive tamper warning that the user cannot distinguish from a real one. Worse, the user's only "fix" is to dismiss J12 + re-verify (which calls `rebuild_libsql`) — but if they instead "View diff" and edit the YAML, they could lose their own decision. The §4.4 row "libSQL query fails" already says "default to external (safe choice)" — the same conservative bias here means the user is trained to dismiss J12 routinely, which is the worst possible outcome for the actual-tamper case.
**Suggested fix**: Add an intent log. Before step 6 rename, write a `.trail/sessions/<sid>/.pending-N.json` marker with `{packet_id, expected_yaml_hash, stage: 'pre-rename'}`. After step 6 rename, update marker to `{stage: 'pre-libsql'}`. After step 8 commit, delete marker. On Tauri startup, scan for pending markers; if `stage=pre-libsql` and YAML hash matches `expected_yaml_hash`, run `rebuild_libsql` for that packet (recovery path is already idempotent per §3.3) and delete marker. This closes the crash window without changing the saga ordering. Add to §3.2 as a new row: "Step 6 succeeds, process dies before step 8: marker file detected on next launch; rebuild_libsql triggered automatically; no J12 fired."
**Confidence**: high.

---

### P1 — `--risk-crit` glyph (#A03831) on `--ink-950` background fails WCAG AA non-text contrast (~2.4:1 vs 3:1 required)

**Where**: `phase-2-design-system.md:§3.2, §3.4, §4.1`; rendered in `phase-2-screen-specs.md:§3.1, §4.2 (RiskDistribution)`, `§7.1 (M1 modal)`.
**Issue**: §3.4's contrast table lists `risk-crit-text on bg` at 4.7:1 dark — but that's the ROW TEXT in `--text-primary` over a tinted bg, not the GLYPH itself. The glyph is rendered in `--risk-crit` color (#A03831 in dark mode) directly on `--bg` (#0E1116). Computing relative luminance: #A03831 ≈ L 0.084, #0E1116 ≈ L 0.0053; contrast ≈ (0.134) / (0.055) ≈ **2.43:1**. WCAG 1.4.11 (non-text contrast for "graphical objects... required to understand the content") requires 3:1. Risk encoding's whole job is to communicate critical risk; the glyph is required to understand the content. This is a P1 a11y violation.
**Why it matters**: On the trail browser sidebar (a 12px glyph on dark bg) and on the RiskDistribution row, CRIT-risk packets are the EXACT case where readability matters most. Users with low vision (cataracts, glare, sub-AA monitors, dim ambient light) will not reliably distinguish CRIT from background on dark theme. WCAG AA is the spec's stated minimum (§3.4); shipping below it on the highest-stakes signal is a build blocker.
**Suggested fix**: Two options, pick one:
1. Pair the CRIT glyph with a 1px `--risk-crit` outline ring or use the `--risk-crit-bg` (`rgba(160, 56, 49, 0.12)`) chip background in dark theme; the chip variant from §4.2 already passes if used everywhere. Then move the dot variant to `--risk-high` color tone for CRIT (or use `--copper-300` accent border to pull luminance up).
2. Brighten `--risk-crit` dark to ~#C84A40 (luminance ≈ 0.16, contrast ≈ 3.79:1 vs ink-950) — keeps oxblood character, lifts above AA. Then re-verify the `risk-crit-text on bg` 4.7:1 row in §3.4 (will rise, still passes).
Add to §3.4 a third row class "glyph-on-bg" with verified contrast for all four risk levels, dark + light. CI lint via `apca-w3` against tokens.ts.
**Confidence**: high.

---

### P1 — `gh` CLI subprocess (B5 §6.2) is vulnerable to PR-number arg injection through `pr.pr_number?: int` IPC parameter

**Where**: `phase-2-architecture-reconciliation.md:§6.1 post_to_pr command, §6.2 shell.execute allowlist`
**Issue**: §6.2 lists `gh` whitelisted args including `gh api repos/.../pulls/N`. The `post_to_pr` IPC accepts `pr_number?: int`, but Tauri's allowlist scope rules for `shell.execute` typically validate the COMMAND name and arg patterns, not whether arg-string interpolation is sanitized in JS land before being passed. If the frontend builds `args = ['api', 'repos/foo/bar/pulls/' + prNumber]` and `prNumber` is a string like `"432; rm -rf ~/.trail"` — well, args are arrays so shell-injection is structurally blocked, but the SAFER concern is path-injection: `prNumber = "432/../../../search?q=..."` causes `gh api` to hit the wrong endpoint. More concerning: the `gh auth status` and `gh pr view` paths likely reuse repo derived from `git remote -v` — if the user's local repo has a malicious remote URL (`origin = https://github.com/attacker/notyou.git` set by a contributor's PR being checked out), `gh pr view` posts to the attacker's repo.
**Why it matters**: This converts "review a malicious PR" (which Trail explicitly enables — drive-by OSS contributors per scn-003) into "post my review with embedded secrets to attacker's repo." `gh` will use the local git remote; Trail's `post_to_pr` should NOT trust the local remote without surfacing the destination to the user.
**Suggested fix**: (a) Validate `pr_number` as positive integer in Rust (Tauri command handler), reject `<=0` or `> 2^31`. (b) Before invoking `gh`, resolve the destination repo from `gh repo view --json nameWithOwner` and DISPLAY it in M4 ("Posting to: github.com/{owner}/{name}") — user must confirm visually. (c) Pin `gh api` calls to use `--hostname github.com` if a hosted-only path; reject `gh.enterprise` URLs in v0.1. (d) Add §6.2 explicit text: "args are passed as array (no shell-string interpolation); pr_number validated as int32 > 0; destination owner/name derived from `gh repo view` and displayed for user confirmation in M4."
**Confidence**: high.

---

### P1 — YAML parsing of git-pulled packets must use safe-load before schema validation; the spec does not require it

**Where**: `phase-2-architecture-reconciliation.md:§3.1 step 4, §3.3 rebuild_libsql, §5.4 on_open_packet`; `phase-2-screen-specs.md:§4.4 claim list`
**Issue**: §3.1 step 4 says "validate new YAML against schema (Ajv)" — Ajv operates on parsed JS objects, not raw YAML bytes. YAML PARSE happens before schema validation. The spec doesn't pin which YAML library or which load mode. Common JS YAML parsers (`js-yaml`, `yaml`) default to permissive loaders that resolve YAML 1.1 booleans (`yes`/`no`/`on`), custom tags, anchors, and merge keys — well-known DoS surfaces (billion-laughs / quadratic blowup). A reviewer pulls a malicious packet via `git pull` (B1 J6 reviewer arrival case), Tauri auto-loads it on watcher fire (§4.2), and the parser exhausts memory before Ajv ever runs.
**Why it matters**: Phase 2 is the primary code path for ingesting OTHER PEOPLE'S YAML. v0.1's threat model treats this as low-risk (single-user, your own repo) — but the moment a contributor commits `.trail/` artifacts to a PR you check out, the watcher auto-parses. JS-YAML CVEs (CVE-2013-4660, anchor-bomb pattern) are evergreen. Phase 1 spec §11 already requires safe-load on `bin/trail-redaction-patterns.yml`; Phase 2 silently inherits the responsibility for packet YAML and doesn't pin it.
**Suggested fix**: Add §6.5 "YAML safety" subsection: (a) use `yaml` package with `{schema: 'core'}` mode (no custom tags, no merge keys, YAML 1.2 spec), or `js-yaml` with `safeLoad`/`load(... {schema: CORE_SCHEMA})`. (b) Cap input size at 10MB before parse (typical packet 50-200KB per §3.4; 10MB is generous). (c) Wrap parse in 500ms timeout via `Promise.race` to bound quadratic blowup. (d) Reject if anchor count > 100 (anti billion-laughs heuristic). (e) Document parse-time failure as a new exit code / IPC error variant: `{ok: false, error: 'yaml-parse-rejected', reason: 'size-cap'|'timeout'|'anchor-count'|'syntax'}`. Surface in B4 §6.4 E4 malformed packet card.
**Confidence**: high.

---

### P2 — Watcher debounce of 200ms is tight against the 200ms saga budget; libSQL TX on slow disk pushes the race

**Where**: `phase-2-architecture-reconciliation.md:§3.4 (saga total ≤200ms), §4.2 (debounce 200ms), §4.4 (slow disk row)`
**Issue**: §3.4 budgets saga steps 5-8 at 50+5+5+50 = 110ms; total ≤200ms with margin. §4.2 sets debounce at 200ms — equal to total saga budget. On a Windows + spinning disk + Defender real-time scan, fsync (step 5) commonly blows past 200ms; libSQL TX under disk pressure can hit 200-500ms. If saga total exceeds 200ms, the watcher's debounce fires BEFORE step 8 commits; the hash compare reads the OLD `last_known_hash` (still pointing to pre-write state), sees the new YAML hash, and concludes "external edit" → fires J12 banner against the user's own write. §4.4 row "Debounce window > 200ms (slow disk)" acknowledges this with "false-positive cost: low" — but if it fires on every slow-disk save, users learn to ignore J12 (security desensitization).
**Why it matters**: Spurious tamper warnings are the worst-case UX for a security feature. Once users learn "J12 is mostly noise," the actual-tamper case is filtered out. The fix is small but important.
**Suggested fix**: Decouple debounce from saga budget. Two options: (a) increase debounce to 500ms (matches B2 P2 durable-confirmation budget) — costs slight delay on cross-process external edits; cheap. (b) Add a backend-internal "saga in flight" flag keyed by `packet_id`; watcher checks the flag and skips events while saga is in flight (releases on step 8 commit OR step 9 timeout/abort). Flag is in-memory only; survives crashes-during-saga via P1 finding's intent log. Document in §4.2: "Self-write detection is NOT debounce alone — it's debounce + saga-in-flight flag. Hash compare is the FALLBACK for cross-process / external writes."
**Confidence**: high.

---

### P2 — `audit_log` table has no schema-level append-only enforcement; user / rogue process can rewrite history via direct SQL

**Where**: `phase-2-architecture-reconciliation.md:§7.1 audit_log table`; alluded to in `§6.1 audit_log_append IPC`
**Issue**: §7.1's `audit_log` is a normal SQLite table with `INTEGER PRIMARY KEY AUTOINCREMENT`. Nothing in the schema prevents `UPDATE audit_log SET event_type = ...` or `DELETE FROM audit_log`. The IPC layer exposes only `audit_log_append` (write-only API), but libSQL is a file (`.trail/trail.db`) writable by any process the user runs. A malicious agent that wrote a bad commit could erase the J12 tamper events that recorded its detection.
**Why it matters**: The audit log is the LAST line of defense for "this trail is dispositive" (job-003.emotional / scn-007 Riya). If it's silently mutable, a sophisticated attacker who's already past the YAML+libSQL hash defense (B5 §4.4 case-a, deferred to v0.2) can also wipe their tracks. The threat model says "case-a deferred" — but case-a + audit-log-mutable together is the full whitewash.
**Suggested fix**: Three levels of defense:
1. **Schema**: add `CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(FAIL, 'audit_log is append-only'); END;` and same for DELETE. Catches accidental + naive tampering.
2. **Hash chain**: each row gets `prev_hash` and `row_hash = sha256(event_type || packet_id || details || occurred_at || prev_hash)`. On read, recompute chain; first mismatch is detected. Catches sophisticated direct-SQL tampering.
3. **Document explicitly** in §7.1 + §9 amendment to architecture.md: "audit_log integrity is best-effort in v0.1 solo OSS; commercial v0.2+ moves audit_log to write-once cloud storage (DOs)." Add to threat model B5 §4.4 a new case-d "audit log rewrite" with v0.2 deferred status.
**Confidence**: high.

---

### P2 — Settings file (`~/.trail/settings.json`) has no schema validation specified on read; tampering can defeat tamper banner

**Where**: `phase-2-architecture-reconciliation.md:§4.6 (settings.json not watched), §6.1 read_settings/write_settings`; `phase-2-screen-specs.md:§7.6 M6 settings`
**Issue**: §6.1 specifies `read_settings` returns `Settings` and `write_settings` is "Atomic settings write" — but neither says the read path validates the file structure. If a malicious process flips `theme: "off"` (defeats theme contract) or, more dangerously, sets a hypothetical `disable_tamper_warnings: true` (B4 §6.8 J12 mentions a Settings → Redaction toggle — same shape will exist for tamper), the next launch reads the value without question. Worse: settings.json is in `~/.trail/`, NOT scoped to the repo's `.trail/` Tauri allowlist (§6.2 restricts `fs.writeFile` to specific paths). Any other app the user runs can write `~/.trail/settings.json`.
**Why it matters**: The threat model's high-bar case is "user is on a shared machine or has a malicious local app" (low for v0.1 solo, but the design must not regress). A settings file that bypasses the safety affordances violates the "safe by default" stance Trail's CSO posture implies.
**Suggested fix**: (a) Add a strict zod / valibot / Drizzle-equivalent schema for `Settings` shape; reject unknown keys, type-mismatch values; on validation failure, fall back to defaults and log to audit_log `event_type=settings_validation_failed`. (b) Include a non-secret HMAC of the settings JSON, keyed by a per-install secret stored in OS keychain (Tauri `tauri-plugin-stronghold` or `keyring`). On read mismatch, fall back to defaults. (c) Document as v0.1 hardening in B5 new §6.5: "Settings file is best-effort integrity-checked; cannot prevent root-level tampering by design."
**Confidence**: medium-high.

---

### P2 — Cross-repo isolation is implicit, not enforced: `parent_packet_id` could reference a packet in a sibling repo's libSQL (worktree / submodule edge case)

**Where**: `phase-2-architecture-reconciliation.md:§5.4 on_open_packet, §7.1 packets table`
**Issue**: §5.4's `on_open_packet` queries `libsql.SELECT * FROM packets WHERE packet_id = packet._meta.parent_packet_id`. The libSQL is per-repo (`.trail/trail.db`) — but if the user has two checkouts of the same project (worktree, fork, submodule), the parent_packet_id ULID could match across DBs (or, more ambiguously, NOT match in this DB but the YAML-recorded chain claims it should). The current spec degrades gracefully ("parent missing → render without carry-forward + log warning") which is fine — but doesn't VERIFY that the parent's `repo_path` matches the current repo. A re-capture pulled in via git from another contributor's branch carries their `parent_packet_id` ULID; if the local repo has a packet with the SAME ULID (collision is astronomically unlikely with ULID, but a deliberate craft is not), Trail would fold the wrong parent into carry-forward.
**Why it matters**: Low-likelihood high-impact; parent-confusion crosses the "the trail says X" trust boundary. Better to verify than assume ULID uniqueness.
**Suggested fix**: Add to §5.4: `if parent.repo_path != current_repo_path: log_warning("parent_packet_id resolved to a packet from a different repo: <other_repo>"); render without carry-forward.` Make `repo_path` validation explicit. As a defensive measure also assert `parent.session_id == current.session_id` (a real re-capture chain stays within one session).
**Confidence**: medium.

---

### P2 — `audit_log_append` IPC is callable from frontend without authorization gating; backend-only intent is documentation, not enforcement

**Where**: `phase-2-architecture-reconciliation.md:§6.1 audit_log_append`
**Issue**: §6.1 lists `audit_log_append` as `FE → BE` "For J12 dismiss/re-verify." A Tauri webview can call this with arbitrary `event_type` and `details` — the frontend is not a security boundary in Tauri (HTML/JS content runs with full IPC privileges). If a future surface (e.g., a packet-rendered link, B4 §5.4 markdown content) leads to JS injection, the audit log can be polluted with fake events ("tamper_re_verified" without the underlying re-verify having run).
**Why it matters**: Same trust boundary as P2 audit-log-mutable above. The IPC API surface should reflect "who is allowed to claim this event happened."
**Suggested fix**: Restrict frontend-facing `audit_log_append` to a fixed enum of `event_type` values (`tamper_dismissed`, `tamper_re_verified`, `settings_changed_via_ui`); reject all others server-side. For server-internal events (`tamper_detected`, `settings_validation_failed`, `saga_recovered`), use a backend-private logger that does not flow through IPC. Document in §6.1: "audit_log_append from FE accepts only UI-attributable events; server-internal events use the backend-private logger."
**Confidence**: medium.

---

### P2 — Reduced-motion fallback for J12 banner is described in B3 §8.4 but not wired in B4 §6.8 component spec

**Where**: `phase-2-design-system.md:§8.3 pulse-warning, §8.4 reduced-motion`; `phase-2-screen-specs.md:§6.8 J12 banner`
**Issue**: B3 §8.4 says "Pulse-warning: replace with single static high-contrast border" — but the B4 §6.8 spec just lists `pulse-warning animation (B3 §8.3) for two cycles. ARIA role="alert".` The reduced-motion alternate is not specified, and without an explicit B4 callout, engineering will likely just disable the animation and ship a banner that LOOKS the same as a non-warning banner (defeats the warning signal).
**Why it matters**: WCAG 2.1 SC 2.3.3 (Animation from Interactions) is satisfied by reducing motion, but the alternate must still convey urgency. The banner uses `--risk-med` (yellow) — if the pulse is the urgency signal and pulse is removed, the banner downgrades to "informational." Users with `prefers-reduced-motion` should see ELEVATED urgency, not LESS.
**Suggested fix**: Add to B4 §6.8: "Reduced-motion variant: 2px outer border in `--risk-high` (one tone deeper than `--risk-med`) + `--shadow-warning` static + `aria-live='assertive'` (vs `polite` in animated path). Banner remains visible until dismissed; no auto-settle." Same fix for E5 heavy redaction (B4 §6.5) and inscribe-in stagger (B4 §4.4).
**Confidence**: high.

---

### P2 — Saga step 9 ARIA live-region announcement timing is ambiguous; could announce "saved" before durable commit

**Where**: `phase-2-design-system.md:§12.5`; `phase-2-architecture-reconciliation.md:§3.1 step 1 (optimistic), step 9 (decision-saved)`
**Issue**: B3 §12.5 specifies `Decision committed: ARIA live region announces "Decision saved: accept on claim X."` But the saga has TWO commit points: step 1 (optimistic React update, ≤100ms) and step 9 (durable confirmation, ≤200ms). If the announcement fires at step 1, a user with screen reader hears "Decision saved" — and the libSQL TX then fails at step 8, surfacing T5 "Decision could not be saved." The contradiction is confusing for sighted users (they see the toast); for screen-reader users it's worse — the announcement queue may have already flushed and the failure announcement is mixed with subsequent UI noise.
**Why it matters**: WCAG SC 4.1.3 (Status Messages). The optimistic-then-fail pattern is a known accessibility anti-pattern: the assistive-tech announcement is the canonical confirmation, and undoing it via a SECOND announcement is unreliable.
**Suggested fix**: Pin the announcement to step 9 (durable confirmation). At step 1, announce nothing (or `aria-busy="true"` on the claim row). At step 9 success: "Decision saved: accept on claim X." At T5 failure: `role="alert"` with "Could not save decision: <reason>." Document in B3 §12.5 explicitly. The optimistic visual feedback (step 1) is sufficient for sighted users; SR users get the truthful confirmation slightly later.
**Confidence**: high.

---

### P2 — Keyboard shortcut scope collision: `r` (override risk) and `b` (block) fire while focus is in a text input

**Where**: `phase-2-screen-specs.md:§9 (19 shortcuts), §7.1 M1 modal (reason field)`
**Issue**: §9's claim-tab shortcuts (`a c b r j k n p`) are single-letter, no modifier. Standard hotkey libraries fire on `keydown` regardless of focus target unless explicitly scoped. Users typing in a text input (e.g., M1 reason field, or a future inline note field) who hit `r` will trigger the risk-override modal even though they're mid-sentence. Worse: `b` triggers reject modal mid-typing.
**Why it matters**: This is the kind of bug that lands in a Sprint 5 production hotfix. WCAG 2.1.4 (Character Key Shortcuts) explicitly addresses this: single-character shortcuts must be either turn-off-able OR remappable OR active-only-on-focus. The spec hits none of the three.
**Suggested fix**: Add to §9 a "scope rules" subsection: "All single-character shortcuts (a, c, b, r, j, k, n, p, g) are SUPPRESSED when an editable element has focus (`document.activeElement` is `input | textarea | [contenteditable=true]`). The `?` shortcut (catalog) and `Esc` (close modal) fire regardless." Also add Settings → Keyboard "Disable single-key shortcuts" toggle (default off; ships WCAG 2.1.4 conformance for users who need it).
**Confidence**: high.

---

### P2 — Tauri-bundled fonts have no install-time integrity check; tampered installer can ship altered glyphs (CRIT confusable with HIGH)

**Where**: `phase-2-design-system.md:§2.2 (font self-host), §15.1 (Phase 2 build setup)`
**Issue**: §15.1 says "download from official sources, place in `apps/ui/public/fonts/`. License files alongside." Once bundled in the Tauri installer, fonts ship as-is to users. An attacker who modifies the installer (or a CI compromise) could alter the Commit Mono CRIT label rendering — e.g., make the unicode `⨂` (CRIT glyph) visually identical to `●` (HIGH glyph). Defeats the §4 color+glyph+label triple-redundancy by removing one leg.
**Why it matters**: Low-likelihood, high-impact (the entire risk-encoding contract relies on glyph distinguishability). Most font-bundling pipelines don't pin hashes; this is one place where it matters because the design system explicitly relies on glyph shape.
**Suggested fix**: Add to §15.1: "Pin font file SHA-256 hashes in `tokens.ts` (or sibling `font-integrity.json`). Build script asserts hashes match before bundling. Tauri runtime asserts hashes match at app start; on mismatch, fall back to `--font-fallback-mono: 'Menlo', 'Consolas', monospace` and surface a startup warning." Also: cache the four risk glyph reference renderings as inline SVGs (not font glyphs) for the chip + dot variants — removes font dependency for the most security-relevant single use case. Re-spec §4.1 to use SVG glyphs instead of unicode characters.
**Confidence**: medium.

---

### P2 — `query_trail` and `read_packet` have no rate limit / pagination contract; 1000-packet trail browser hits CPU/memory wall on naive implementation

**Where**: `phase-2-architecture-reconciliation.md:§6.1 query_trail, §7.1 idx_packets_captured index`; `phase-2-screen-specs.md:§3.7 (300ms budget @ 1000 packets)`
**Issue**: §6.1's `query_trail` accepts `{filter: TrailFilter}` and returns `Packet[]`. No `limit` or `offset` in the contract. §7.1 has `idx_packets_captured ON packets(captured_at DESC)` — good for ordering, but a query like `SELECT * FROM packets WHERE risk_distribution_max >= 'high'` (which requires JOIN through claims table for 1000 packets, 50-claims-each) is potentially 50K rows. B4 §3.7 says virtualization handles render — but the Rust → JS IPC serialization is unbounded.
**Why it matters**: At 1000 packets × ~10KB serialized each, that's 10MB over IPC channel per query. Cold-start cost is significant; filter-toggle UX is worse. Tauri IPC is JSON-over-IPC (slow) — the budget WILL be missed without pagination.
**Suggested fix**: Pin the contract: `query_trail({filter, limit: int = 50, cursor?: string}) → {packets: Packet[], nextCursor?: string}`. Cursor is opaque (encoded `(captured_at, packet_id)` tuple). Trail browser virtualizer fetches next page on scroll. Add to §6.1 with same limit on `query_recent_sessions(limit)`. Document in §3.4 saga-budget addendum: "query_trail at 1000 packets without pagination: not supported in v0.1; pagination is mandatory."
**Confidence**: medium-high.

---

### P3 — `--text-tertiary` at 4.9:1 dark / 4.6:1 light is "AA-pass technically" but B3 §3.4 says "use sparingly" without defining where

**Where**: `phase-2-design-system.md:§3.4`; rendered in `phase-2-screen-specs.md:§3.2 (sidebar age column), §4.2 (decision count)`
**Issue**: §3.4 lists tertiary text at 4.9:1 with parenthetical "use sparingly." B4 uses tertiary text in sidebar age column ("2h", "1 day"), the metadata strip ("session 18e374b5 · captured 14:32"), and footers. These are functional information, not chrome. AA passes by 0.4 — within rounding error of compliance — and APCA scores in this range often fail readability for older users.
**Why it matters**: "Sparingly" is unenforced. Engineering will scatter it. By Sprint 6 the design system has tertiary text everywhere because it "passes."
**Suggested fix**: Define an explicit allowlist in B3 §3.4: "Tertiary text is allowed ONLY for: (a) timestamps adjacent to a primary-text packet name, (b) keyboard hint annotations, (c) footer chrome. Body text, error explanations, action labels MUST use secondary or primary." ESLint rule (or Tailwind plugin) restricts tertiary class to specific component slots.
**Confidence**: low.

---

### P3 — `rebuild_libsql` (§3.3) is not transaction-isolated against concurrent readers: trail browser query during rebuild sees half-state

**Where**: `phase-2-architecture-reconciliation.md:§3.3 rebuild_libsql`
**Issue**: §3.3's pseudocode wraps DELETE+INSERT in BEGIN/COMMIT — good. But libSQL/SQLite default isolation is `deferred` mode; concurrent readers (the trail browser polling) can see post-DELETE/pre-INSERT state if connection handling isn't pinned. The trail browser would briefly show "0 claims" for the packet under rebuild.
**Why it matters**: Cosmetic flicker. Edge case (rebuild only fires on hash mismatch).
**Suggested fix**: Use `BEGIN IMMEDIATE` (acquires write lock; readers continue to see pre-rebuild state until COMMIT). Document in §3.3.
**Confidence**: low.

---

### P3 — `posted_to_pr_history` body_hash is sha256 of markdown but no verification path is specified; tamper-detection is YAML-only

**Where**: `phase-2-architecture-reconciliation.md:§7.1 posted_to_pr_history`
**Issue**: §7.1 stores `body_hash` ("sha256 of the markdown that was posted") but the design has no verifier — no `verify_pr_post` IPC, no banner on "PR body has changed since you posted." The hash is dead data.
**Why it matters**: If Trail's stated value is "the trail is dispositive," the trail extends to the PR body the user posted. A reviewer who edits the Trail-managed section of the PR body should be detectable.
**Suggested fix**: Defer the verifier UI to v0.2 but document the use: §7.1 add note "body_hash enables future J13 'PR body diverged from posted state' check; not surfaced in v0.1 UI." OR: keep the column and add a v0.1 IPC `verify_pr_body(packet_id) → {match: bool, last_posted_at, current_body?}` for power users.
**Confidence**: low.

---

### P3 — Tauri allowlist `clipboard.writeText` allowed; redaction preview (M3) defense relies on policy alone, not capability denial

**Where**: `phase-2-architecture-reconciliation.md:§6.2 clipboard.writeText: yes`; `phase-2-screen-specs.md:§7.3 M3`
**Issue**: §6.2 allows `clipboard.writeText` (for the copy-button affordances in §5 first-run, §7.2 GH auth). M3 says "Will NOT be copied to clipboard" — but the capability is granted globally. A future regression (or LLM-generated component) could call `navigator.clipboard.writeText(originalContent)` from inside the M3 modal.
**Why it matters**: Defense-in-depth. The M3 promise should be enforceable, not just claimed.
**Suggested fix**: Two options: (a) scope `clipboard.writeText` to specific component instances via Tauri's per-window or per-component capability tokens (Tauri 2.x supports this). (b) During M3 lifetime, the modal sets a render-context flag `inRedactionPreview = true`; a global wrapper around `navigator.clipboard.writeText` rejects when the flag is set. Document in §6.2: "clipboard.writeText is denied during redaction-preview modal lifetime; M3's render-context flag is the gate."
**Confidence**: low.

---

### P3 — Phase 1 ↔ Phase 2 degraded behavior on un-landed AB-4/5/6/9/10 is not specified

**Where**: `phase-2-architecture-reconciliation.md:§8 (5 MUST AB items), §5.4 carry-forward fallback`
**Issue**: §5.4 specifies `compute_carry_forward` falls back to text-similarity if AB-5 (`claim.id` stability) doesn't land in Phase 1. Good. But the other 4 MUST items (AB-4 per-claim approval_trail, AB-6 parent_packet_id, AB-9 versioned writes, AB-10 fixture regen) have no degraded-mode spec. If Phase 1 ships without them, what does Phase 2 do?
**Why it matters**: B5 §8 declares them blocking — but a coordination accident (Phase 1 v0.1.1 lands AB-4 but not AB-6) puts Phase 2 in undefined territory. The product team should have a fallback plan, not a build-stop.
**Suggested fix**: Add to §8 a "degraded-mode behavior" sub-table: AB-4 absent → trail tab shows "approval_trail not available; this is a Phase 1 v0.1.0 packet" placeholder. AB-6 absent → all packets treated as first-of-chain (no carry-forward); J2 disabled with explanatory tooltip. AB-9 absent → re-capture detection runs in Phase 2 (suboptimal but functional). AB-10 absent → Phase 1 parity tests fail; Phase 2 build can ship but CI parity gate flags. Document each fallback in §8.1 explicitly so the build is not blocked on Phase 1 sequencing.
**Confidence**: medium.

---

**End of Lens 3.**

---

## B6 Amendment Application — 2026-05-09

Founder chose "apply ALL findings" — comprehensive amendment, no second-pass review. All 44 findings (7 P1, 24 P2, 13 P3) applied across the 5 Phase 2 spec docs. This section is the historical record of what was changed; the lens findings above are preserved verbatim as the review record.

### P1 fixes applied (7)

1. **J6 GitHub-only reviewer fallback** (B2 §4.1, B4 §6.0): added markdown-fallback spec to the deep-drilldown link form (`trail://...` primary + `requires Trail desktop app` install link + `#diff-<hash>L<line>` GitHub-Files-Changed URL-fragment fallback). New B4 §6.0 documents the cross-surface contract; Phase 3b owns emission.
2. **`<Tabs>` primitive declared** (B3 §15.2 #11, B4 §4.3, §11): added `<Tabs>` (horizontal/vertical, 1px copper underline active, full ARIA wiring, Left/Right/Home/End traversal, `compact` density, optional `emphasize` prop). B4 §4.3 wires the four-tab packet view through the primitive; M6 settings uses vertical orientation. Sprint 1 deliverable; precedes Sprint 3.
3. **Diff-hunk split budget** (B3 §15.3): cold first hunk ≤ 250ms, warm same-language ≤ 30ms; pre-warm shiki at `<App>` mount with top 4 grammars (typescript, python, go, rust). Acknowledges shiki's WASM oniguruma + grammar-JSON cold-start cost. First-claim diff explicitly lazy-loads outside the 200ms summary budget.
4. **Saga crash window closed** (B5 §3.1 + §3.2): added intent-log marker (`.trail/sessions/<sid>/.pending-<N>.json`) written before YAML rename and updated to `pre-libsql` after rename, deleted on libSQL commit. On Tauri startup, scan markers; recover via `rebuild_libsql_for_packet` if hash matches expected; no spurious J12 fired. New row in §3.2 failure matrix documents the recovery.
5. **CRIT glyph WCAG AA** (B3 §3.2, §3.4): brightened `--risk-crit` dark from `#A03831` to `#C84A40` (luminance ~0.16, ≥3.79:1 vs `--ink-950`, AA-compliant for non-text contrast WCAG 1.4.11). Added §3.4 glyph-on-bg contrast row table for all four levels dark + light; CI gates verify ≥3:1 via `apca-w3` lint.
6. **gh CLI hardening** (B5 §6.1 + §6.2): `pr_number` validated as int32 > 0 in Rust handler; args passed as array (no shell-string interpolation); destination derived from `gh repo view --json nameWithOwner` and surfaced to M4 ("Posting to: github.com/{owner}/{name}") for explicit user confirmation; non-`github.com` hostnames rejected in v0.1. Defends drive-by-OSS-with-malicious-remote attack.
7. **YAML safe-load** (B5 new §6.5): pin `yaml` package with `{schema: 'core'}` (or `js-yaml` safeLoad); 10MB size cap; 500ms parse timeout; anchor count cap of 100; new IPC error variant `{error: 'yaml-parse-rejected', reason}`. Surfaces in B4 §6.4 E4 malformed packet card. Closes the billion-laughs / quadratic-blowup vector against git-pulled packets.

### P2 fixes applied (24)

**Lens 1 (UX coherence) — 7:**
- Fix #2: mode resolution rules pinned in B4 §1.4 (per-user default from `git config user.email` vs `created_by`; explicit `?mode=reviewer` from Phase 3b URLs; audit toggled deliberately via `⌥+a`, never auto-entered).
- Fix #3: carry-forward panel in B4 §4.4 gains 3-column inline summary (`✓ unchanged · ⊕ new · ⊖ removed`) and per-claim `↻` / `⊕` row prefixes for "what changed" visibility.
- Fix #4: M1 reviewer-mode three-row variant wireframed in B4 §7.1 (Agent + Creator + Your override), with copper vertical horizon connector mirroring B3 §4.4 stacked-dot pattern.
- Fix #5: B4 §3.6 state-combination matrix added (empty × filter; loading × filter; error × filter); "Your recent sessions" pin follows same matrix.
- Fix #6: B1 CR-GH-01 acceptance gains "post preview is visible before confirm"; B4 M4 gains collapsible Preview section rendering via Phase 3b `trail packet post --dry-run`; `g` keyboard bypass preserved for power users.
- Fix #7: B4 §9 keyboard catalog trimmed from 19 to 13 shortcuts (dropped `n/p`, `[/]`, `Shift+a`); pinned "Most-used" section (`j k a c b`) at top of `?` overlay; added WCAG 2.1.4 scope rules (single-letter shortcuts suppressed when editable element has focus) + Settings → Keyboard "Disable single-key shortcuts" toggle.
- Fix #8: B4 new §5.5 first-packet-open coachmark — one-time inline strip showing tab structure + `j/k/a` hints; auto-dismisses after first decision; persisted to settings.

**Lens 2 (design execution) — 9:**
- Fix #9: B3 §10.6 enumerates two functional-animation exceptions (J11 resume tick + first-run inscribe-in); both render at final state under reduced-motion. New §10.7 enumerates 6 horizon variants (`app-chrome`, `packet-header`, `sidebar-divider`, `override-stack-vertical`, `first-run-hero`, `timeline-rail-vertical`); B4 §3.4 wires the J11 brightening tick.
- Fix #10: B3 new §5.1.1 layout-size scale (`--size-modal-{sm,md,lg}`, `--size-sidebar`, `--size-sidebar-rail`, `--size-content-max`, `--size-row-{compact,comfortable}`, `--size-truncate-{claim,sidebar}`). ESLint rule references the scale.
- Fix #11: B3 new §4.3.1 risk-histogram pattern (third declared pattern alongside chip + dot); B4 §4.2 replaces per-claim glyph row with `<RiskHistogram>` (4-bar labeled + tinted), wireframe ASCII updated. Resolves cross-lens convergence with Lens 1 P3 RiskDistribution finding.
- Fix #12: B3 new §2.5 token-to-CSS mapping with explicit `font-variation-settings: "opsz" N, "wght" N` per Newsreader token. Storybook typography stories render all type tokens at declared opsz; CI screenshot diff catches regressions. `--type-mono-sm` weight raised 500→600 and tracking dropped 0.04em→0.02em for risk-label readability.
- Fix #13: B4 §4.6 mode comparison table (creator/reviewer/audit × 11 surfaces, all cells filled) replaces prior bulleted prose; surfaces gaps the prose hid (audit-mode read-only chip, creator-mode default filter, reviewer-mode primary-button color).
- Fix #14: mono-sm readability addressed inline with #12 (above).
- Fix #15: B4 §1.5 density-mode per-screen matrix (sidebar always compact; claim list user-toggleable; modals never read density).
- Fix #16: B4 §13.1 Sprint 3 split into 3a (shell: `<PacketHeader>`, `<RiskHistogram>`, `<Tabs>`, mode-routing) and 3b (content: `<ClaimRow>`, `<DiffHunk>`, tab contents). Sprint 4 starts against 3a shell while 3b lands in parallel; PR count 9 → 10.

**Lens 3 (architecture/security/a11y) — 8:**
- Fix #17: B5 §4.2 watcher contract widened debounce 200ms → 500ms + added saga-in-flight flag (in-memory map keyed by packet_id); two-layer self-write detection (flag primary, hash fallback). §4.4 + §4.5 budget updated.
- Fix #18: B5 §7.1 audit_log gains `prev_hash` + `row_hash` columns (hash chain) and SQLite `audit_log_no_update` / `audit_log_no_delete` triggers; v0.2 deferral to write-once cloud storage documented.
- Fix #19: B5 new §6.6 settings file integrity (zod/valibot strict schema validation on read; HMAC keyed by OS keychain secret; documented limitation that root-level attacker can forge).
- Fix #20: B5 §5.4 `on_open_packet` adds cross-repo + cross-session isolation checks before folding parent into carry-forward.
- Fix #21: B5 §6.1 `audit_log_append` IPC restricted to enum of UI-attributable event_types (`tamper_dismissed`, `tamper_re_verified`, `settings_changed_via_ui`); server-internal events use backend-private logger.
- Fix #22: B4 §6.8 J12 reduced-motion variant specified (2px outer border in `--risk-high`; static shadow; `aria-live="assertive"`; `⚠ NEW` chip auto-dismissing after first render to preserve "newness" semantic).
- Fix #23: B3 §12.5 ARIA decision-saved announcement pinned to saga step 9 (durable confirmation), not step 1 (optimistic). T5 failure announces via `role="alert"` (assertive). WCAG SC 4.1.3.
- Fix #24: B4 §9 keyboard scope rules (single-letter suppression on editable focus + WCAG 2.1.4 toggle) — addressed inline with #7.
- Fix #25 (font integrity): B3 §15.1 added font SHA-256 hash pinning (build + runtime asserts) + risk glyphs as inline SVG (defense in depth — removes font dependency for the most security-relevant rendering).
- Fix #26 (pagination): B5 §6.1 `query_trail` contract gains `limit` + `cursor`; opaque cursor encodes `(captured_at, packet_id)`; mandatory pagination at 1000 packets.

(Note: P2 fixes #14, #24 are inline-folded with their cross-cutting cousins per the "two findings touch the same line, integrate coherently" rule.)

### P3 fixes applied (13)

- Fix #27 (M3 30s timer): B4 §7.3 redaction preview gains configurable duration (Settings → Redaction; 15/30/60/explicit; default 30s) + inline `[Extend 30s]` button (single-use per modal).
- Fix #28 (M5/M6 modal modeling): B4 §7.5 — M5 re-modeled as inline `<RecaptureBanner>` (banner not modal; user sees content first). M6 documented as known compromise (modal in v0.1; route conversion deferred to v0.2+); modal count drops 6 → 5.
- Fix #29 (RiskDistribution clutter): folded with P2 #11 — replaced with `<RiskHistogram>`.
- Fix #30 (audit Trail-tab empty state): B4 §4.7 audit-mode notes added — empty Trail tab on HIGH-risk packet renders `<EmptyState>` with elevated copy ("Audit-relevant: HIGH-risk packet without recorded approval").
- Fix #31 (pulse-warning reduced-motion): B3 §8.4 — reduced-motion variant adds `⚠ NEW` chip; B4 §6.8 wires it; same pattern for E5 + inscribe-in.
- Fix #32 (`<EmptyState>`/`<Skeleton>` declared): B3 §15.2 #12-13 added the two primitives.
- Fix #33 (shiki theme handoff): B3 new §3.5 code-syntax color spec mapping 8 syntax slots to Trail palette tokens; `trail-dark.json` / `trail-light.json` built in Sprint 1.
- Fix #34 (first-run inscribe-in reduced-motion): B3 §10.6 — first-run inscribe-in is the second functional-animation exception with reduced-motion final-state fallback.
- Fix #35 (`--text-tertiary` allowlist): B3 §3.4.1 — explicit allowlist (timestamps adjacent to packet name, keyboard hints, footer chrome); ESLint rule restricts class to slot.
- Fix #36 (rebuild_libsql isolation): B5 §3.3 — `BEGIN IMMEDIATE` (acquires write lock at TX start) prevents "0 claims" flicker for concurrent readers during rebuild.
- Fix #37 (body_hash use): B5 new §7.1.1 — documents `body_hash` enables future J13 "PR body diverged" check; v0.2 surfaces; v0.1 records.
- Fix #38 (clipboard.writeText scope): B5 §6.2 — denied during M3 redaction-preview modal lifetime via `window.__trailInRedactionPreview` flag + global wrapper.
- Fix #39 (Phase 1 ↔ Phase 2 degraded behavior): B5 new §8.1.1 — degraded-mode matrix for missing AB-4/5/6/9/10 so Phase 2 build is not blocked on Phase 1 sequencing accidents.

### Per-doc count

| Spec doc | Fixes applied |
|---|---|
| `phase-2-ui-stories.md` (B1) | 1 (CR-GH-01 acceptance amended for post preview) |
| `phase-2-ui-flows.md` (B2) | 1 (J6 markdown-fallback spec for `trail://` link) |
| `phase-2-design-system.md` (B3) | 17 (CRIT contrast, primitives 11-13, layout-size scale, opsz mapping, mono-sm tightening, histogram pattern, tertiary allowlist, shiki theme, font integrity, horizon variants/exceptions, ARIA timing, reduced-motion ⚠ NEW chip, diff-hunk split budget) |
| `phase-2-screen-specs.md` (B4) | 17 (mode resolution + density matrix in §1; risk histogram in §4.2; tab primitive use in §4.3; carry-forward 3-col + prefixes in §4.4; mode comparison table replacing §4.6; audit-mode empty Trail tab in §4.7; first-packet coachmark in §5.5; cross-surface markdown fallback in §6.0; J12 reduced-motion variant in §6.8; M1-Reviewer wireframe in §7.1; M3 configurable timer in §7.3; M4 destination + preview in §7.4; M5 inline banner in §7.5; M6 known-compromise note in §7.5.1; keyboard catalog trim + scope rules in §9; component table updates in §11; Sprint 3 split in §13.1) |
| `phase-2-architecture-reconciliation.md` (B5) | 13 (saga intent log in §3.1, recovery row in §3.2, BEGIN IMMEDIATE in §3.3, watcher debounce + saga-in-flight in §4.2/§4.4/§4.5, cross-repo isolation in §5.4, gh hardening + restricted audit_log_append + pagination + clipboard scope in §6.1/§6.2, YAML safety in new §6.5, settings integrity in new §6.6, audit_log triggers + hash chain + body_hash use in §7.1/§7.1.1, Phase 1 ↔ 2 degraded matrix in new §8.1.1) |

Total: 49 distinct edits across 5 spec docs (some findings touched multiple files; some files received multiple findings' edits in the same section).

### Deferred items / locked-decision conflicts

**No findings were deferred.** No findings asked to reopen locked decisions (Tauri + libSQL, AB list closure at #41, schema canonical at v0.1.1). Two findings flirted with locked territory and were applied with scoped portions only:

- Lens 2 P2 "Sprint 3 split": touched the build sequencing but didn't change the architecture; applied as 3a/3b split.
- Lens 3 P3 "M6 settings as modal": flagged as "screen rendered as modal"; applied the documented-known-compromise resolution (defer route conversion to v0.2+) rather than re-architecting routing.

### New coupling surfaced during application

- **B3 ↔ B4 `<Tabs>` primitive**: B4 §4.3 + §11 + M6 + Sprint plan all now reference the primitive declared in B3 §15.2 #11. Sprint 1 build order updated.
- **B3 ↔ B5 audit_log_append IPC**: B3 §12.5 ARIA timing + B5 §6.1 IPC enum interlock; both must converge on which event_types are UI-attributable vs server-internal.
- **B4 ↔ B5 `<RecaptureBanner>` ↔ E6**: B4 §7.5 inline-banner re-modeling reaches into B4 §6.6 E6 trigger reference; both updated.
- **B3 ↔ B5 `--size-*` scale**: B3 §5.1.1 introduces tokens that B4 wireframes consume implicitly; B5 §6.2 fs.writeFile allowlist scope is unchanged but conceptually adjacent to M-modal sizes.

No coupling created cycles; all dependencies remain DAG-shaped.
