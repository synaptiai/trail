# Phase 2 UI — User Stories (B1)

**Status**: B1 draft
**Date**: 2026-05-09
**Authoritative**: this document
**Scope**: Phase 2 (Tauri + React UI scaffold for v0.1 OSS MLP)
**Personas**: Creator, Reviewer, Auditor (per `.claude/canvas/jobs-to-be-done.yml#job-001..job-003`)
**MLP must-haves covered**: risk_classification, approval_trail, interactive_review_ui, github_integration (per `.claude/canvas/opportunities.yml#opp-001` capabilities 5–8)
**Blocks**: B2 (interaction flows), B3 (design system), B4 (screen specs)
**Blocked by**: A5 ✓ (Phase 1 spec closed); jobs-to-be-done.yml job-002 + job-003 added (this commit)

---

## §1 Persona definitions

Personas are derived from `.claude/canvas/jobs-to-be-done.yml`. Each persona maps 1:1 to a documented JTBD entry. Evidence tier and validation gaps are tracked in the canvas; see provenance per job.

### 1.1 Creator (job-001)
**Alias**: solo AI-native builder, "User #1"
**Primary surface**: Tauri desktop app (local-first)
**Identifying context**: working in Claude Code / Cursor on a solo or duo project; just produced a multi-file change after several prompts and tool calls; about to merge or hand off.
**JTBD anchor**: pay down cognitive debt the agent accumulated; capture intent + execution into a packet.
**Evidence tier**: `data-supported` (n=20+ external conversations, founder dogfood n=1, F2 panel n=11).
**Cagan four risks**: value MEDIUM, usability LOW, feasibility LOW, viability LOW (per opp-001).

### 1.2 Reviewer (job-002)
**Alias**: collaborator, OSS maintainer, future-self
**Primary surface**: lightweight GitHub PR touchpoint (markdown-rendered packet) + deep-drilldown surface (Tauri or webapp) for high-risk reviews.
**Identifying context**: opening someone else's AI-generated PR; on a deadline; needs to give an honest review without reverse-engineering the agent transcript.
**JTBD anchor**: decide approve/changes/block in roughly the time of a human PR; sign off on what they actually understand.
**Evidence tier**: `data-supported` for functional dimension (ht-002 panel quotes); `speculation` for emotional/social (gaps documented in canvas).
**Out-of-scope flag**: full webapp drill-down ships in Phase 5+ (commercial product, opp-006). Phase 2 Tauri app handles solo-reviewer drill-down (single repo, local).

### 1.3 Auditor (job-003)
**Alias**: security reviewer, compliance officer, future-self resuming work weeks later, downstream verification agent
**Primary surface**: Tauri trail browser + schema-level export for programmatic consumers.
**Identifying context**: reconstructing what an agent did, why, and on whose approval — possibly months after the change shipped; producing audit/compliance evidence; or just resuming a multi-day session.
**JTBD anchor**: tamper-evident, queryable trail; provenance survives refactors; redaction is auditable.
**Evidence tier**: `anecdotal` (F6 founder experiment + dual-audience purpose statement). No external auditor interviews yet — closing event tracked in canvas.
**Out-of-scope flag**: cross-PR query, compliance export, tamper-resistance hardening are v0.2+. Phase 2 covers per-PR trail browse + redaction-audit visibility (the founder-validated F6 surface).

---

## §2 Persona × MLP must-have coverage matrix

Each cell lists story IDs (defined in §3–§5). Empty cells indicate the persona/must-have intersection is intentionally out of scope for v0.1 (rationale in §7).

| | Risk classification (RC) | Approval trail (AT) | Interactive review UI (UI) | GitHub integration (GH) |
|---|---|---|---|---|
| **Creator** | CR-RC-01, CR-RC-02 | CR-AT-01, CR-AT-02 | CR-UI-01, CR-UI-02, CR-UI-03 | CR-GH-01, CR-GH-02 |
| **Reviewer** | RV-RC-01, RV-RC-02 | RV-AT-01, RV-AT-02, RV-AT-03 | RV-UI-01, RV-UI-02, RV-UI-03 | RV-GH-01 |
| **Auditor** | AU-RC-01 | AU-AT-01, AU-AT-02 | AU-UI-01, AU-UI-02 | — (deferred, see §7.4) |

