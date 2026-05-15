# Trail Capture Surface — Claude Code Hook Event Matrix (v0.1)

Status: discover-phase design, 2026-05-08. **SUPERSEDED IN PART by HOOK-PROBE-FINDINGS.md
(2026-05-08 evening) — empirical probe of live Claude Code transcripts revealed Trail v0.1
should ship as a post-hoc CLI, not a live-hook plugin.** This matrix remains accurate
for v0.2+ live-hook design but is not the v0.1 implementation contract. See
HOOK-PROBE-FINDINGS.md for the v0.1 architecture.

The matrix below documents which hook events MAP to which packet fields if Trail were
implemented as a live-hook plugin. Useful as a v0.2+ reference and as documentation of
the alternatives considered during v0.1 design.

## Purpose

Maps Claude Code hook events to the PR Change Packet schema fields they populate. This
matrix exposes Anthropic-API risk: any field a hook *cannot* populate is a known gap that
must be filled by fallback heuristics or deferred to a later schema version.

## Hook event surface — full list (29 events per docs)

Claude Code exposes ~29 hook events. v0.1 Trail uses a subset (below). Other events worth
considering for v0.2+: `PreCompact`/`PostCompact` (context compression — affects how much
session history Trail has access to at SessionEnd), `FileChanged`/`CwdChanged` (filesystem-
level change detection — fallback for missed Edit/Write hooks), `SubagentStart`/`SubagentStop`
(subagent spans — needed for accurate authorship in multi-agent flows), `TaskCreated`/`TaskCompleted`
(work units — natural packet checkpoint boundaries), `PermissionRequest`/`PermissionDenied`
(security ledger), `Setup`/`InstructionsLoaded` (CLAUDE.md context capture), `Elicitation`/
`ElicitationResult` (interactive Q/A capture), `StopFailure`/`PostToolUseFailure` (error ledger).
v0.1 deliberately ignores these to keep scope tight.

## Hook event → packet field matrix (v0.1 subset)

| Hook event | Matcher | Fires when | Common fields available | v0.1 packet fields populated |
|---|---|---|---|---|
| `SessionStart` | — | Claude Code session begins | session_id, transcript_path, cwd, permission_mode | `_meta.packet_id` (generate), `_meta.generated_at` (initialize), `agent_session.started_at`, `agent_session.session_id`, `agent_session.tool`, `pr.repository`/`branch`/`base_branch` (read via shell `git ...` from cwd), `pr.author` (read via `git config user.email`), `diff_summary.base_sha` (`git rev-parse HEAD`) |
| `UserPromptSubmit` | — | User submits a prompt | session_id, transcript_path, cwd + (likely) prompt text | `agent_session.prompts.initial` (first only) / `followups` (subsequent). **Empirical test required** to confirm prompt text is in payload vs. metadata-only. Fallback: read `transcript_path` jsonl at SessionEnd. |
| `PreToolUse` | `Edit\|Write\|MultiEdit` | Before file write | session_id, transcript_path, cwd, tool_name, tool_input, tool_use_id | **Critical fallback role**: snapshot current file content via shell `cat $tool_input.file_path` for diff computation in PostToolUse. `provenance.agent_touched_files` (mark file as agent-active). Hook is synchronous — fast snapshot only, no heavy work. |
| `PreToolUse` | `Bash` | Before bash | session_id, transcript_path, cwd, tool_name, tool_input | Populate command stub (id, command text from tool_input, started_at). **Empirical test required**: confirm tool_input.command is full command text. |
| `PostToolUse` | `Edit\|Write\|MultiEdit` | After file edit (one hook per edit, NOT per MultiEdit batch) | session_id, transcript_path, cwd, tool_name, tool_input, tool_use_id | Re-read file via shell, compute diff vs. PreToolUse snapshot → `diff_summary.files_changed` (increment first time only), `diff_summary.lines_added/deleted` (aggregate), `diff_summary.semantic_changes` (append, id `DIFF-NNN`), `provenance.agent_touched_files` (append). Note: payload does NOT include before/after content directly — must compute via filesystem. |
| `PostToolUse` | `Bash` | After bash | session_id, transcript_path, cwd, tool_name, tool_input, plus exit_code/duration (likely) | `commands_run` (append: id `CMD-NNN`, command, exit_code, duration_ms, stdout_summary, stderr_summary). **Empirical test required**: confirm stdout/stderr in payload and any truncation threshold. |
| `Stop` | — | Per-turn (Claude finishes responding) | session_id, transcript_path, cwd | Marks turn boundary — increment turn count. Does NOT finalize packet (Stop fires multiple times per session). v0.1 ignores; v0.2 may use for per-turn checkpoint timeline. |
| `SessionEnd` | — | Session ends (once per session) | session_id, transcript_path, cwd | `agent_session.ended_at`, `diff_summary.head_sha` (`git rev-parse HEAD`), read full `transcript_path` jsonl as canonical source for prompts/responses (overrides any UserPromptSubmit gaps), compute `summary.claims` from accumulated semantic_changes + commands_run + test_evidence, write packet to `.trail/sessions/<session-id>/packet.yml`. |

