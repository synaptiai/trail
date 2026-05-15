# Trail Hook-API Probe — Empirical Findings (2026-05-08)

Status: discover-phase artifact. Closes /devils-advocate "hook probe" follow-up by
analyzing existing Claude Code transcripts on disk rather than installing a plugin.
Three of four unresolved hook-API risks are now resolved with concrete evidence.

## Method

Inspected the live transcript for this Trail session (and adjacent storage):
- `~/.claude/projects/-Users-danielbentes-trail/<session-id>.jsonl` (2.1MB, ~700 records)
- `~/.claude/file-history/<session-id>/<backup-hash>@v<N>` (file content backups)
- `~/.claude/projects/-Users-danielbentes-trail/<session-id>/tool-results/toolu_*.txt` (externalized large tool results)

This is **stronger evidence than a live plugin probe** would have been: the transcript
contains real production-Claude-Code data, not a synthetic test case.

## Where Claude Code persists session state on disk

Three storage layers, all under `~/.claude/`:

| Layer | Path | Contents |
|---|---|---|
| Transcript (master) | `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl` | Conversation records: user prompts, assistant responses, tool_use blocks, tool_result blocks, file-history-snapshot pointers, system messages |
| File-content backups | `~/.claude/file-history/<session-id>/<backup-hash>@v<N>` | Pre-state file content snapshots (referenced by transcript file-history-snapshot records) |
| Large tool results | `~/.claude/projects/<sanitized-cwd>/<session-id>/tool-results/toolu_<id>.txt` | Tool output beyond inline-size threshold (~77KB observed externalized) |

Transcript record types observed in 700-record session:

| Type | Count | Purpose |
|---|--:|---|
| assistant | 235 | Claude responses (incl. tool_use blocks) |
| user | 164 | User prompts + tool_result blocks |
| attachment | 124 | File attachments |
| system | 49 | System messages, hook context |
| file-history-snapshot | 42 (36 non-empty) | File content backup pointers |
| last-prompt | 31 | Last-prompt tracking |
| permission-mode | 31 | Permission state changes |
| ai-title | 30 | Auto-generated session titles |
| queue-operation | 2 | Task queue ops |

## Risk register — empirical updates

### Risk 1 — File content access for diffs: **RESOLVED**

**Original concern**: PostToolUse for Edit/Write/MultiEdit may not include before/after content.

**Empirical finding**: tool_use blocks in the transcript contain the **full new content** in
`input.content` (Write) or `input.new_string` (Edit) — Trail does NOT need PreToolUse
snapshots to know what was written. Pre-state file content is preserved at
`~/.claude/file-history/<session-id>/<backup-hash>@v<N>` and referenced by
file-history-snapshot records via `backupFileName: <hash>@v<version>`. Trail computes
diffs by reading both sources at SessionEnd.

**Implication**: PreToolUse hook for snapshotting is **not required for v0.1**.

### Risk 2 — UserPromptSubmit prompt text: **RESOLVED**

**Original concern**: UserPromptSubmit may surface only metadata, not full prompt text.

**Empirical finding**: `user`-type records in the transcript contain
`message.content` as a complete string (or content-array with text blocks). Full prompt
text is preserved verbatim. Sample observed: 84-character prompt captured in full.

**Implication**: SessionEnd transcript readback is the canonical prompt source. Trail
does NOT need a real-time UserPromptSubmit hook for v0.1.

### Risk 3 — Bash output truncation: **RESOLVED at session-typical sizes**

**Original concern**: PostToolUse for Bash may truncate stdout/stderr.

**Empirical finding**: `tool_result` content lengths in the live session: min=0, p50=160B,
p99=39.7KB, max=50.9KB inline. Outputs above ~77KB get externalized to
`tool-results/toolu_<id>.txt` (one such file observed at 77.6KB). No truncation
observed at any size — content is either inline or externalized intact.

**Implication**: Bash output is captured in full. Trail reads either inline content
(typical case, <50KB) or follows the externalization pointer (rare, large outputs).
The bash-wrapper fallback designed in HOOK-EVENT-MATRIX.md is **not needed for v0.1**.

### Risk 4 — Plugin vs. user-level hook merging: **SIDESTEPPED**

**Original concern**: Plugin hooks coexisting with user-level hooks for the same
event+matcher — unclear precedence rules.

**Architectural pivot**: Trail v0.1 doesn't need hooks at all. The transcript files +
file-history backups + tool-results storage contain everything Trail needs. A pure
**post-hoc CLI tool** (`trail packet generate <session-id>`) reads the on-disk session
state and produces the packet. No hooks, no merging questions, no synchronous-execution
constraints.