**Total**: 24 stories across 3 personas × 4 must-haves, with one cell intentionally empty.

**INVEST conformance**: each story is Independent (no in-cell story chains required for value), Negotiable (acceptance bullets are intent, not contract), Valuable (traces to a JTBD dimension), Estimable (small enough for a Phase 2 sub-task), Small (fits in one PR), Testable (acceptance bullets are observable).

---

## §3 Stories — Creator (CR)

### 3.1 Risk classification (CR-RC)

**CR-RC-01** — As a Creator, I want each claim and change group in my packet to carry an explicit risk level (low/medium/high/critical) with rationale, so that I can see at a glance which parts of the change are routine and which need a careful second look before I merge.
- Acceptance:
  - Risk level appears next to every claim and every change group in the Tauri app's packet view.
  - Rationale text is visible inline (not in a tooltip-only) for medium+ risk.
  - The risk classification is sourced from the packet schema field, not re-derived in the UI (UI is a renderer, not a classifier).
- Evidence: ht-002 quote "what risk a human is approving"; opp-001 capability #5.
- JTBD trace: job-001.functional (classify risk); job-001.emotional (relief from anxiety).
- Schema dependency: packet schema must define risk_level enum + rationale field per claim/change group. **AB feedback to A**: confirm this is in v0.1.1 or schedule for v0.1.2.