## Fields NOT populated by hooks (gap analysis)

| Field | Why hooks can't fill it | Fallback for v0.1 |
|---|---|---|
| `pr.pr_number` | No GitHub App yet; PRs aren't created during session | Leave null; populate at packet render time (CLI flag) |
| `pr.repository`, `pr.branch`, `pr.base_branch` | Not in hook payload | Read via `git remote get-url origin`, `git branch --show-current`, `git config branch.<name>.merge` at SessionStart |
| `pr.author` | Not in hook payload | Read via `git config user.email` at SessionStart |
| `task_intent.summary`, `task_intent.acceptance_criteria` | Hook can't infer intent from prompt alone reliably | Heuristic: extract from `prompts.initial` first sentence; user can override at packet render time |
| `task_intent.source_type`, `task_intent.source_ref` | No issue linkage in raw prompt | Heuristic: regex for issue refs (`#42`, `JIRA-123`) in prompts; otherwise default to `"prompt"` and use prompt text as ref |
| `diff_summary.base_sha`, `head_sha` | Not in hook payload | Capture via `git rev-parse` at SessionStart and SessionEnd |
| `diff_summary.semantic_changes[].description` | Hooks see file content, not "what changed semantically" | v0.1 fallback: file-level summary ("modified X.tsx"); v0.2 will use diff-aware LLM summarization |
| `provenance.authorship.ai_generated_estimate` | Hooks can mark files as agent-touched but not estimate ratio | Heuristic in v0.1: count of agent_touched_files / files_changed; manual override available |
| `commands_run[].stdout_summary`, `stderr_summary` | PostToolUse may give full output, but size is unbounded | Truncate at 2KB; flag truncation; full output goes to deferred appendix |
| `summary.claims` | Hooks accumulate evidence, but claims are generated at finalization | Generate at SessionEnd via templated summarization over accumulated semantic_changes + commands_run + test_evidence; require evidence_refs |

## Risk register (after 2026-05-08 docs probe via claude-code-guide agent)

**Risk 1 — PostToolUse for Edit/Write/MultiEdit does NOT include file content directly. RESOLVED-WITH-FALLBACK.**
Confirmed via docs probe: payload contains tool_name, tool_input, tool_use_id — NOT the actual file content before/after. **Fallback design (now baseline, not contingency)**: PreToolUse snapshots the file via shell `cat`, PostToolUse re-reads + diffs. Performance impact: still <5% per the guardrail (single file read, fast on local FS). MultiEdit fires one PostToolUse per edit (not per batch), which is actually convenient — each hunk appends a separate `DIFF-NNN`.

**Risk 2 — UserPromptSubmit prompt-text payload UNRESOLVED. EMPIRICAL TEST REQUIRED.**
Docs do not specify whether prompt text is in payload or metadata-only. **Robust fallback (planned regardless)**: SessionStart provides `transcript_path` in common fields, so SessionEnd reads the full transcript jsonl as canonical prompts/responses source. UserPromptSubmit can be opportunistic — if the payload has the prompt, capture immediately; if not, the transcript readback covers it. **Test plan**: define-phase throwaway plugin logs `jq .` of stdin on UserPromptSubmit; observe whether prompt text is present.

**Risk 3 — PostToolUse for Bash stdout/stderr UNRESOLVED. EMPIRICAL TEST REQUIRED.**
Docs do not specify payload size or truncation thresholds. **Fallback if truncated**: pipe bash through Trail-controlled wrapper that captures output to disk; PostToolUse reads from disk. **Test plan**: define-phase throwaway plugin runs `seq 1 100000` (large stdout) and `node -e "console.error('a'.repeat(1000000))"` (large stderr); observe payload sizes.

