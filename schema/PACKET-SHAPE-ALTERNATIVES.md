# Trail Packet Shape — Alternatives Considered (F4)

Status: discover-phase artifact, 2026-05-08. Closes /devils-advocate finding F4
("anchoring on research §7.1"). Six alternative shapes brainstormed; one chosen
with reasoned rationale, three retained as v0.2+ candidates, two rejected.

## Why this exists

`/devils-advocate` flagged that the v0.1 schema closely follows research doc §7.1
(snapshot summary with claims + evidence_refs) without considering alternatives.
That's anchoring bias (Shotton, 2018). Surfacing alternatives forces a *chosen*
shape rather than a *defaulted* one — even if the same shape ultimately wins.

## Shapes considered

### Shape A — Snapshot summary with claims+evidence_refs (CURRENT §7.1-derived) ✅ CHOSEN

Single artifact summarizing the work. Claims with stable evidence_ref IDs (DIFF-NNN,
CMD-NNN, TEST-NNN, PROMPT-NNN, ISSUE-NNN). Generated at SessionEnd.

**Strengths**:
- Compatible with PR-comment posting (GitHub App in v0.2)
- Reviewer reads top-down, matching how PRs are reviewed today
- Schema is concrete and serializable; easy to validate, diff, version
- Grounded-claim mechanism is the load-bearing differentiator (only this shape ships it directly)
- Smallest implementation surface for v0.1

**Weaknesses**:
- Skim-fatigue risk (devils-advocate F1) — humans skim verifiable artifacts the same way they skim unverifiable ones
- Static — doesn't show *when* in the session a risk emerged
- Doesn't capture moments-of-decision (when did the agent ask the user something?)

### Shape B — Continuous risk-score timeline 🅿️ RETAINED FOR v0.2+

Time-ordered series of events: each tool call, each prompt, each file edit gets a
risk-delta score. Reviewer scrubs the timeline; spikes draw attention.

**Strengths**:
- Naturally surfaces *when* risk accumulated, not just total risk
- Animates the session — easier to spot "the agent went off the rails at minute 23"
- Reviewer can stop reading once they've understood the risky stretch

**Weaknesses**:
- Risk-scoring requires a model to compute deltas — adds LLM dependency to v0.1 capture
- No grounded-claim mechanism — risk scores can be wrong, ungrounded
- Hard to render in PR-comment surface (timelines need interactivity)
- Adds a new failure mode: false-confident "low-risk" timeline that masks a real problem

**Verdict**: Strong v0.2 candidate as a *complement* to Shape A, not replacement.
Risk timeline becomes a section within the snapshot packet.

### Shape C — Q&A with reviewer-flagged moments 🅿️ RETAINED FOR v0.2+

Packet is structured around moments-of-decision: every time the agent paused for
user input (prompt, ambiguity escalation, plan check), capture the question, the
user answer, and what changed afterward. Reviewer reads the dialog, flags moments
needing follow-up.

**Strengths**:
- Maps directly to the coordination-debt reframe ("ambiguity pushed back to human" → captured Q&A)
- Highly grounded — every claim is "the user said X, the agent did Y"
- Natural fit for the social JTBD dimension (reviewer sees how decisions were made)

**Weaknesses**:
- Requires deeper Claude Code hook integration than v0.1 — `Elicitation`/`ElicitationResult`
  events (29-event surface) aren't well-documented; would slow MVP
- Doesn't cover sessions without ambiguity escalations (most short sessions)
- Risks under-representing "silent" agent work (long edits without Q&A)

**Verdict**: Strong v0.2 candidate as a *section* of Shape A — a "decision moments"
sub-array within the packet that captures Elicitation events when present.

### Shape D — Session replay (interactive scrubbable recording) ❌ REJECTED for v0.1

Visual + textual timeline that the reviewer can scrub through (like a video timeline).
Each frame: file state, agent thought, command output, prompt.

**Strengths**:
- Maximum fidelity — reviewer can replay anything
- Compelling demo
- Differentiates dramatically from §7.1-style packets

**Weaknesses**:
- Requires a UI (web or desktop) — out of v0.1 scope (local-CLI render)
- Storage cost is huge (frame snapshots) — violates the <5% session overhead guardrail
- Privacy nightmare — frames contain prompts/output without selective redaction
- High implementation cost without commensurate validation of the cognitive-debt JTBD

**Verdict**: Not v0.1, not v0.2 — would require a different product surface.
Possibly a v1.0+ premium feature once dogfood loop has validated the core.

### Shape E — Diff-anchored annotations (inline only, no packet file) ❌ REJECTED for v0.1

Trail doesn't produce a separate packet file. Instead, claims attach directly to diff
hunks as inline annotations (like reviewer comments). At PR time, these annotations
become PR comments via GitHub App.

**Strengths**:
- Reviewers already read inline comments — zero context-switch
- No separate artifact to skim — claims live where the eye already goes
- Strongest defense against skim-fatigue (F1)

**Weaknesses**:
- Requires GitHub App from day 1 — defeats the local-first MVP choice
- No portable artifact — can't be inspected outside GitHub
- Schema becomes a comment-template format, not a structured packet — surrenders the protocol-bet defensibility
- Doesn't capture session-level context (prompts, commands, full task intent)

**Verdict**: This is the *render layer* for v0.2+, not a separate shape. The packet
(Shape A) becomes the source-of-truth; inline annotations become a secondary render.

### Shape F — Risk-only minimal packet ❌ REJECTED

Just the risk classification + reviewer focus + provenance. No claims, no summary,
no commands_run, no test_evidence.

**Strengths**:
- Smallest possible artifact — zero skim-fatigue
- Easy to ship in days

**Weaknesses**:
- Surrenders the load-bearing differentiator (grounded claims)
- "Risk: medium" with no evidence is exactly the same false-confidence pattern Trail is supposed to fix
- No path back to a richer schema once shipped (consumers expect the minimal shape)

**Verdict**: Reject. Same failure mode as current AI summaries.

## Decision: Shape A, with explicit hooks for Shapes B and C in v0.2+

**Schema v0.1 chosen**: Shape A (snapshot summary with claims + evidence_refs).

**Why**:
1. Lowest implementation surface for the smallest viable triangle (Goldratt ToC).
2. Only shape that ships the grounded-claim mechanism directly (Trail's load-bearing differentiator).
3. PR-comment-shaped output is reusable: same artifact serves local visualization (v0.1) AND GitHub App (v0.2) AND inline annotations (v0.2+, Shape E as render).
4. Skim-fatigue risk (F1) is real but addressable in the value test (measure click-through on evidence_refs); not architectural.

**v0.2+ hooks built into v0.1 schema** (so they don't require breaking changes):
- Shape B: add an optional `risk_timeline: []` array in v0.2 — slots into existing `risk` field.
- Shape C: add an optional `decision_moments: []` array in v0.2 — slots in alongside `agent_session.prompts`.
- Shape E: implementation only — schema unchanged; `summary.claims` map directly to inline annotations at GitHub-render time.

**Decision is conscious, not defaulted**: Shape D (session replay) is genuinely
attractive but out of MVP scope. Shape E is genuinely attractive but couples to
GitHub App. The choice of Shape A is a bet that grounded-claim-with-evidence-refs
is the load-bearing mechanism, and that bet is testable in the post-hoc value test.

## Source

`/devils-advocate` finding F4 (decision-log 2026-05-08); Shotton 2018 (anchoring bias);
Goldratt (Theory of Constraints — smallest viable triangle).