**CR-RC-02** — As a Creator, I want to override the agent's risk classification before posting the packet to GitHub, so that I can correct under- or over-stated risk based on context the agent didn't have.
- Acceptance:
  - Risk override UI is one click from the claim/change-group view.
  - Override captures: new level, reason text (required), timestamp, creator identity.
  - Override is preserved in the packet (does not silently overwrite the agent's classification — both are visible).
- Evidence: derived from CR-RC-01 + Mycelium principle "human keeps the outcome" (purpose.yml#how).
- JTBD trace: job-001.functional; ethical_boundaries.
- Schema dependency: risk_classification field needs a `creator_override` sub-field (proposed `agent_assessment`, `creator_override.{level, reason, at, by}`). **AB feedback to A**.

### 3.2 Approval trail (CR-AT)

**CR-AT-01** — As a Creator, I want my own pre-merge accept/override decisions on each claim to be captured in the packet's approval trail before I post it, so that the packet I share already reflects my judgment, not just the agent's claims.
- Acceptance:
  - Each claim has accept / override / reject controls.
  - Accept default is implicit (not a click); override and reject require a reason.
  - Decisions persist to the packet on save and survive packet regeneration (when re-running an agent on the same session).
- Evidence: ht-002 quote "human approval trail"; opp-001 capability #6.
- JTBD trace: job-001.functional; job-001.social (cleanly handing off).
- Schema dependency: approval_trail array with per-claim entries.

**CR-AT-02** — As a Creator, I want to see my prior approval decisions when re-running the same session (e.g., I tweaked the agent's task and re-captured), so that I don't have to re-make every decision from scratch.
- Acceptance:
  - Tauri app detects "this packet is a re-capture of a session I already reviewed" via session ID + claim stable IDs.
  - Prior decisions are surfaced as suggestions on the new packet, not silently re-applied.
  - The creator can accept-all-prior in one click for unchanged claims.
- Evidence: dogfood need (founder runs many capture cycles per session).
- JTBD trace: job-001.functional; job-001.firing_criteria ("doesn't add ceremony to the dogfood loop").
- Schema dependency: claim stable IDs (current schema has them; verify via #41 AB).

### 3.3 Interactive review UI (CR-UI)

**CR-UI-01** — As a Creator, I want to drill from any claim to the underlying diff hunk, command output, or test result in one click, so that I can spot-check the evidence chain before I merge.
- Acceptance:
  - Every claim has at least one evidence link (claim → diff hunk / command output / test result).
  - Click navigates to the evidence source within the same window (no new tab, no external app).
  - Diff is rendered with syntax highlighting at the file's actual language.
- Evidence: founder dogfood need; ht-002 "an interactive interface would be better"; F1 Part B v2 (claims-with-diff was the format that passed).
- JTBD trace: job-001.functional (claims trace to evidence); job-001.emotional (confidence to merge).
- Schema dependency: claim.evidence field already exists in v0.1.1 (per `pr-change-packet.v0.1.1.yml`).

**CR-UI-02** — As a Creator, I want to see what the redaction layer scrubbed (redaction-audit summary) before I share the packet, so that I know whether anything material to a reviewer was removed.
- Acceptance:
  - Redaction summary panel lists: pattern set version, total redactions, redactions per pattern, layer at which each was caught (1 capture-time / 2 write-time / 3 pre-commit).
  - I can preview the un-redacted snippet for any redaction with a confirm dialog (local-only, never persisted to packet).
  - Redactions are NOT individually clickable to the original location — only summarized — to avoid building a "leak this back" workflow.
- Evidence: F5 redaction layer design; founder dogfood; LLM CVE article (founder Medium piece).
- JTBD trace: job-001.functional; ethical_boundaries (redaction control).
- Schema dependency: redaction_audit field with pattern_set_version + per-pattern counts (added in v0.1.1).
- Security note: preview-with-confirm is local-only and gated by a session-scoped opt-in. **B6 design review** must validate this does not become a default-on workflow that defeats redaction.

**CR-UI-03** — As a Creator, I want a one-glance summary view of the packet (risk distribution, claim count, approval state, redaction count, PR link) before I dive into details, so that I can decide whether to skim or deep-review.
- Acceptance:
  - Summary panel renders within 200ms of opening a packet.
  - Summary shows: risk histogram (low/med/high/crit counts), approval state (X of Y claims accepted), redaction count, GitHub PR link if posted.
  - Summary updates live as I make accept/override decisions.
- Evidence: F1 Part B v2 finding (skim-first surface needed before deep review).
- JTBD trace: job-001.functional; job-001.firing_criteria (no ceremony).

### 3.4 GitHub integration (CR-GH)

**CR-GH-01** — As a Creator, I want to post my finalized packet to a GitHub PR body with one click, so that I don't have to copy-paste markdown or run a separate CLI step.
- Acceptance:
  - "Post to PR" button is visible from the packet view when `gh` CLI is authenticated.
  - The button asks for the PR number (default: detect from current branch).
  - **Post preview is visible before confirm**: a collapsible Preview section in M4 (default-collapsed) renders the markdown that will be posted via Phase 3b `trail packet post --dry-run`. Power users can keyboard-bypass with `g` to post directly without expanding the preview.
  - On success, the PR body is updated and the packet records `posted_to_pr.{url, at}` for the trail.
- Evidence: ht-002 "When combined with Github... this can be golden"; opp-001 capability #8; F1 Part B v2 (markdown render established as primary surface — must not regress).
- JTBD trace: job-001.functional; job-001.social (collaborator handoff).
- Phase dependency: Phase 3b (`trail packet post --pr` for posting; `trail packet post --dry-run` for preview render); Phase 2 wraps both in UI.

**CR-GH-02** — As a Creator, I want to re-post an updated packet to the same PR (e.g., after addressing reviewer feedback) with the prior posting preserved in the trail, so that the PR body reflects the latest state without losing audit history.
- Acceptance:
  - Re-post overwrites the PR body marker section but appends to the packet's `posted_to_pr` history (not replaces).
  - Prior PR body content outside the Trail-managed marker section is preserved (HTML-comment fenced).
  - A "diff vs. last post" view is available pre-confirm.
- Evidence: derived from CR-GH-01 + standard PR-update workflow.
- JTBD trace: job-001.functional.
- Schema dependency: `posted_to_pr` should be an array, not a singleton. **AB feedback to A**.

---

## §4 Stories — Reviewer (RV)

### 4.1 Risk classification (RV-RC)

**RV-RC-01** — As a Reviewer, I want to see the risk classification of each claim and change group at the top of the packet, so that I can decide where to spend my review attention before reading the diff line-by-line.
- Acceptance:
  - Risk-level header is visible above the claim list (sticky on scroll).
  - High and critical claims are surfaced first (regardless of file order in the diff).
  - I can collapse low-risk claims to focus on medium+.
- Evidence: ht-002 quote "what risk a human is approving"; reviewer JTBD functional dimension.
- JTBD trace: job-002.functional; job-002.firing_criteria (no cry-wolf).

**RV-RC-02** — As a Reviewer, I want to see when the Creator overrode the agent's risk classification (and why), so that I can evaluate whether the override is reasonable before accepting it.
- Acceptance:
  - Override is visually distinct (e.g., "agent said HIGH, creator overrode to MEDIUM — reason: ...").
  - I can re-override if I disagree (captured in the approval trail per RV-AT-02).
  - Reason text is required for any reviewer-side re-override.
- Evidence: derived from CR-RC-02 reciprocity.
- JTBD trace: job-002.functional; job-002.hiring_criteria ("override agent claim with written reason").

### 4.2 Approval trail (RV-AT)

**RV-AT-01** — As a Reviewer, I want to see the full approval trail (creator decisions + any prior reviewers' decisions) for each claim, so that I can take the latest state into account in my own decision.
- Acceptance:
  - Each claim shows a chronological trail entry (creator → reviewer 1 → reviewer 2 → ...).
  - Trail entries show: identity, decision (accept/override/reject), reason, timestamp.
  - The latest decision is highlighted as the "current state."
- Evidence: ht-002 quote "human approval trail"; opp-001 capability #6.
- JTBD trace: job-002.functional; job-002.hiring_criteria.

**RV-AT-02** — As a Reviewer, I want to record my approve/changes-requested/block decision per claim (not just per PR), so that my judgment is captured at the same granularity the agent operates at.
- Acceptance:
  - Per-claim decision controls available in the Tauri review surface and (via Phase 3b) in the GitHub PR comment-thread mode.
  - PR-level decision is auto-derived from claim-level (any "block" → PR-level block; any "changes" → PR-level changes; all accept → PR-level approve) but explicitly overridable.
  - Decisions persist to the packet's approval trail.
- Evidence: ht-002 reviewer cluster; F2 panel feedback.
- JTBD trace: job-002.functional.

**RV-AT-03** — As a Reviewer, I want my override / block decisions to be visible to the Creator immediately on the next packet open (not queued for a sync), so that the loop closes without me sending an out-of-band message.
- Acceptance:
  - For Tauri solo workflow: the packet is in `.trail/` in the same repo, decisions land via filesystem (next `git pull` surfaces them).
  - For GitHub workflow: decisions land in the PR via Phase 3b `trail packet decide --pr X --claim Y --decision changes --reason ...`.
  - No additional sync step is required from the reviewer.
- Evidence: ht-002 "approval trail"; collaboration friction in F3 panel.
- JTBD trace: job-002.functional; job-002.firing_criteria (no flow break).
- Phase dependency: Phase 3b GitHub integration; v0.1 OSS MLP supports the local-filesystem path; cloud-sync path is opp-006 (Phase 5+).

### 4.3 Interactive review UI (RV-UI)

**RV-UI-01** — As a Reviewer, I want a side-by-side view of "claim ↔ diff hunk that backs it" that I can step through with keyboard shortcuts, so that I can review at the speed of a code review, not a document read.
- Acceptance:
  - j/k or n/p shortcuts step through claims with the diff hunk auto-scrolled to the relevant location.
  - Claim text and diff hunk are visible together (no scroll required to see both).
  - Approve/changes/block keyboard shortcuts (a/c/b) are available on the focused claim.
- Evidence: F1 Part B v2 finding; reviewer JTBD; standard code-review tooling patterns (GitHub Files Changed, Phabricator differential).
- JTBD trace: job-002.functional; job-002.hiring_criteria ("decide in <= time of human PR").

**RV-UI-02** — As a Reviewer, I want to see the redaction-audit summary (counts and patterns, not contents), so that I can tell whether the packet I'm reviewing has been heavily redacted and whether to ask for more context.
- Acceptance:
  - Redaction summary panel is visible from the review surface (read-only — no preview-original capability for reviewers).
  - Summary shows: pattern set version, total count, per-pattern counts, layer at which each was caught.
  - A high redaction count visually flags as "heavily redacted — ask author for more context if needed."
- Evidence: F5 redaction design; reviewer JTBD firing_criteria ("packet hides what was redacted").
- JTBD trace: job-002.functional; job-002.firing_criteria.
- Security note: reviewers do NOT get preview-original access (would defeat redaction by routing through the reviewer surface).

**RV-UI-03** — As a Reviewer, I want to drop into deep-drilldown mode (Tauri, with full evidence-graph visualization) for a high-risk claim, so that I can verify the reasoning chain end-to-end without leaving the surface.
- Acceptance:
  - From any claim with risk ≥ high, a "deep drilldown" link opens the Tauri app on the same packet, scrolled to that claim.
  - Deep drilldown shows: claim text, all evidence links (diff + commands + tests + prompts), agent session timeline, and the prior approval trail.
  - Closing deep drilldown returns me to the surface I came from (GitHub or Tauri review surface) with my position preserved.
- Evidence: ht-002 "interactive interface" cluster; L1 Q3 hybrid surface decision.
- JTBD trace: job-002.functional; job-002.hiring_criteria ("works in both GitHub PR view and a deeper Trail surface").
- Phase dependency: Phase 2 ships the Tauri side; the GitHub-side "deep drilldown link" requires Phase 3b URL-handler registration.

### 4.4 GitHub integration (RV-GH)

**RV-GH-01** — As a Reviewer, I want the GitHub PR view to render the packet inline (markdown via Phase 3b `trail packet post`) with collapsed-by-default sections for low-risk claims, so that I can do a first-pass skim review without leaving GitHub.
- Acceptance:
  - PR body renders the packet markdown with risk-level prefixes (e.g., `🟢 LOW`, `🟡 MED`, `🔴 HIGH`, `⛔ CRIT`) — emoji set TBD in B3 design system.
  - Low-risk claims are inside `<details>` tags (collapsed by default).
  - The "deep drilldown" link from RV-UI-03 is rendered as a markdown link to a `trail://` URL handler.
- Evidence: ht-002 "When combined with Github... this can be golden"; lightweight GitHub touchpoint per L1 Q3.
- JTBD trace: job-002.functional; job-002.hiring_criteria (works in GitHub PR view).
- Phase dependency: Phase 3b for the markdown post; B3 for emoji/glyph choice; Phase 2 for `trail://` URL handler registration.

---

## §5 Stories — Auditor (AU)

### 5.1 Risk classification (AU-RC)

**AU-RC-01** — As an Auditor, I want to filter the trail of past packets by risk level, so that I can prioritize my audit attention on high/critical changes without reading every PR.
- Acceptance:
  - Trail browser has a risk-level filter (multi-select).
  - Filter applies across the full local trail (single repo for v0.1; cross-repo is v0.2+).
  - Filter results show packet metadata (PR URL, created_at, claim count by risk) before drilling in.
- Evidence: F6 founder experiment; auditor JTBD functional.
- JTBD trace: job-003.functional; job-003.hiring_criteria ("queryable across packets").
- Out-of-scope clarification: cross-repo / cross-org trail is opp-006 (Phase 5+); v0.1 is single-repo `.trail/` directory only.

### 5.2 Approval trail (AU-AT)

**AU-AT-01** — As an Auditor, I want to see the full approval trail for any historical packet (creator + all reviewers + all overrides + all reasons), so that I can reconstruct who approved what and why without paging the original author.
- Acceptance:
  - Trail browser opens any past packet with the approval trail rendered chronologically.
  - Trail entries are immutable (no UI path to edit a past decision).
  - Tampering attempts (e.g., editing the YAML directly) are detected via content hash on packet open and surfaced as a warning. **AB feedback to A**: schema must define content-hash field for the approval trail.
- Evidence: F6; auditor JTBD; purpose.yml dual-audience.
- JTBD trace: job-003.functional; job-003.firing_criteria (tamper resistance).
- Schema dependency: tamper-detection content hash. **MUST be added** if not in v0.1.1 — flag as AB blocker.

**AU-AT-02** — As an Auditor, I want to see the redaction audit metadata for any historical packet (pattern set version, per-pattern counts, layer of catch), so that I can validate that redaction policies were enforced consistently across the audit window.
- Acceptance:
  - Redaction summary is visible per packet in the trail browser.
  - Pattern-set-version is visible per packet (different versions of the pattern set produce different redactions; auditors need to know which was active).
  - A "policy drift" view flags packets that ran against an older pattern set than the current one.
- Evidence: F5 redaction layer; auditor JTBD; redaction_metadata.pattern_set_origin schema field added at A4.7.
- JTBD trace: job-003.functional; job-003.hiring_criteria ("redaction is auditable").
- Schema dependency: redaction_metadata.pattern_set_origin (added at A4.7 to v0.1.1) — confirm reachable from UI.

### 5.3 Interactive review UI (AU-UI)

**AU-UI-01** — As an Auditor, I want a chronological trail browser that shows all packets in a single repo as a timeline, so that I can navigate from "what happened in Q2" to specific high-risk decisions in two clicks.
- Acceptance:
  - Trail browser shows a timeline of packets (newest first, configurable).
  - Each timeline entry shows: PR URL, risk distribution glyph, claim count, approval state, redaction count.
  - Click → packet detail view (same as RV-UI-01 deep drilldown, but in audit/read-only mode).
- Evidence: F6 founder experiment; auditor JTBD functional dimension.
- JTBD trace: job-003.functional.

**AU-UI-02** — As an Auditor (specifically future-self), I want to resume a multi-day work session by browsing my own recent trail, so that I can rebuild context in minutes instead of re-reading the agent transcript.
- Acceptance:
  - Trail browser surfaces "your recent sessions" as a quick-access shortcut (top of the timeline by default).
  - Per-session view aggregates packets from the same agent session ID into one collapsed group.
  - "Continue from here" link opens the most recent packet for context restore.
- Evidence: F6 future-self review experiment; founder dogfood pattern; job-001 social dimension (future-self handoff).
- JTBD trace: job-003.functional; cross-references job-001.social.

### 5.4 GitHub integration (AU-GH)

**Cell intentionally empty for v0.1.** See §7.4.

---

## §6 Cross-persona dependencies

A small number of stories depend on each other across personas. These constrain the order of B2 (interaction flows) and B4 (screen specs).

| Story | Depends on | Nature of dependency |
|---|---|---|
| RV-RC-02 | CR-RC-02 | Reviewer override semantics presume creator override semantics exist. |
| RV-AT-01 | CR-AT-01 | Reviewer reads the approval trail the creator started. |
| RV-AT-03 | CR-GH-01 | Reviewer-creator loop closure depends on the GitHub posting path. |
| AU-AT-01 | CR-AT-01, RV-AT-02 | Auditor reads the trail both creator and reviewer wrote into. |
| AU-AT-02 | CR-UI-02 | Auditor view reuses the creator's redaction-summary component (shared, read-only). |
| AU-UI-02 | CR-AT-02 | Future-self resume depends on session-aware packet detection. |

**Implication for B2**: build flows in dependency order — Creator first, then Reviewer, then Auditor. **Implication for B4**: screens for Creator's packet view (CR-UI-01..03) are the foundation; Reviewer and Auditor screens are variants/specializations.

---

## §7 Out-of-scope (deferred to v0.2+)

These are intentionally excluded from v0.1 Phase 2 but tracked here so future-self knows where they went.

### 7.1 Cross-repo / cross-org trail browsing
v0.1 trail is one `.trail/` directory per repo. Cross-repo, cross-org, team-level dashboards land in opp-006 (Phase 5+ commercial product). Auditor stories AU-RC-01 and AU-UI-01 explicitly scope to single-repo.

### 7.2 Compliance-friendly export (JSON/CSV/PDF)
Mentioned in job-003 hiring_criteria but deferred. v0.1 ships open schema, so a v0.2 exporter is straightforward to add later. Tracked as future task; not blocking Phase 2.

### 7.3 Tamper-resistance hardening
AU-AT-01 surfaces a tamper warning on content-hash mismatch. Cryptographic signing (e.g., signed packets, GPG, sigstore) is v0.2+. Schema reserves a `signature` field per A4.7 design but does not require it in v0.1.

### 7.4 Auditor × GitHub integration cell
Empty by design. v0.1 auditors operate against the local `.trail/` directory; the GitHub PR is the surface for creator + reviewer, not auditor. A "search past packets via GitHub PR labels" workflow would belong in v0.2 if at all (most likely it stays in the Trail webapp instead). Documented as deferred to keep the matrix honest.

### 7.5 Interactive packet edit (post-capture)
Creators can override risk and approval at packet-time, but cannot rewrite claim text or fabricate evidence. The packet is intent + execution + approval; the agent's claims are the agent's claims. (If the creator disagrees with a claim's content, the override path is "reject with reason," not "edit the claim text.") Confirms ethical_boundaries (purpose.yml).

### 7.6 Multi-agent capture (Cursor, Codex, Aider)
v0.1 is Claude Code only (purpose.yml#constraints.technical). Multi-agent UI affordances (e.g., agent-type filter in trail browser) are v0.2+. UI must not hardcode "Claude" everywhere — design system uses agent_type from packet, but only one value is exercised in v0.1.

### 7.7 Session-replay / time-travel debugging
The packet captures intent + execution + approval, not a deterministic replay capability. Time-travel debugging is opp-002+ (separate diamond) and out of Phase 2 scope.

---

## §8 Open questions for B2–B4

These are surfaced now so the next stages can resolve them deliberately.

### 8.1 For B2 (interaction flows)
- **OQ-B2-1**: Does the Tauri app open packets passively (filesystem watcher) or only on explicit user action? Affects creator dogfood loop friction.
- **OQ-B2-2**: For RV-AT-03 reviewer-creator loop, is the local-filesystem path acceptable for OSS solo/duo workflows in v0.1, or does it need a GitHub-side fallback for non-co-located reviewers? (Likely answer: GitHub-side via Phase 3b `trail packet decide` is the path; confirm in B2.)
- **OQ-B2-3**: For AU-UI-02 future-self resume, what is the entry point — desktop app launch, CLI command, or both?

### 8.2 For B3 (design system)
- **OQ-B3-1**: Risk-level visual encoding. Color-only is an a11y failure. Need glyph + color + text label (per WCAG 2.1 1.4.1). Specific glyph choices land in B3.
- **OQ-B3-2**: Tauri vs. webapp design parity. Phase 2 ships Tauri; Phase 5+ ships hosted webapp. How much of the design system needs to be portable vs. native-Tauri-flavored? (Recommended: build for both from day one to avoid v0.2+ rework.)
- **OQ-B3-3**: Dark mode. Founder default? Defer? (Recommended: ship dark-first; founder dogfoods in dark mode.)

### 8.3 For B4 (screen specs)
- **OQ-B4-1**: How many distinct screens does Phase 2 ship? (Estimate: 4–6 — packet view, trail browser, redaction-audit panel, settings, optional onboarding. Lock in B4.)
- **OQ-B4-2**: Empty / first-run state. What does the Tauri app show on first launch (no packets in `.trail/` yet)?
- **OQ-B4-3**: Error states for `gh` CLI not authenticated, malformed packet, schema-version mismatch. Each needs an explicit screen spec.

### 8.4 For AB feedback loop (UX-driven schema gap)
- **AB-1**: CR-RC-02 needs `risk_classification.creator_override.{level, reason, at, by}`. Confirm in v0.1.1 or schedule for v0.1.2.
- **AB-2**: CR-GH-02 needs `posted_to_pr` to be an array, not a singleton. Likely already an array; verify.
- **AB-3**: AU-AT-01 needs a content-hash field for tamper detection on the approval trail. **MUST be in v0.1.1** — flag as blocking.
- **AB-4**: RV-AT-02 needs per-claim decision granularity in the approval trail, not just packet-level. Confirm schema supports this.
- **AB-5**: Confirm `claim.id` is stable across re-captures of the same session (CR-AT-02 dependency).

These five items are the AB Stage feedback to A — to be resolved in task #41 after B-stage spec converges.

---

## §9 Provenance

| Source | Used for |
|---|---|
| `.claude/canvas/jobs-to-be-done.yml#job-001..job-003` | Persona definitions, JTBD trace per story |
| `.claude/canvas/opportunities.yml#opp-001` (capabilities 5–8) | MLP must-have list |
| `.claude/canvas/purpose.yml#what` and `#how` | Dual-audience, protocol-first, human-keeps-outcome principles |
| `.claude/canvas/human-tasks.yml#ht-002` (n=11 panel) | Reviewer JTBD direct quotes |
| F1 Part B v2, F2, F3, F5, F6 findings | Story acceptance derivations |
| `docs/specs/phase-1-capture.md` (v1.2 post-A4.9) | Schema field references (capture, redaction_audit, approval_trail, posted_to_pr) |
| `schema/pr-change-packet.v0.1.1.yml` | Schema field availability for stories |

---

**End of B1.**

Next: B2 (interaction flows) — convert each story into a flow diagram (entry → user actions → system responses → exit), grouped by persona and traced by story ID. Then B3 (design system bootstrap) for visual encoding, then B4 (screen specs) for layouts.