**Risk 4 — Plugin vs. user-level hook merging UNDOCUMENTED. EMPIRICAL TEST REQUIRED.**
Synapti coexistence claim depends on both hook sources firing for the same event+matcher. Docs mention plugin hooks live in `plugin-name/hooks/hooks.json` and user hooks in `~/.claude/settings.json` but don't explicitly confirm both fire. **Test plan**: install Trail (plugin) + a minimal user-level hook on PostToolUse Edit; observe whether both scripts execute or if one shadows the other.

**Risk 5 — Hook synchronous execution + blocking semantics. CONFIRMED.**
Hooks run synchronously, blocking the tool call until script exit. Exit code 2 blocks the tool. **Trail design implication**: every Trail hook script must be fast (<100ms p99) to avoid degrading session feel; never exit 2 unless the user has explicitly opted into Trail-blocking behavior. v0.1 hooks are pure capture (no blocking); blocking-on-policy is a v0.2 feature requiring opt-in.

## Confirmed via docs probe (no longer unknowns)

- **SessionStart common fields** include `session_id`, `transcript_path`, `cwd`, `permission_mode`. This means transcript path is **knowable from SessionStart**, no path-discovery needed.
- **Stop fires per-turn, SessionEnd fires per-session.** Trail's finalization MUST hang off SessionEnd, not Stop. Earlier draft of this matrix had Stop populating `ended_at` — that was wrong and is now corrected.
- **MultiEdit fires one PostToolUse per edit**, not one per batch. Schema's `DIFF-NNN` IDs naturally accumulate per-hunk.
- **Hook payload delivery = JSON on stdin** (for command hooks). Trail scripts read stdin, parse JSON, append to packet.
- **`cleanupPeriodDays` setting** controls transcript retention (default 30). Trail must read transcripts before this expiry; v0.1 packets are written at SessionEnd, so well within window.
- **`CLAUDE_CODE_SKIP_PROMPT_HISTORY` env var** can suppress transcript persistence entirely. If set, Trail's transcript-readback fallback breaks — must detect this and warn the user that v0.1 capture fidelity is reduced.

## Synapti integration touchpoint (refined)

Flow plugin (synapti-marketplace) already uses PreToolUse/PostToolUse/SessionEnd. Both
plugins coexisting depends on Risk 4 (empirical test required). Each hook event accepts an
array of scripts within a single hooks.json, but cross-plugin merging is undocumented.
Eventual integration: Flow could call Trail's packet API at session-end-learn.sh to enforce
"PR must include Trail packet" as a quality gate.

## Synapti integration touchpoint

Flow plugin (synapti-marketplace) already uses the same hook surface (PreToolUse, PostToolUse,
SessionEnd) for its log-file-changes.sh, log-commits.sh, and session-end-learn.sh hooks.
Trail's hooks can co-exist with Flow's because each hook event accepts an array of scripts.
No conflict expected; Flow ships in `${CLAUDE_PLUGIN_ROOT}` namespace, Trail will ship in
its own. Eventual integration: Flow could call Trail's packet API at session-end-learn.sh
to enforce "PR must include Trail packet" as a quality gate.

## Define-phase TODO (gates that block development)

Before progressing L3 from discover→define:
- [ ] **Risk 2 probe**: throwaway plugin logs `jq .` of stdin on UserPromptSubmit; confirm prompt text presence vs. metadata-only.
- [ ] **Risk 3 probe**: throwaway plugin runs `seq 1 100000` and large-stderr command; confirm payload sizes / truncation threshold.
- [ ] **Risk 4 probe**: install Trail-stub-plugin + user-level hook on same event+matcher; confirm both fire or document the precedence rule.
- [ ] **Decide**: do we ship the wrapper-bash fallback in v0.1, or accept truncation and document the limitation?
- [ ] **Decide**: behavior when `CLAUDE_CODE_SKIP_PROMPT_HISTORY` is set (refuse to capture, warn-and-degrade, or hard-fail at SessionStart).

## Source

Docs probe via claude-code-guide subagent, 2026-05-08. Authoritative source:
`https://code.claude.com/docs/en/hooks.md` (fetched by agent; this matrix synthesizes the
relevant subset for Trail's v0.1 needs).