**Implication**: Risk 4 is sidestepped, not resolved. If v0.2+ adds real-time
features (live checkpoints, in-session redaction warnings), the hook-merging question
returns. For v0.1, it's irrelevant.

### Risk 5 — Hook synchronous execution + blocking: **N/A in post-hoc design**

Trail v0.1 doesn't run during sessions; the <100ms p99 constraint and the never-exit-2
rule no longer apply. They return for v0.2+ live features.

## Major design implication: v0.1 architecture simplification

**Original v0.1 design** (per HOOK-EVENT-MATRIX.md): plugin with 5+ hook scripts
capturing payloads in real-time, inline redaction, write to `.trail/` synchronously.

**Revised v0.1 design (post-probe)**: pure CLI tool with no hooks.

```
trail packet generate <session-id>
  ├── reads ~/.claude/projects/<cwd>/<session-id>.jsonl
  ├── reads ~/.claude/file-history/<session-id>/*
  ├── reads ~/.claude/projects/<cwd>/<session-id>/tool-results/*
  ├── computes diffs (file-history pre-state vs. tool_use new content vs. live FS)
  ├── extracts prompts, commands, tool results
  ├── applies redaction (3-layer architecture, all post-hoc — no real-time constraint)
  ├── generates packet (claims-with-evidence-refs, opp-001 mechanism)
  └── writes .trail/sessions/<session-id>/packet.yml in the project repo
```

**Trade-offs of post-hoc design**:

| Dimension | Post-hoc CLI (v0.1) | Live hooks (deferred to v0.2) |
|---|---|---|
| Implementation surface | Small (single CLI) | Medium (plugin + 5 hook scripts) |
| Anthropic API risk | Soft (transcript format) | Hard (hook payload contracts) |
| <100ms p99 constraint | None — post-hoc | Required — synchronous in-hook |
| Real-time checkpointing | Not possible | Possible |
| Cross-session aggregation | Trivial — read multiple transcripts | Complex — needs accumulation |
| Privacy concerns | Lower — no inline transmission | Higher — must redact in flight |
| Failure recovery | Easy — re-run on transcript | Hard — partial captures |

**Recommendation**: ship v0.1 as post-hoc. Add live hooks in v0.2+ if real-time
checkpointing or in-session UX becomes a stated user need.

## Schema implications (no breaking changes)

The PR Change Packet v0.1 schema (`pr-change-packet.v0.1.yml`) is **unchanged**. Same
fields, same evidence_refs, same redaction_metadata block. Only the *capture mechanism*
changes from in-hook to post-hoc.

The `_meta.generator` block already accommodates this:
```yaml
_meta:
  generator:
    name: "trail"
    version: ""    # populated by Trail at packet-generation time
```

A v0.1.1 schema addition could surface the capture method (`_meta.capture_method:
post_hoc | live_hook`) but is not strictly required for v0.1.

## Confidence implication

L3 confidence rises from 0.40 → **0.55**:
- 3 of 4 unresolved feasibility risks empirically RESOLVED
- 1 risk (Risk 4) sidestepped by architectural simplification
- v0.1 implementation surface is **smaller** than originally designed (lower feasibility
  risk → MEDIUM → LOW)
- The schema survives the empirical contact (no v0.1 schema changes needed)

This crosses the L3 effective threshold (0.51 = 0.75 base × 0.85 solo_product × 0.8
dogfood). Discover→define transition is now defensible on confidence grounds.

## Define-phase TODOs (revised)

Removed (resolved by this probe):
- ~~Probe Risk 2 (UserPromptSubmit)~~
- ~~Probe Risk 3 (Bash truncation)~~
- ~~Probe Risk 4 (plugin merging)~~ — sidestepped
- ~~Decide on bash-wrapper fallback~~ — not needed
- ~~Decide on `CLAUDE_CODE_SKIP_PROMPT_HISTORY` behavior~~ — affects v0.1 capture only if SKIP is set; document as a degraded-fidelity edge case

Remaining for define phase:
- Implement post-hoc capture CLI prototype against this session's transcript
- Run F1 (skim-fatigue measurement) on the prototype's output
- Run F2 (external user packet review) once a real packet exists
- Run F3 (disconfirming-signal review on 20+ conversations)
- Run F6 (future-self review experiment)

## Source

Empirical inspection of `~/.claude/projects/-Users-danielbentes-trail/` transcript
storage on 2026-05-08, during /diamond-progress L3 discover→define evaluation.
Probe was Path B per /devils-advocate-driven evaluation.
