# Phase 1 — Capture Layer Specification

**Status**: AMENDED v1.1 (post-A4.5 design-review amendments, 2026-05-08). Authoritative for the TS port. Supersedes blind draft (A1) and v1.0 reconciled (A3).
**Sources**: A1 blind draft → A2 audit → A3 reconciliation → A4 design review (60 findings) → A4.5 amendments (P1 + selected P2). Amendments logged in `.claude/harness/decision-log.md`.
**Schema**: `schema/pr-change-packet.v0.1.1.yml` (additive bump from v0.1; non-breaking). Redaction patterns: `bin/trail-redaction-patterns.yml` v0.1.2 (extended pattern set per A4.5 P2-SEC-6).
**Companion**: `docs/specs/phase-1-capture-audit.md` (A2 audit) + `docs/specs/phase-1-capture-design-review.md` (A4 review) preserved as canonical "why does the spec say X" references.

---

## 1. Goals

Layer 1 — Capture — reads Claude Code's session artifacts after a session ends and emits a packet conforming to `schema/pr-change-packet.v0.1.1.yml`. Specifically:

1. Parse one Claude Code transcript (`.jsonl`) and produce one packet.
2. Apply Layer-1 redaction to all designated user-content fields before they reach memory.
3. Apply Layer-2 redaction (write-time validation) over the about-to-be-written packet bytes (atomic-write contract per §5).
4. Synthesize human-readable claims with evidence references — mechanical (per-file default; `--per-diff` for per-DIFF mode) or LLM-augmented (LLM picks claim text; code infers evidence_refs).
5. Persist the packet to:
   - `<repo>/.trail/sessions/<session-id>/packet-<N>.yml` (canonical YAML; **[AB-9 / AB-10 / AB-stage 2026-05-09]** versioned per re-capture; `N=1` for first capture in chain, `N=max(prior)+1` otherwise — see §3 step 9a + §X).
   - `<repo>/.trail/sessions/<session-id>/packet-<N>.md` (human render; same code path emits both).
   - Layer 2 storage (Drizzle → local SQLite) — best-effort; opt-out via `--no-storage`.
6. Provide a CLI suitable for solo developer use AND in-app subprocess invocation from the Tauri shell (Phase 2).

Capture is **post-hoc**: it runs after a Claude Code session ends. Real-time hook-driven capture is explicitly out of Phase 1 scope.

### 1.1 Privacy + PII inventory

The packet contains the following non-secret PII / metadata fields. Document for awareness:

| Field | What | Sensitivity |
|---|---|---|
| `pr.author` | Git committer email (from `git config user.email`) | PII. Users with `noreply@github.com` setup are fine; users with personal email should be aware. |
| `diff_summary.modules_touched` | Top-level dirs of changed files | Metadata leak. Names like `clients/acme-corp-prerelease` reveal customer/product context. |
| `pr.repository` | `owner/repo` from git remote | Metadata. Userinfo stripped per §4 (no token leak). |

## 2. Non-goals (Phase 1)

| What | Where it goes |
|---|---|
| Interactive UI / approval capture | Phase 2 |
| GitHub PR-body posting | Phase 3b |
| Pre-commit audit script (Layer 3 of redaction) | Phase 3a |
| Real-time hook-driven capture | v0.2+ |
| Multi-agent support (Cursor / Codex / Aider) | v0.2+ |
| Risk classification field in packet | Schema v0.2 |
| Approval trail field in packet | Schema v0.2 |
| Full transcript appendix | v0.2+ |
| Layer 4 cloud sync | Phase 5+ |
| Mtime-based heuristic provenance | v0.2+ |
| Reading from `~/.claude/file-history/` for excerpts | v0.2+ enhancement |
| Per-claim model attribution (`claims[].model`) | v0.2 |
| Confidence gradient (`supported`/`partial`/`ungrounded` per claim) | v0.2 |
| Encryption-at-rest for SQLite storage | Phase 5+ commercial product |
| Real `commands_run[].exit_code` / `.duration_ms` parsing | v0.2 (locked at 0 for parity in Phase 1; see §4) |
| Concurrent multi-process file-locking on `.trail/sessions/<id>/` | v0.2 (Phase 1 documents last-writer-wins with warning; see §8) |

## 3. CLI surface

Binary name: `trail`. Installed via the `@trail/capture` npm package (Phase 4 publishes; Phase 1 invokes via pnpm workspace).

### Commands

| Command | Purpose |
|---|---|
| `trail packet generate <session-id>` | Generate packet for the given Claude Code session. |
| `trail packet generate --latest` | Generate packet for the most recent session captured for the **current working directory** (cwd-scoped). |
| `trail packet list` | List packets discovered under `.trail/sessions/` for current repo. |
| `trail --version` | Print version. |
| `trail --help` | Top-level help (commander/cac); each subcommand has `--help`. |

`trail` with no args → top-level help, exit 0 (NOT argparse-style exit 2).

### CLI argument parsing & validation

**[A4.5 / FAIL-02]** All CLI arguments are parsed and validated **before** any filesystem call (no transcript read, no git read, no pattern load). Invalid args → exit 8 immediately. This means: a malformed `--llm-budget-usd "x"` exits 8 even if the transcript is also missing (which would otherwise be exit 2). Exit 8 dominates exits 2/3/4/6 by ordering.

### Flags (apply to `packet generate`)

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--no-llm` | bool | false | Force mechanical claim synthesis; skip `claude` CLI subprocess attempt. |
| `--llm-model <model>` | string | `haiku` | Model passed to `claude -p --model`. |
| `--llm-budget-usd <number>` | number | `0.50` | Max budget passed to `claude --max-budget-usd`. |
| `--llm-timeout-seconds <int>` | number | `120` | Subprocess timeout. |
| `--per-diff` | bool | false | Mechanical synthesis: one claim per DIFF instead of per-file. LLM mode unaffected (LLM always per-file). |
| `--output <path>` | path | `<repo>/.trail/sessions/<session-id>/` | Output directory. |
| `--format yaml\|md\|both` | enum | `both` | What renderings to emit. |
| `--patterns <path>` | path | `<package-bundled>/bin/trail-redaction-patterns.yml` | **[A4.5 / P2-SEC-6; A4.7 / R-FAIL-06, R-FAIL-07, R-COUPLING-04]** User-supplied redaction patterns YAML. **Replaces** the bundled set (does NOT merge — explicit replacement). Pattern format identical to bundled file. **Validation gates** (load-time, before any extraction): (a) file size cap 64KB (else exit 4 sub-shape (f)); (b) loaded with `yaml.load(..., {schema: yaml.FAILSAFE_SCHEMA})` (no aliases, no merge keys, no tag execution — defends against alias-bomb / billion-laughs); (c) reject binary content / non-YAML bytes (else exit 4 sub-shape (g)); (d) require `version: <non-empty string>` (else sub-shape (c)); (e) require `patterns: [...]` array with `length >= 1` (**fail-closed: zero patterns refused** — exit 4 sub-shape (e); prevents silent Layer-1 degradation to no-op which would weaken on-disk redaction AND LLM-prompt redaction); (f) per-pattern compile (else sub-shape (d)); (g) **[A4.9 / R8-COUPLING-03]** ReDoS guard via **static analysis** (NOT runtime smoke-test — stock Node.js `RegExp.exec` is synchronous and uncancelable; a worker-thread runtime test is too heavy for v0.1). Use `safe-regex` npm package (or equivalent) to detect catastrophic-backtracking shapes (nested quantifiers, alternation with overlap, etc.) at pattern-load time. Patterns flagged by `safe-regex` → exit 4 sub-shape (h) `"failed to load <path>: pattern '<name>' has catastrophic backtracking shape (safe-regex check failed)"`. Worker-thread runtime testing is deferred to v0.2. **Security trade-off**: replacing rather than merging means weaker pattern sets reduce on-disk AND LLM-prompt redaction (per SEC-3). **[A4.9 / R8-SEC-4]** Whenever `--patterns` is set, emit stderr warning (bypasses `--quiet`): `"note: --patterns replaces the bundled redaction set; on-disk redaction uses user-supplied patterns only. Bundled patterns NOT applied."` When LLM mode is ALSO active, augment the warning: `" LLM-prompt redaction (SEC-3 boundary) likewise uses user-supplied patterns only."` Symmetric warning ensures cost-conscious `--no-llm` users with custom patterns are equally informed about the on-disk weakening as LLM users are about the egress weakening. v0.2 SHOULD ship `--patterns-merge <path>` for additive use. |
| `--strict-redaction` | bool | false | **[A4.5 / FAIL-10]** If Layer 2 finds non-empty `validation_errors`, exit 5 — do NOT write packet to disk. Default behavior: write packet, log warning, exit 0. |
| `--strict-llm` | bool | false | If LLM synthesis fails, exit 7 instead of falling back. |
| `--dry-run` | bool | false | Compute and validate; no writes. Print stderr summary. **[A4.5]** Stdout output strictly limited to: `{N claims, M redactions, validation_errors=K}` JSON. NOT the packet body, even with future verbose flag. **[A4.7 / R-COUPLING-08]** Interaction with `--strict-redaction`: `--strict-redaction` is a fail-closed gate that **supersedes** `--dry-run`'s exit-0 behavior — `--dry-run --strict-redaction` with non-empty validation_errors exits 5 (matches §3 step 10c, §8.1 step 8b). Rationale: strict-redaction's purpose is to refuse leaks, not to report them. |
| `--no-storage` | bool | false | Skip Layer 2 storage row write. |
| `--quiet` | bool | false | Suppress informational stderr; only errors and final summary line. **[A4.5 / FAIL-10; A4.7 / R-SEC-3]** Notices that are user-facing mitigations for Decision #3 (excerpts non-redacted on disk) ALWAYS bypass `--quiet`: (a) Layer 2 `validation_errors` warning (§5 step 8), (b) packet.md sharing notice (§3 step 10h), (c) gitignore-not-excluded notice (§3 step 7), (d) `--patterns` × LLM-mode trade-off warning (§3 `--patterns` flag). Informational notices (LLM fallback reasons, dropped-MultiEdit-hunks, skipped-tool_use) obey `--quiet`. |

### Default behavior (no flags)

Run `trail packet generate --latest` from inside a git repo. The tool:

1. **Parse + validate CLI args** (no I/O yet). Exit 8 if invalid.
2. Find the latest session for the cwd at `~/.claude/projects/<sanitized-cwd>/` (sanitization rule: same as Claude Code's project dir naming).
3. Read git state via simple-git. Exit 3 if not a git repo (per §8 Row 3 sub-shapes).
4. Read transcript (`.jsonl`) and inline `tool_result` blocks from `user`-typed records. Exit 2 if not found (per §8 Row 2 sub-shapes).
5. Load redaction patterns from `--patterns <path>` (default: package-bundled `bin/trail-redaction-patterns.yml`). Exit 4 on load failure (per §8 Row 4 sub-shapes).
6. Load test-runner patterns from package-bundled `bin/trail-test-runners.yml`.
7. **[A4.5 / SEC-4; A4.7 / R-SEC-5, R-FAIL-09]** Check whether `<repo>/.gitignore` actually excludes `.trail/` (parser-level check, not file-existence proxy). If not, emit stderr notice on first run: `"note: .trail/ is NOT excluded by .gitignore. Trail does not modify .gitignore. Run 'echo .trail/ >> .gitignore' if packets should not be committed."` **Bypasses `--quiet`** (Decision-#3-bounds notice). Suppress on subsequent runs via a touch file at `~/.trail/repos/<sha256(repo-root-absolute-path)>.gitignore-checked` (user-home-scoped, NOT repo-scoped — prevents pre-planted touch file from suppressing notice via repo template / supply chain). Touch file created only AFTER successful step 10f (packet.yml renamed); strict-redaction exits and other failures do NOT mark the run as having shown the notice.
8. Synthesize claims per §6.
9. Validate against schema v0.1.1 per §7 (both passes; aggregate violations).
9a. **[AB-9 / AB-stage 2026-05-09]** Detect re-capture and determine versioned packet path. Scan `<repo>/.trail/sessions/<session-id>/` for existing files matching the regex `^packet-(\d+)\.yml$`. Compute `next_n = max(N) + 1` if any match; else `next_n = 1`. The packet write target is `packet-<next_n>.yml` (and `packet-<next_n>.md`); the legacy `packet.yml` (no -N suffix) is no longer written. Populate `_meta.parent_packet_id`:
   - If `next_n == 1`: `parent_packet_id = null`.
   - If `next_n > 1`: read `packet-<next_n - 1>.yml`, parse `_meta.packet_id`, and assign that ULID to `parent_packet_id`. On parse failure of the prior packet (corrupt YAML, missing `_meta.packet_id`): emit stderr warning `"warning: parent packet packet-<N-1>.yml unreadable; setting parent_packet_id=null and continuing"` (bypasses `--quiet`), then proceed with `parent_packet_id = null`. The chain breaks at this run; downstream Phase 2 consumers handle the broken-chain case per B5 §5.4.
   See §X (AB-stage amendments) for full re-capture logic + rationale.
10. **[A4.5 / FAIL-03; A4.7 / R-COUPLING-01, R-FAIL-02]** Atomic write sequence:
    a. Serialize packet to YAML bytes (in-memory; locked options per §10).
    b. Layer 2 scan over those bytes (in-memory; per §5).
    c. If `--strict-redaction` AND `validation_errors` non-empty → exit 5; emit Layer 2 stderr summary per §5 step 5 (one line per pattern, with hash snippet; **bypasses `--quiet`** per §3 `--quiet` flag definition); do NOT write packet to disk. (See §8.1 step 8b — strict-redaction is detection-order step 8b, distinct from schema-validation step 8.)
    d. Write `validation_errors` back into in-memory packet; re-serialize to final YAML bytes.
    e. **[A4.7 / R-COUPLING-01]** Layer 2 stderr warning emitted BEFORE writes (when `validation_errors` non-empty AND step 10c didn't exit). Format per §5 step 8. **Bypasses `--quiet`** (security warning). The warning fires before write so the user sees it even if the write fails.
    f. **[AB-9 / AB-10]** Write `packet-<N>.yml` via tmp+rename: `packet-<N>.yml.tmp` → atomic rename to `packet-<N>.yml`, where `N` is determined per step 9a. (Legacy unversioned `packet.yml` no longer written.)
    g. Render and write `packet-<N>.md` via tmp+rename (when `--format` includes `md`).
    h. **[A4.5 / P2-SEC-14; A4.7 / R-SEC-3]** When `packet-<N>.md` written: stderr notice `"note: packet-<N>.md may contain unredacted file excerpts. Review before sharing externally."` **Bypasses `--quiet`** (Decision-#3-bounds notice; per §3 `--quiet` flag definition).
    i. Layer 2 storage row write via Drizzle, in a transaction. On DB write failure: keep files, log warning to stderr, continue (best-effort storage; per §13 #10 deferral story). If `.trail/trail.db.broken` marker exists from a prior failed run, suppress the per-run warning and emit a single line: `"note: storage disabled — see .trail/trail.db.broken; v0.2 adds 'trail storage reset'"`. (See R-FAIL-08 in design-review for alarm-fatigue rationale.)
11. Print one-line summary to stderr: `packet <packet-id> (packet-<N>) for session <session-id> ({N} claims, {M} redactions, {K} validation_errors) → .trail/sessions/<session-id>/packet-<N>.yml`. (Where `<N>` is the version determined in step 9a.)
12. Exit 0.

## 4. I/O contracts

### Input sources

| Source | Required? | Purpose |
|---|---|---|
| `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl` | Yes | Transcript master. |
| Inline `tool_result` blocks (in `user`-typed records' `message.content` arrays) | Yes (within transcript) | Tool stdout/stderr + Edit/Write/MultiEdit return values. Read inline; do NOT consult `~/.claude/projects/<sanitized-cwd>/<session-id>/tool-results/*` directories in Phase 1. |
| `~/.claude/file-history/<session-id>/*` | **Out of scope for Phase 1** | Excerpt content comes from tool_use INPUT fields (`old_string`/`new_string`/`content` for Edit/Write/MultiEdit). |
| Working directory's `.git/` | Yes | simple-git read for `pr.*` and `diff_summary.*`. |
| Redaction patterns YAML | Yes | Default: package-bundled `bin/trail-redaction-patterns.yml`. Override via `--patterns <path>`. |
| `<package-bundled>/bin/trail-test-runners.yml` | Yes | Test-runner detection patterns. |

### Asset resolution mechanism (package-bundled files)

**[A4.5 / P1-COUPLING-05]** Bundled assets resolve via `new URL('./bin/<file>', import.meta.url)` from the package's `src/` (or `dist/` post-build). Build step (`pnpm --filter @trail/capture build`) copies `apps/capture/bin/` into `apps/capture/dist/bin/` so the same resolver works pre- and post-build. Phase 2 UI subprocess invocation passes through the same resolver. Phase 4 npm publish includes `bin/` in `package.json#files`.

**[A4.7 / R-COUPLING-07] ESM commitment**: `import.meta.url` requires ESM module system. `apps/capture/package.json` MUST set `"type": "module"`. Phase 4 npm publish commits to ESM-only `"exports"` field — no CJS bridge in v0.1. Phase 2 Tauri shell consuming `@trail/capture` is ESM-aware (via Vite + Tauri's renderer process). If a future commercial-product use case needs CJS interop, add a CJS bridge in v0.2+ — out of scope for v0.1.

### Output destinations

| Output | Format | Path |
|---|---|---|
| Canonical packet | YAML, schema-conforming v0.1.1 | `<repo>/.trail/sessions/<session-id>/packet.yml` |
| Human render | Markdown | `<repo>/.trail/sessions/<session-id>/packet.md` |
| Layer 2 row | Drizzle ORM `packets` insert + linked `claims` + `evidence` + `redaction_audit` rows | Local SQLite at `<repo>/.trail/trail.db` |
| Stderr | one-line summary on success; multi-line on error; security warnings bypass `--quiet` | stderr |
| Stdout | empty unless `--dry-run` (which prints `{N claims, M redactions, validation_errors=K}` JSON) | stdout |

The `.trail/` directory is created on demand. Trail does NOT modify `.gitignore` (only emits stderr notice on first run if not gitignored — see §3 step 7).

### Field-level mapping

| Schema field | Source / construction |
|---|---|
| `_meta.packet_id` | ULID generated at packet finalization (NOT session start). |
| `_meta.generated_at` | ISO 8601 from `Date.now()` at finalization. **Format: `YYYY-MM-DDTHH:mm:ss.sss+00:00`** (NOT `Z`). |
| `_meta.generator.name` | `"trail"`. |
| `_meta.generator.version` | `package.json#version` of `@trail/capture`. |
| `_meta.schema_url` | Constant pointer: `"schema/pr-change-packet.v0.1.1.yml"` (relative path). |
| `_meta.capture_method` | `"post_hoc"` (constant for Phase 1). |
| `pr.provider` | `"github"` (constant). |
| `pr.repository` | **[A4.5 / SEC-2; A4.7 / R-SEC-4]** simple-git remote URL → `owner/repo`. **Mandate userinfo strip**: ALL URL fields in the packet MUST pass through a single helper `stripUserinfo(url: string): string` (lives in `apps/capture/src/git/state.ts`; or `src/url/sanitize.ts` if multiple modules consume it). Inline parsing is forbidden — future schema fields bearing URLs MUST cite this helper. Example: `https://x-access-token:ghp_xxx@github.com/foo/bar.git` → `foo/bar` (token discarded; not stored in any field). Falls back to repo dirname if remote missing. |
| `pr.branch` | simple-git current branch. |
| `pr.base_branch` | simple-git heuristic: `origin/main`, `origin/master`, then local `main`/`master`. Empty if none resolves. |
| `pr.pr_number` | null in Phase 1. |
| `pr.author` | git committer email (`git config user.email`). **PII**; see §1.1. |
| `task_intent.source_type` | `"prompt"`. |
| `task_intent.source_ref` | `"PROMPT-001"` if any prompt captured; else empty. |
| `task_intent.summary` | Initial prompt → tag-strip → 1200-char truncate → redact → whitespace-collapse (`\s+→' '`) → 200-char truncate. |
| `task_intent.acceptance_criteria` | empty list in v0.1. |
| `agent_session.tool` | `"claude-code"`. |
| `agent_session.model` | **Last assistant model seen** (back-compat; deprecated for `models[]`). |
| `agent_session.models[]` | Array of unique model strings, first-encounter order. Sessions with model switches populate multiple. |
| `agent_session.started_at` / `ended_at` | First / last ISO timestamp in transcript. Parse to Date for ordering; emit ISO with `+00:00` suffix. |
| `agent_session.session_id` | Filename of the `.jsonl` minus extension. |
| `agent_session.transcript_summary` | Mechanical: deduped tool_use names + first sentence of first assistant text block, then Layer 1 redaction. (LLM-augmented when available.) Tool_use names are pass-through after Layer 1 redaction; recommend MCP integrations not encode secrets in tool names (P3-SEC-7 documented limitation). |
| `agent_session.prompts.initial` | First user message. **Pipeline: tag-strip (`<[^>]+>`) → empty-check (skip if empty) → 1200-char truncate → redact**. |
| `agent_session.prompts.followups` | Subsequent user messages, same pipeline; `prompt_n` increments only on non-empty. |
| `agent_session.redaction_metadata.pattern_set_version` | `version` field from active patterns YAML (default or `--patterns`-provided). Required non-empty; **no fallback**. |
| `agent_session.redaction_metadata.pattern_set_origin` | **[A4.7 / R-SEC-1; v0.1.1 additive]** Enum `{"bundled", "user-supplied"}`. `"bundled"` when the default `<package-bundled>/bin/trail-redaction-patterns.yml` is in use; `"user-supplied"` when `--patterns <path>` was passed. Downstream consumers (Phase 3a Layer 3 audit; Phase 5+ cloud sync) MUST NOT trust `pattern_set_version` alone when `origin == "user-supplied"` — the user controls the version string and could declare any value. Origin is the integrity signal; version is the compatibility hint. |
| `agent_session.redaction_metadata.redactions_applied` | Sum across all redactions. |
| `agent_session.redaction_metadata.redactions_by_pattern` | `{pattern_name: count}`, alphabetically sorted. |
| `agent_session.redaction_metadata.validation_errors` | Layer-2 catches; one entry per pattern (NOT per match). Format: `{pattern: name, snippet: <8-char-hex>}`. **[A4.5 / P2-SEC-9; A4.7 / R-COUPLING-02]** Snippet is **8 hex characters (4 bytes)** — `sha256(match).hexdigest()[:8]` — never the raw match. Locked across §4, §5, schema YAML, and Appendix A `layer2.ts`. |
| `agent_session.redaction_metadata.skipped_files` | Files where memory-only snapshot was skipped (size cap; see §9). |
| `diff_summary.base_sha`, `head_sha` | simple-git refs. |
| `diff_summary.files_changed` | Git diff stat count. |
| `diff_summary.lines_added`, `lines_deleted` | Git diff stat. |
| `diff_summary.modules_touched` | Dedup'd top-level dirs of changed files **inside the repo root only**. **Metadata leak**; see §1.1. |
| `diff_summary.semantic_changes` | One per Edit/Write/MultiEdit tool use. Single-file per entry. Each gets `DIFF-NNN`. |
| `diff_summary.semantic_changes[].id` | `DIFF-NNN`. |
| `diff_summary.semantic_changes[].description` | Tool-specific format (Write/Edit/MultiEdit; see §4 Excerpt construction). |
| `diff_summary.semantic_changes[].files` | Single-element array. |
| `diff_summary.semantic_changes[].operation` | Lowercase: enum `{"write", "edit", "multiedit"}`. |
| `diff_summary.semantic_changes[].excerpts[]` | See §4 Excerpt construction below. **NOT redacted** (Decision #3). |
| `commands_run` | One entry per Bash tool use. `CMD-NNN` IDs. |
| `commands_run[].command` | Bash command string → 500-char truncate → redact. |
| `commands_run[].exit_code` | **[A4.5 / P2-TESTS-13]** Always `0` in Phase 1. Exit-code parsing from `tool_result` text deferred to v0.2 (matches py-reference behavior; locks parity oracle). |
| `commands_run[].duration_ms` | Always `0` in Phase 1; parsing deferred to v0.2. |
| `commands_run[].stdout_summary` | Concatenated tool_result text → 1200-char truncate → redact. |
| `commands_run[].stderr_summary` | Always empty string in Phase 1 (Claude Code mixes stderr into result text; splitting deferred to v0.2). |
| `test_evidence.passed[]`, `failed[]`, `not_run[]` | Heuristic detection per `bin/trail-test-runners.yml` patterns + (when extractable) exit codes. With Phase 1 exit codes locked at 0, all detected tests land in `passed[]`. |
| `test_evidence.passed[].id` | `TEST-NNN`. |
| `test_evidence.passed[].ref` | **[A4.5 / SEC-1]** First 140 chars of the bash command, **THEN redacted**. (Previous version captured raw unredacted command — SEC-1 fix.) |
| `test_evidence.passed[].cmd_ref` | Back-pointer to `CMD-NNN`. |
| `provenance.authorship.ai_generated_estimate` | Constant `"high"` for Phase 1. |
| `provenance.authorship.human_modified_estimate` | Constant `"unknown"` for Phase 1. |
| `provenance.authorship.method` | Constant `"post-hoc-transcript"` for Phase 1. |
| `provenance.agent_touched_files` | Files modified by Edit/Write/MultiEdit tool uses (deduped). |
| `provenance.human_touched_files` | Empty array in Phase 1. |
| `summary.claims` | See §6. |
| `summary.claims[].synthesis_mode` | `"mechanical"` or `"llm"` per claim. |
| `summary.ungrounded_claim_count` | Always populated, even when 0. |

### Excerpt construction (semantic_changes[].excerpts[])

Source: tool_use INPUT fields. **NOT redacted on disk** (Decision #3). Caps:
- `MAX_EXCERPT_CHARS = 1200` per excerpt.
- Elision rule: if input string > 1200 chars, slice `head = input[:1200-200]` + `\n... [elided N chars] ...\n` + `tail = input[-150:]`.

| Tool | Excerpt structure |
|---|---|
| Write | One excerpt: `kind: "after"`, `text: <content>`, `elided: bool`. Description: `"Wrote {file} ({char_count} chars)"`. |
| Edit | Two excerpts: `kind: "before"` (`old_string`), then `kind: "after"` (`new_string`). Description: `"Edited {file}"`. |
| MultiEdit | Up to 5 hunks (silent cap). For hunks 1..N: `kind: "before#1"`/`"after#1"`, etc. **[A4.5 / P1-TESTS-05]** Hunks beyond #5: silently dropped, but emit stderr notice (suppressed by `--quiet`): `"note: dropped {N} MultiEdit hunks beyond cap of 5"`. Description: `"MultiEdit on {file} ({hunk_count} hunk(s))"`. |

### tool_use input fallbacks

If a tool_use lacks expected input fields (malformed transcript), skip the corresponding semantic_change entry. Do NOT crash. Increment a `skipped_changes` counter (logged to stderr if `--quiet` is not set).

### Length caps summary

| Field | Cap | Notes |
|---|---|---|
| Initial prompt before redaction | 1200 chars | After tag-strip, before redact. |
| Followup prompts before redaction | 1200 chars | Same pipeline. |
| `task_intent.summary` | 200 chars | After redaction + whitespace collapse. |
| `commands_run[].command` | 500 chars | Before redaction. |
| `commands_run[].stdout_summary` | 1200 chars | Before redaction. |
| `commands_run[].stderr_summary` | n/a | Always empty in Phase 1. |
| `test_evidence.passed[].ref` | 140 chars | **Before redaction**, then redacted (per A4.5 SEC-1). |
| Excerpts | 1200 chars each | Head=1000, tail=150, elision marker between. |

## 5. Redaction contract

Three-layer redaction architecture. Phase 1 ships Layer 1 + Layer 2; Layer 3 is Phase 3a.

### Layer 1 — Capture-time redaction

Applied during transcript parse, BEFORE any value reaches the in-memory packet. Fields:
- `agent_session.prompts.initial`
- `agent_session.prompts.followups[*]`
- `agent_session.transcript_summary[*]`
- `commands_run[*].command`
- `commands_run[*].stdout_summary`
- `task_intent.summary`
- **[A4.5 / SEC-1]** `test_evidence.passed[*].ref` (NEW; previously unredacted by spec/py-reference)

**Excluded from Layer 1**: `semantic_changes[*].excerpts[*].text` (Decision #3 — file-content slices, gated by user's commit decision; Layer 3 is the architectural backstop). Excerpt non-redaction has documented bounds (see §1.1 + §3 step 7 gitignore notice + §3 step 10h packet.md sharing notice + §6 LLM-prompt redaction below). Until Phase 3a ships, excerpts on disk are user's-commit-decision-gated. Risk assumed for v0.1 OSS solo.

**[A4.5 / SEC-3 / P1-COUPLING-02]** **Excerpt redaction at LLM-subprocess boundary (different scope from on-disk)**: When constructing the LLM prompt in §6, excerpt content passed as `excerpt_preview` MUST be Layer-1-redacted. This is a different trust boundary than the on-disk packet. The `claude -p` subprocess transmits prompt input to Anthropic's API; Decision #3's "Layer 3 catches it on disk" reasoning does not apply — the data has already crossed the boundary. The TS implementation must import `redaction/layer1.ts` in `claims/llm.ts`'s prompt-build path and redact before subprocess invocation.

Replacement format: matched substrings replaced with `[REDACTED:<pattern-name>]`.

Pattern source: active patterns YAML (default or `--patterns <path>`). Load → record `version` field into `redaction_metadata.pattern_set_version`; record origin (`"bundled"` or `"user-supplied"`) into `redaction_metadata.pattern_set_origin` (NEW v0.1.1 field per A4.7 R-SEC-1). **No fallback default**.

**[A4.7 / R-SEC-2]** **Singleton load**: Patterns YAML is loaded EXACTLY ONCE per `trail packet generate` invocation, in §3 default-behavior step 5 (after CLI-args validation). `redaction/patterns.ts` exports a singleton accessor cached per-process. All three redaction call sites (`redaction/layer1.ts` for in-memory packet construction; `redaction/layer2.ts` for write-time scan; `claims/llm.ts` for excerpt-preview redaction at LLM-subprocess boundary) MUST consume the same in-memory `Pattern[]` array — no second disk read. This eliminates a TOCTOU race where the YAML file changes between two reads producing divergent pattern sets across layers.

**[A4.7 / R-COUPLING-06]** **Layer 1 counter semantics with overlapping patterns**: when multiple patterns match the same byte range (e.g., a Slack token also matches `high-entropy-string`; a Sentry DSN also matches `url-userinfo`), Layer 1 uses **first-match-wins per byte-range**, with patterns evaluated in alphabetical order (deterministic tiebreaker). Each match increments exactly ONE counter (the winning pattern's). Aligns with Layer 2 step 3's `regex.search` first-match-wins behavior — both layers are behaviorally consistent. Output sorted alphabetically by pattern_name; `redactions_applied` is the sum.

### Layer 2 — Write-time validation (atomic-write contract)

**[A4.5 / P1-FAIL-04]** Atomic-write contract — Layer 2 operates entirely in-memory until the final atomic write. Pipeline:

1. **Serialize in-memory** packet to YAML bytes (locked options per §10): `default_flow_style: false, sort_keys: false, allow_unicode: true, width: 120`. NO disk write at this step.
2. **Strip redaction markers** (regex `\[REDACTED:[a-z0-9-]+\]`) from in-memory bytes. Resulting scratch buffer.
3. **Run all patterns** against scratch buffer with `regex.search` (first match per pattern wins; one entry per pattern in `validation_errors`, NOT per match).
4. **For each match**: append `{pattern: name, snippet: sha256(match).hexdigest()[:8]}` to `redaction_metadata.validation_errors`. Snippet is **8 hex characters (4 bytes)**, NEVER the raw match (P2-SEC-9 + R-COUPLING-02: 8 hex chars is debuggable across builds + non-recoverable for any practical secret length). Lock the same length across §4, §5, schema YAML, and Appendix A — any phrasing must resolve to "8 hex characters" (NOT "8 bytes" which reads as 16 hex chars).
5. **`--strict-redaction` gate** (per §3): if `validation_errors` non-empty AND `--strict-redaction`, exit 5 immediately. Do NOT write packet to disk. Print stderr summary listing each pattern caught (with snippet hash, NOT raw match).
6. **Write `validation_errors` back** into in-memory packet (mutates the packet object).
7. **Re-serialize** to final YAML bytes.
8. **Emit Layer 2 stderr warning BEFORE write** (when `validation_errors` non-empty AND not `--strict-redaction`-exited): `"warning: redaction Layer 2 found {N} pattern(s) escapees in <packet-path>: <pattern-list>"`. **Bypasses `--quiet`** — security warnings always print. The warning fires before the write so the user sees it even if the write fails.
9. **Atomic write**: write to `packet.yml.tmp`, then rename → `packet.yml` (POSIX atomic). On any I/O failure: unlink tmp file, exit 6, dump `validation_errors` to stderr (so they aren't silently lost).

The on-disk bytes always include `validation_errors` populated correctly (per step 6 in-memory mutation). The final write is atomic-or-failed; no torn states.

### Layer 3 — Pre-commit audit (Phase 3a; out of scope here)

Documented for completeness. Required architectural backstop for excerpt safety per §5 Layer 1 exclusion. Until Phase 3a ships, the `.gitignore` notice (§3 step 7) and `packet.md` sharing notice (§3 step 10g) are the user-facing mitigations.

### Layer 1 in-memory redaction-preview cache — **[AB-7 / AB-stage 2026-05-09; OPTIONAL]**

**Status**: Opt-in. Phase 1 v0.1 is NOT REQUIRED to implement. UI affordance gracefully degrades to "preview unavailable" when absent (per B5 §8 AB-7 row).

**Purpose**: Enable Phase 2 J4 (redaction-preview affordance — surface what was redacted to a reviewer who clicks a `[REDACTED:slack-token]` marker) without requiring re-read of the source transcript.

**Contract** (when implemented):
- Scope: SESSION-ONLY, in-memory, never written to disk. Cleared at process exit.
- Shape: `Map<redaction_id: string, { pattern_id: string, original_byte_length: int, hash_8: string, location_hint: string }>` keyed by a synthetic `redaction_id` written into the redacted output (e.g., `[REDACTED:slack-token#R-001]`).
- The original matched bytes are NEVER stored in the cache — only a fixed-length sha256 prefix (`hash_8`, 8 hex chars per A4.5 P2-SEC-9 / A4.7 R-COUPLING-02). This means the cache reveals match LOCATION + PATTERN but not match CONTENT.
- Exposed via Tauri IPC `preview_redacted({ packet_id, redaction_id })` — but only for the running process's own captures. The IPC handler returns `{ original: null, error: "preview unavailable: cache not populated for this packet" }` when the cache is empty (e.g., on packet open from disk by a fresh process).
- v0.1 default: cache is **disabled**. v0.1.x may flip the default per UI demand; v0.2 may evaluate persisting a redacted-preview cache to encrypted on-disk storage (out of scope here).

**Why opt-in for v0.1**: shipping the in-memory cache costs ~100 LOC + a Tauri IPC, and the UI degrades gracefully without it. Defer until UI usability data shows the affordance is missed.

## 6. Claim synthesis contract

### Synthesis mode (per-claim)

Every claim carries `synthesis_mode: "mechanical" | "llm"` per schema v0.1.1. Mixed-mode runs are normal — LLM mode falls back to a mechanical "Ran N test/validation command(s)" rollup claim regardless of mode.

### Mechanical synthesis (default fallback; controllable via `--per-diff`)

Two grouping modes:

**Per-file (default)**:
- For each unique file across `semantic_changes[*]`, produce one claim:
  - `id`: `CLAIM-NNN`
  - `text`: `"{actions} on {file} ({n} change(s))"` where `actions = sorted({operation lower-case for diffs of this file}).join('/')`.
  - `evidence_refs`: all DIFF-NNN IDs for this file + matching TEST-NNN + matching CMD-NNN.
  - `confidence`: constant `"supported"`.
  - `synthesis_mode`: `"mechanical"`.
- Plus, if test_evidence non-empty: append `"Ran N test/validation command(s)"` rollup claim.

**Per-DIFF (`--per-diff`)**:
- One claim per `semantic_changes[*]` entry; same structure, `evidence_refs: [DIFF-NNN, ...matching TEST/CMD]`.
- Test rollup claim appended same as per-file.

### LLM-augmented synthesis

LLM mode operates **per-file groups** regardless of `--per-diff` flag. Design:

1. Group `semantic_changes[*]` by file → `file_groups[]`.
2. **[A4.5 / SEC-3; A4.7 / R-SEC-6]** Compose prompt asking the LLM to produce one English sentence per file group describing what changed. Prompt includes: file path, diff descriptions, **Layer-1-redacted bounded excerpt previews** (3 diffs × 2 excerpts × 200 chars total budget ≤1200 chars), and a redacted 600-char snippet of the initial prompt. **Order of operations (locked) for excerpt previews**: (1) take the full §4-constructed excerpt (≤1200 chars, head+elision+tail; **un-redacted** per Decision #3); (2) apply Layer-1 redaction to the full excerpt — this guarantees a secret crossing any later slice boundary is matched by patterns against the complete string; (3) slice the redacted text to the 200-char preview budget; (4) compose into LLM prompt. **DO NOT** slice first then redact — a secret straddling char 200 would slip past pattern matching when only its leading half remains.
3. **Subprocess invocation** via `claims/llm-subprocess.ts` (DI seam per Appendix A; testable with injected runner):
   ```
   claude -p \
     --model <model> \
     --output-format text \
     --no-session-persistence \
     --max-budget-usd <budget>
   ```
   **[A4.5 / P2-FAIL-09]** Timeout: `--llm-timeout-seconds` (default 120s). On timeout: send SIGTERM to subprocess; wait 5s for clean exit; if still alive, SIGKILL. Use a process-tree-kill helper to reap descendants (the `claude` CLI may spawn children). Stderr: `"LLM subprocess timed out after {N}s; killed"`.
4. LLM output: JSON array `[{"file": "<path>", "claim": "<sentence>"}, ...]`. Output is fence-stripped (` ```json ... ``` ` → `...`) before parse.
5. **Evidence_refs are inferred mechanically**, not picked by the model: for each LLM claim, look up file in `file_groups` → use that group's DIFF/TEST/CMD refs. The model never invents IDs.
6. Each LLM claim → `synthesis_mode: "llm"`.
7. Quality gate: if `len(parsed) < len(file_groups)`, fall back to mechanical for the entire run.
8. Append the mechanical test-rollup claim (with `synthesis_mode: "mechanical"`) regardless.

### LLM failure handling

**[A4.5 / FAIL-13]** Six fallback triggers (each → mechanical fallback unless `--strict-llm`, which exits 7):

1. `claude` CLI absent on PATH (subprocess spawn fails).
2. Subprocess non-zero exit. **IGNORE stdout entirely**, regardless of whether stdout looks parseable. Exit 0 is the only "trust this output" gate.
3. Subprocess timeout (per step 3 above).
4. stdout non-JSON or fence-strip didn't yield JSON.
5. JSON parsed but `len(parsed) < len(file_groups)` (quality gate).
6. JSON parsed but file paths don't match `file_groups` (quality gate; lookup returns no match).

Stderr emits `"LLM synthesis failed: <reason>; falling back to mechanical"` for each trigger (suppressed by `--quiet`).

### Universal rules

- Every claim MUST have `evidence_refs.length > 0`. Per-file mechanical guarantees by construction; per-DIFF mechanical guarantees by construction; LLM mode guarantees because evidence_refs are inferred from `file_groups`.
- All cited refs MUST resolve. Validation runs in §7's post-build pass; failure → exit 5.
- `summary.ungrounded_claim_count` always populated.
- **[AB-5 / AB-stage 2026-05-09]** Every claim MUST carry a deterministic `stable_id` (16-char lowercase hex) computed as `sha256(session_id || '|' || claim_text || '|' || position).hexdigest()[:16]`, where `position` is the 0-indexed insertion position of the claim in `summary.claims` BEFORE any reordering. The visible `id` (CLAIM-NNN) remains the human-facing label; `stable_id` is the deterministic key consumed by libSQL (`claims.claim_id`) and Phase 2 carry-forward. Re-captures of the same session that produce the same claim text at the same position MUST yield identical `stable_id` values — this is the key invariant for AB-5 compliance and for the carry-forward computation in B5 §5.4. **Inputs locked**: `session_id` is the transcript filename minus `.jsonl`; `claim_text` is the post-redaction text written to YAML; `position` is the integer index in claims (0-based, NOT CLAIM-NNN string parsed). Test rollup claims (`"Ran N test/validation command(s)"`) follow the same algorithm — their stable_id depends on N changing between runs, which is acceptable (test count delta IS a meaningful diff).

## 7. Schema conformance

The packet MUST satisfy every rule in `schema/pr-change-packet.v0.1.1.yml` validation rules:
- `packet_version` ∈ `{"0.1", "0.1.1"}`
- All evidence_refs in `summary.claims` resolve to existing IDs
- `agent_session.started_at <= agent_session.ended_at` (parsed as Date, NOT lex compare)
- `diff_summary.semantic_changes` IDs unique
- `commands_run` IDs unique
- `test_evidence` entry IDs unique
- At least one of (semantic_changes, commands_run, test_evidence) non-empty
- `agent_session.redaction_metadata.pattern_set_version` non-empty
- `diff_summary.semantic_changes[].operation` ∈ `{"write", "edit", "multiedit"}`
- `diff_summary.semantic_changes[].files` is single-element array
- `claims[].synthesis_mode` ∈ `{"mechanical", "llm"}`
- `_meta.capture_method` ∈ `{"post_hoc"}` for v0.1.1
- **[A4.5 / FAIL-19]** If any v0.1.1-only field is present (any of `_meta.capture_method`, `agent_session.models[]`, `claims[].synthesis_mode`, `test_evidence.passed[].cmd_ref`), `packet_version` MUST be `"0.1.1"`. Prevents semantic-v0.1.1 packets from being falsely labeled `"0.1"`.

### Validation passes

Validation runs as TWO passes via Ajv (split into two TS modules per Appendix A — `packet/validate-schema.ts` for Ajv structural; `packet/validate-refs.ts` for pure cross-reference):

1. **Pre-write structural pass** — Ajv against `pr-change-packet.v0.1.1.schema.json`. Captures shape violations.
2. **Post-build cross-reference pass** — pure TS logic. Every cited evidence_ref resolves to a packet ID.

**[A4.5 / FAIL-08; A4.7 / R-FAIL-04, R-COUPLING-05]** Both passes ALWAYS run, regardless of pass-1 outcome. Aggregate ALL violations into a single exit-5 stderr block. Format (locked):
```
packet would violate schema: <total-count> error(s)
  [structural] <ajv-error-path>: <ajv-error-message>
  [structural] ...
  [refs] <ref-id> not found in <packet-section>
  [refs] ...
```
The orchestrator (`apps/capture/src/generate.ts`) collects `ValidationError[]` from both passes (via `validate-schema.ts` and `validate-refs.ts`); merges into the format above; emits to stderr; exits 5. Short-circuit only at the boundary between "validate" and "write" — never within the validate phase.

**[A4.7 / R-FAIL-04]** **Validator internal exceptions** (Ajv compile failure, malformed JSON Schema in repo, OOM during compile of recursive schema) are NOT validation rule violations but should not crash to exit 1 either. Wrap as `SchemaValidatorInternalError` → exit code 5 with stderr line `"  [internal] schema validator internal error: <error class>: <details>"` prepended to the standard format. Pass 2 still runs after pass 1 throws; its result joins the aggregated stderr. The §8 row 1 explicit `error class → exit code` map MUST list at least: `AjvCompileError`, `YamlParseError`, `GitOperationError`, `JsonParseError`, `ChildProcessError`, `SchemaValidatorInternalError` — adds finite-set rigor to the "near-empty unmapped set" goal.

If either pass fails → exit 5; do NOT write.

Formal JSON Schema (`schema/pr-change-packet.v0.1.1.schema.json`) is a Phase 1 deliverable (per Appendix B codegen toolchain).

## 8. Failure modes & exit codes

py-reference (uncaught Python exceptions) does NOT meet this contract. TS port adds proper error handling.

### 8.1 Detection order (precedence)

**[A4.5 / FAIL-01; A4.7 / R-FAIL-01]** When multiple error sources are simultaneously present, exit codes surface in this fixed order. Short-circuit on first failure; do NOT collect multiple error categories.

```
1.  CLI argument parsing/validation                                  → exit 8
2.  Git repo presence + state                                         → exit 3
3.  Transcript discovery                                              → exit 2
4.  Pattern file load (default or --patterns; size + alias-bomb +
    binary + zero-pattern + ReDoS gates per §3 --patterns flag)       → exit 4
5.  Test-runner pattern file load                                     → exit 4
6.  Extraction (transcript walk)                                      → exit 1 (caught and mapped)
7.  LLM synthesis (only if --strict-llm)                              → exit 7
8.  Schema validation (both passes; aggregated; SchemaValidatorInternalError
    per §7 also routes here)                                          → exit 5 (schema cause)
8b. Layer 2 strict-redaction gate (only when --strict-redaction set;  → exit 5 (strict-redaction cause;
    runs as part of write phase 9, but logically a distinct gate         distinct stderr shape per
    that surfaces exit 5 BEFORE actual write)                            §3 step 10c)
9.  Write (atomic file rename) or storage                             → exit 6
```

**[A4.7 / R-FAIL-01]** Two distinct exit-5 causes (step 8 schema validation, step 8b strict-redaction) share the exit code but emit distinct stderr shapes — `"packet would violate schema: <list>"` vs `"--strict-redaction: Layer 2 found {N} pattern(s); refusing to write: <per-pattern hash list>"`. CI tests asserting on exit 5 MUST also assert on stderr shape to disambiguate root cause. Future v0.2 may allocate a separate exit code for strict-redaction; keeping shared code 5 in v0.1 minimizes the exit-code footprint.

Within validation (step 8), passes accumulate (per §7). Within write (step 9), atomic rename either succeeds or fails as a unit.

### 8.2 Signal handling

**[A4.5 / FAIL-05; A4.7 / R-FAIL-03, R-FAIL-05]** SIGINT (Ctrl-C) and SIGTERM trigger clean abort with the following ordered cleanup (REVERSE of step 10):
- **Tree-kill any in-flight LLM subprocess** with SIGKILL immediately (no SIGTERM grace — user has signaled urgency). Wait up to 1s for tree-kill to complete; on tree-kill failure, log to stderr `"warning: LLM subprocess <pid> may have leaked; check 'ps' for stragglers"` and proceed.
- Rollback any open Drizzle transaction (step 10i).
- Unlink `packet.md.tmp` if present (step 10g).
- Unlink `packet.yml.tmp` if present (step 10f).
- Files already renamed are LEFT IN PLACE (post-rename = durable; matches §5 atomic-or-failed contract per file). Packet.yml-without-packet.md is documented as an acceptable post-signal state — equivalent to running with `--format yaml`.
- Exit 130 (128+SIGINT) or 143 (128+SIGTERM).
- Stderr: `"trail aborted on <signal>"`.

### 8.3 Exit code table

| Code | Meaning | Stderr message shape |
|---|---|---|
| 0 | Success | `packet <packet-id> for session <session-id> ({N} claims, {M} redactions, {K} validation_errors) → .trail/sessions/<session-id>/` |
| 1 | Generic / unhandled | error class + message + truncated stack. **Goal: this exit code is rarely reached. The TS implementation installs a top-level try/catch with explicit `error class → exit code` mapping; only unmapped errors reach exit 1.** |
| 2 | Transcript not found | sub-shapes (per FAIL-07): (a) `"no Claude Code projects directory at ~/.claude/projects/"`; (b) `"no sessions for this cwd at ~/.claude/projects/<sanitized-cwd>/"`; (c) `"session id <id> not found in <path>"`. |
| 3 | Git state unreachable | sub-shapes (per FAIL-11): (a) cwd not a git repo: `"not a git repository: <path>"`. (b) git repo but operation throws (corrupt index, permissions): `"git state corrupt: <details>"`. (c) successful runs with empty optional fields (no remote → `pr.repository = ""`; no base branch → `pr.base_branch = ""`; no user.email → `pr.author = ""`) do NOT exit 3; they succeed with empty values per §4 mapping rules. |
| 4 | Pattern file missing/unparseable/invalid | **[A4.7 / R-FAIL-06, R-COUPLING-04]** stderr message MUST name which YAML failed (`bin/trail-redaction-patterns.yml` or `bin/trail-test-runners.yml` or user-supplied path). Sub-shapes: (a) `"failed to load <path>: file not found"`. (b) `"failed to load <path>: YAML parse error: <details>"`. (c) `"failed to load <path>: 'version' field missing or empty"`. (d) `"failed to compile pattern '<name>': <regex error>"`. (e) **NEW** `"failed to load <path>: 'patterns' array empty or missing — refusing to run with zero redaction patterns"` (fail-closed against zero-pattern silent degradation). (f) **NEW** `"failed to load <path>: file size <N> bytes exceeds 64KB cap"`. (g) **NEW** `"failed to load <path>: file contains binary content (non-UTF-8 / non-YAML bytes)"`. (h) **NEW** `"failed to load <path>: pattern '<name>' execution timed out (50ms; possible ReDoS)"`. |
| 5 | **[A4.9 / R8-FAIL-02]** Four distinct causes — disambiguated by stderr shape: (i) Schema structural validation failure (Ajv pass 1) → `"packet would violate schema: <count> error(s)\n  [structural] ..."`. (ii) Cross-reference validation failure (pass 2) → same format with `"  [refs] ..."` lines. (iii) Schema validator internal error (Ajv compile throw, malformed JSON Schema) → same format with `"  [internal] schema validator internal error: <error class>: <details>"` line. (iv) `--strict-redaction` gate (§8.1 step 8b) → `"--strict-redaction: Layer 2 found {N} pattern(s); refusing to write: <per-pattern hash list>"` (NO "[structural/refs/internal]" prefix). CI tests asserting on exit 5 MUST also assert on stderr shape regex to disambiguate. |
| 6 | Output destination not writable | `"cannot create/write <path>: <details>"`. Tmp file unlinked. validation_errors dumped to stderr if non-empty (so they aren't lost). |
| 7 | LLM subprocess failed AND `--strict-llm` set | `"LLM synthesis failed and --strict-llm prevents fallback: <details>"`. |
| 8 | Invalid CLI args | `"invalid args: <details>"` + usage hint. |
| 9 | Concurrent invocation (advisory file lock held by another process) | **[A4.5 / FAIL-06 documented as deferred; A4.7 / R-FAIL-11]** v0.1 ships with last-writer-wins; v0.2 adds advisory file-locking + this exit code. **Phase 1 v0.1 actual worst-case state**: concurrent invocations on the same session-id can produce torn packets — `last-writer-wins is per-file, NOT per-packet`. With three write boundaries (10f packet.yml, 10g packet.md, 10i Drizzle DB), interleaving can yield: B's yaml + A's md + neither's DB row. Phase 1 user docs MUST surface this: "Concurrent `trail packet generate` on the same session-id may produce a torn packet (yaml + md + DB row from different invocations). v0.2 adds file-locking + atomic per-packet writes." |
| 130 | SIGINT (Ctrl-C) | `"trail aborted on SIGINT"`. |
| 143 | SIGTERM | `"trail aborted on SIGTERM"`. |

## 9. Performance contract

Reference hardware: M-series Mac, 16GB RAM, 2024-era SSD.

| Scenario | Bound |
|---|---|
| Typical session (≤50 turns, ≤500 tool uses, transcript ≤10MB) | < 30s wall, < 500MB peak RSS, mechanical mode |
| LLM-augmented mode | < 60s wall (subprocess overhead) |
| Pathological session (transcript ≥50MB, ≥5000 tool uses) | streaming line-reader required; SHOULD complete; not v0.1 hard requirement |

Implementation: TS uses streaming line-reader (`readline`) by default. Performance regression vs Python reference: TS port should not be more than 2x slower on the same fixture.

## 10. Parity oracle

Integration test for "Phase 1 done" is parity comparison against **regenerated canonical fixtures**.

**Fixtures** **[AB-10 / AB-stage 2026-05-09: versioned naming convention]**: under `py-reference/fixtures/sessions/<session-id>/` (NOT the legacy flat `py-reference/fixtures/canonical-session.yml`):
- `packet-1.yml` (mechanical default, first capture in chain)
- `packet-1-perdiff.yml` (`--per-diff`, first capture; same session, separate fixture for the per-DIFF mode)
- `packet-1.md` (markdown render of `packet-1.yml`)

A re-capture parity fixture (`packet-2.yml`, populated `_meta.parent_packet_id`) MAY be added by A7 to lock the AB-9 versioned-write logic; see A7 task scope. **Regenerated by py-reference AFTER backports land** (see §10.1). Source session: `18e374b5-4eb9-424d-a3ff-a639d1c6fada`.

**Migration note**: existing `canonical-session.yml` / `canonical-session-perdiff.yml` / `canonical-session.md` fixtures (flat layout) are SUPERSEDED. A7 (fixture regeneration) MUST produce the versioned layout above; the legacy flat fixtures are removed in the same A7 commit. References to "canonical-session.yml" elsewhere in this spec or in py-reference code are interpreted as `packet-1.yml` under the versioned layout post-A7.

### Mechanical-mode parity (`--no-llm`, default per-file)

1. Run `trail packet generate --no-llm 18e374b5-...` against an empty `.trail/sessions/18e374b5-.../` (fresh state — no prior packet-N.yml).
2. Compare output `packet-1.yml` to fixture `py-reference/fixtures/sessions/18e374b5-.../packet-1.yml`, byte for byte. **[AB-10]**
3. Allowed diffs: `_meta.packet_id` (ULID stochasticity), `_meta.generated_at` (timestamp).
4. Any other byte-level diff → test fails. **[AB-9]** `_meta.parent_packet_id` MUST be `null` on this first capture.

### Per-DIFF mode parity (`--no-llm --per-diff`)

1. Run with `--per-diff` against fresh state.
2. Compare output `packet-1.yml` to fixture `packet-1-perdiff.yml`. **[AB-10]**
3. Same allowed-diffs rule.

### Markdown parity

**[A4.5 / P2-COUPLING-08; §Y.1 / 2026-05-09]** packet.md byte-parity was originally **in scope** for Phase 1; deferred to v0.2 close-condition. v0.1 verifies structural parity (same headings, claim count, semantic content) vs py-reference live-transcript output; full byte-parity unblocked once frozen `<sid>.jsonl` lands per §Y.1.

1. Run with `--format md` (or default `--format both`) against fresh state.
2. Compare `packet-1.md` to fixture `packet-1.md`, byte for byte. **[AB-10]**
3. Allowed diffs: `_meta.packet_id` references in the "Generated by Trail v<version>" footer (since version + ULID surface there).
4. Any other byte-level diff → test fails.

This forces py-reference's `render.py` into the fixture-regen flow per §10.1 and locks the markdown render's structural rules (Appendix C) as parity-tested.

### LLM-mode test (non-deterministic)

- Schema-conforming packet with ≥1 LLM-synthesized claim AND `ungrounded_claim_count == 0`.
- Claim text NOT compared.
- `synthesis_mode` populated correctly (LLM claims `"llm"`; test rollup `"mechanical"`).

### YAML byte-identity rules (locked options; cross-engine deferred)

**[§Y.1 + §Y.4 / 2026-05-09]** YAML serialization options are LOCKED (below). Byte-identity vs canonical fixture YAML deferred to v0.2 per §Y.1 (frozen-transcript prerequisite). Cross-engine byte-equivalence (`js-yaml` ≡ `pyyaml`) deferred per §Y.4 (intractable without custom emitter). v0.1 verifies round-trip property (criterion 18) + structural parity vs py-reference live-transcript output.

- Library: `js-yaml` for TS; `yaml.dump(default_flow_style=False, sort_keys=False, allow_unicode=True, width=120)` for py-reference.
- TS equivalent options aim for byte-equivalent output but cross-engine equivalence is NOT a v0.1 hard gate (per §Y.4).
- Elision marker: `\n... [elided N chars] ...\n` exactly. Head=1000, tail=150.
- Timestamp format: ISO 8601 with `+00:00` suffix.
- `redactions_by_pattern` keys alphabetically sorted.

## 10.1 py-reference backports (required before fixture regen)

Backports land in `py-reference/cli/` to make fixtures regenerable AND consistent with the reconciled+amended spec:

1. **simple-git equivalent** (`gitpython` or shell-out): populate `pr.*` and `diff_summary.*`. **Includes userinfo strip for `pr.repository`** (per A4.5 SEC-2).
2. **Drop excerpt redaction calls** at `trail.py:227, 237, 243, 255, 261`. Excerpts pass through raw on disk.
3. **Add `test_evidence.passed[].ref` redaction** (per A4.5 SEC-1; previously raw).
4. **Test-runner config externalization**: load from `bin/trail-test-runners.yml`.
5. **Add `--per-diff` flag**: per-DIFF mechanical grouping for `packet-1-perdiff.yml`.
6. **Markdown render integration into fixture regen flow** (per A4.5 P2-COUPLING-08): py-reference produces `packet-1.md`.
7. **`render.py` dropping unused `agent` format**; aligns with TS spec §3 `--format` enum.
8. **[AB-9 / AB-stage 2026-05-09]** Implement re-capture detection logic (§3 step 9a): scan for prior `packet-N.yml`, compute `next_n`, populate `_meta.parent_packet_id`. py-reference output path becomes versioned (`packet-<N>.yml` under session subdirectory).
9. **[AB-10 / AB-stage 2026-05-09]** Regenerate fixtures into versioned subdirectory layout: `py-reference/fixtures/sessions/<session-id>/packet-1.yml` (and `packet-1-perdiff.yml`, `packet-1.md`). Remove the legacy flat fixtures (`canonical-session.yml`, `canonical-session-perdiff.yml`, `canonical-session.md`) in the same commit.
10. **[AB-5 / AB-stage 2026-05-09]** Implement `claims[].stable_id` derivation per §6 Universal rules (sha256 truncated to 16 hex chars). py-reference SHOULD emit stable_id for parity-test consistency; fixtures regenerated post-backport include stable_id.

After backports, regenerate fixtures from session `18e374b5-...` → `py-reference/fixtures/sessions/18e374b5-.../`. Validate via §13 criterion 17.

## 11. Schema tensions — closed

| Spec §11 tension (blind draft) | Resolution |
|---|---|
| `synthesis_mode` per claim | **Closed** in v0.1.1: `claims[].synthesis_mode`. |
| Risk classification field | **Partially resolved (AB-stage)**: per-claim `creator_override` / `reviewer_override` blocks land in v0.1.1 (additive; AB-1 / AB-1a). Full agent classification (level + rationale + reviewer_focus + blast_radius) remains deferred to schema v0.2. |
| Approval trail field | **Resolved (AB-stage)**: top-level `approval_trail[]` array (per-claim, per-decision granularity) lands in v0.1.1 (AB-4); Phase 1 emits `[]`, Phase 2 appends entries via the atomic-write saga. |
| Excerpt redaction policy on disk | **Closed**: spec wins; py-reference backported. |
| `--patterns <path>` flag | **[A4.5 / P2-SEC-6] Now in scope for Phase 1**: small CLI + path-load work; closes the security gap of plaintext-bundled finite pattern set. v0.2 deferral was wrong-prioritized. |
| Tamper detection on approval_trail | **Closed at libSQL layer (AB-stage)**: `packets.last_known_hash` column per B5 §3.3 + §7.1; NOT a packet-schema field. AB-3 closed without v0.1.1 schema bump. |
| Re-capture / multi-packet versioning | **Closed (AB-stage)**: `_meta.parent_packet_id` (AB-6) + versioned `packet-<N>.yml` write paths (AB-9) + versioned fixture layout (AB-10). See §3 step 9a, §X, §10.1. |
| `posted_to_pr` array semantics | **Resolved (AB-stage)**: `posted_to_pr[]` array (NOT singleton) lands in v0.1.1 (AB-2); mirrors libSQL `posted_to_pr_history` table. |
| Per-pattern × per-layer redaction breakdown | **Resolved (AB-stage)**: `redaction_audit.entries[]` array lands in v0.1.1 (AB-8); complements aggregate `redactions_by_pattern` map. |
| Claim ID stability across re-captures | **Resolved (AB-stage)**: `claims[].stable_id` (16-hex sha256 truncate) per §6 Universal rules (AB-5). |

Schema v0.1.1 additive fields: `_meta.capture_method`, `agent_session.models[]`, `claims[].synthesis_mode`, `test_evidence.passed[].cmd_ref`, **[A4.7 / R-SEC-1]** `agent_session.redaction_metadata.pattern_set_origin`, **[AB-stage 2026-05-09]** `_meta.parent_packet_id`, `claims[].stable_id`, `claims[].risk_classification.{agent, creator_override, reviewer_override}`, top-level `approval_trail[]`, top-level `posted_to_pr[]`, top-level `redaction_audit.{pattern_set_version, entries[]}`.

## 12. Out of scope (explicit)

| Item | Lives where |
|---|---|
| Tauri shell, React UI, in-app review, approval capture | Phase 2 |
| GitHub PR-body posting via gh CLI | Phase 3b |
| Pre-commit audit script (Layer 3) | Phase 3a |
| Tauri installers, npm publish | Phase 4 |
| Cloudflare Workers, DOs, R2, D1, sync semantics | Phase 5+ |
| Multi-agent (Cursor/Codex/Aider) | v0.2+ |
| Real-time hook capture | v0.2+ |
| Risk classification (full) | Schema v0.2 |
| Approval trail (full) | Schema v0.2 |
| `~/.claude/file-history/` excerpt source | v0.2+ enhancement |
| Confidence gradient | v0.2 |
| Mtime-based provenance heuristic | v0.2+ |
| Per-claim model attribution | v0.2 |
| Real `commands_run[].exit_code` / `.duration_ms` parsing | v0.2 (locked at 0 for parity) |
| Concurrent multi-process file-locking | v0.2 |
| Encryption-at-rest for `.trail/trail.db` | Phase 5+ commercial |

## 13. Success criteria for Phase 1 done

(Re-stated formally at A5 via `/preflight`.)

| # | Criterion | How verified |
|--:|---|---|
| 1 | TS package `@trail/capture` builds and runs via pnpm workspace | `pnpm --filter @trail/capture build` exit 0 |
| 2 | Generates schema-conforming packet for canonical fixture session, mechanical default | Mechanical-mode parity test (§10). **[§Y.1 / 2026-05-09]** Byte-identity vs `packet-1.yml` deferred to v0.2; v0.1 ship bar = structural parity vs py-reference live transcript. |
| 3 | `--per-diff` mode produces conforming packet against canonical-session-perdiff | Per-DIFF parity test. **[§Y.1 / 2026-05-09]** Same byte-parity v0.2 deferral as criterion 2. |
| 4 | Layer 1 redaction: per-field × per-pattern × 3-position matrix | **[P1-TESTS-02; A4.7 / R-TESTS-05, R-TESTS-02]** Parameterized test: 7 designated Layer-1 fields × 17 active patterns × 3 positions = **~357 cases**. CI strategy: full matrix runs nightly on CI; per-PR fast lane runs a stratified random sample (10 patterns × 3 fields × 3 positions = 90 cases) to keep PR feedback under 60s. Plus boundary test at 1199-char prompt with secret (truncate-then-redact ordering edge case). **Owner of "1199-char boundary"**: this criterion (criterion 4); criterion 23 is freed to focus on prompt-shape edge cases (tool_result-only, all-tags, unbalanced-tag) — no overlap. |
| 5 | `redaction_metadata.pattern_set_version` matches active YAML version | Integration test (default path + `--patterns <path>`). |
| 6 | Layer 2 catches deliberately-injected post-redaction secrets | Test bypasses Layer 1 (forced) and verifies Layer 2 catches. |
| 6a | **[A4.5 / P1-TESTS-01]** Layer 2 internal correctness: per-pattern test runs Layer 2 against a packet whose YAML contains a secret matching that pattern, with NO `[REDACTED:...]` markers anywhere. Pattern MUST appear in `validation_errors`. | Parameterized test per pattern. |
| 6b | **[A4.5 / P1-TESTS-01]** Layer 2 marker-strip robustness: a packet whose YAML contains literal `[REDACTED:fake-pattern]` adjacent to a real secret — verify the marker-stripper doesn't cause a false negative. | Targeted test. |
| 6c | **[A4.5 / P1-TESTS-01]** Layer 2 overlapping patterns: a YAML where two patterns (e.g., a JWT-shaped substring inside a Postgres URL) overlap — verify both patterns appear in `validation_errors` (or document why one shadows the other). | Targeted test. |
| 7 | All exit codes (§8) emitted on synthetic failure scenarios | **[A4.5 / P1-TESTS-06; A4.7 / R-TESTS-03, R-TESTS-01]** Enumerated matrix: code 2 ×3; code 3 ×3 (not-a-repo, corrupt-index, partial — empty optional fields succeed not exit 3); code 4 ×8 sub-shapes (a) file missing, (b) YAML parse error, (c) version missing, (d) regex compile fail, (e) zero-pattern array, (f) >64KB cap, (g) binary content, (h) ReDoS timeout; code 5 ×4 (Ajv structural fail, ref-resolution fail, SchemaValidatorInternalError per §7 — Ajv compile throw, strict-redaction gate per §8.1 step 8b — each with distinct stderr regex per §8.3 row 5); code 6 ×2 (perms-denied output dir, atomic-write rename failure); code 7 ×1 (LLM unavailable + `--strict-llm`); code 8 ×6 sub-cases (malformed `--llm-budget-usd "x"`, malformed `--llm-timeout-seconds "abc"`, invalid `--format unknownvalue`, missing `--patterns` value, both `--strict-llm` and `--no-llm` set [conflict], unknown flag); code 9 ×1 (deferred to v0.2 — verify documented stderr on concurrent run if implemented); codes 130/143 — **emission-only** here (side-effects covered by criterion 28). **~30 test cases.** |
| 8 | LLM-augmented mode: 6 fallback triggers each tested | **[A4.5 / P2-TESTS-11]** (a) CLI absent. (b) Subprocess non-zero exit. (c) Subprocess timeout (verifies SIGTERM-then-SIGKILL kill semantics per §6). (d) stdout non-JSON. (e) JSON parse OK but `len(parsed) < len(file_groups)`. (f) JSON parse OK but file paths don't match `file_groups`. Each → assert mechanical fallback + correct stderr. |
| 9 | `--strict-llm` exits 7 when LLM unavailable | Integration test. |
| 10 | Layer 2 storage: writes packets/claims/evidence/redaction_audit rows via Drizzle (best-effort) | Storage unit test. DB-fail scenario test verifies files preserved + warning + exit 0. |
| 11 | simple-git populates `pr.*` and `diff_summary.*` correctly | **[A4.5 / P3-TESTS-15]** Plus matrix: not-a-repo (exit 3 sub-shape a); unborn HEAD; no-remote (empty `pr.repository`); detached HEAD; no `user.email` (empty `pr.author`). |
| 12 | Schema v0.1.1 published at `schema/pr-change-packet.v0.1.1.yml` + `pr-change-packet.v0.1.1.schema.json` | File presence + Ajv compile passes; `pnpm run schema:gen` produces matching `packet/types.ts`. |
| 13 | Build green: `tsc --noEmit`, lint, no secrets in repo | CI / local verification. |
| 14 | Per-claim `synthesis_mode` populated in mixed-mode LLM runs | Test. |
| 14a | **[A4.5 / P2-TESTS-12]** Multi-model attribution: synthetic transcripts × 4 shapes (single-model, two-model, three-model-with-revisit, missing-model) produce expected `models[]` arrays AND back-compat `agent_session.model` (last-seen). | Test. |
| 15 | YAML byte-identity rules (§10) pass on canonical fixture | Integration test. **[§Y.1 / 2026-05-09]** Byte-identity vs canonical fixture deferred to v0.2; v0.1 verifies locked YAML options + structural parity. |
| 16 | BVSSH quick-check answered (Better/Value/Sooner/Safer/Happier) | At /diamond-progress L3 deliver→complete. |
| 17 | **[A4.5 / P2-TESTS-10]** py-reference backports validated | `pytest py-reference/test/test_backports.py` confirms: simple-git produces non-empty `pr.*`; userinfo strip works on token-bearing remote URLs; excerpts pass through raw on disk; `test_evidence.passed[].ref` IS redacted; test-runner config externalized; `--per-diff` produces ≥len(diffs) claims; markdown render produced. Lock fixture provenance to a known-good py-reference state. |
| 18 | **[A4.5 / P1-TESTS-03; §Y.4 / 2026-05-09]** YAML round-trip property test | `fast-check`-driven: random valid packet shapes serialized via `js-yaml`; assert `parse(serialize(p))` deep-equal `p` (round-trip property). Cross-language byte-equivalence vs `pyyaml` deferred per §Y.4 (intractable without custom emitter; out-of-scope for v0.1). |
| 19 | **[A4.5 / P1-TESTS-04]** Claim synthesis edge cases | Matrix: (a) zero diffs + ≥1 commands + zero tests; (b) zero diffs + zero commands + zero tests (must fail "at least one non-empty" rule, exit 5); (c) 1 file × 5 edits per-file vs per-DIFF; (d) 1 file × 5 edits + tests; (e) 5 files × 1 edit each. Each shape asserts schema-conformance + claim count. |
| 20 | **[A4.5 / P1-TESTS-05]** MultiEdit hunk cap behavior | Test: 6-hunk MultiEdit produces 5 before/after pairs in `excerpts[]`, the 6th hunk is dropped, no crash, stderr notice emitted (`"dropped 1 MultiEdit hunks beyond cap of 5"`). Boundary test: 5-hunk MultiEdit → no drop, no notice. |
| 21 | **[A4.5 / P1-TESTS-07]** Timestamp tz parity test | Mixed-tz fixture (`Z`-suffix and `+00:00`-suffix mixed) produces same `started_at`/`ended_at` as py-reference. |
| 22 | **[A4.5 / P2-TESTS-08]** Regex engine equivalence property test | For each pattern in active patterns YAML, run battery of (a) known positive cases, (b) known negative cases, comparing TS `RegExp.exec()` and py-reference `re.search()` results. Catches engine differences (Unicode handling, lookahead, backreferences). |
| 23 | **[A4.5 / P2-TESTS-09; A4.7 / R-TESTS-02]** Prompt pipeline edge cases | tool_result-only user message → skipped (no PROMPT-NNN). All-tags user message → skipped. Unbalanced-tag user message → behavior documented + tested. (Secret-at-1199-chars boundary test owned by criterion 4 — no duplication.) |
| 24 | **[A4.5 / SEC-2]** Userinfo strip on remote URLs | Integration test: remote URL `https://x-access-token:ghp_xxxxx@github.com/foo/bar.git` → `pr.repository == "foo/bar"`; token does NOT appear anywhere in packet (no field, no excerpt, no validation_error). |
| 25 | **[A4.5 / SEC-3]** LLM subprocess never receives raw excerpts matching default patterns | Integration test: synthesize a transcript with a known secret in an Edit's `new_string`. Run `trail packet generate` (LLM mode). Mock `claude` subprocess; assert stdin received does NOT contain the secret. Asserts excerpt-redaction-at-LLM-boundary. |
| 26 | **[A4.5 / SEC-1]** `test_evidence.passed[].ref` redacted | Integration test: transcript with `Bash` tool use `npm test -- --token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` → `test_evidence.passed[*].ref` contains `[REDACTED:github-token]` (NOT raw token). |
| 27 | **[A4.5 / FAIL-04]** Layer 2 atomic-write contract | Test: force I/O failure between Layer 2 scan and disk write. Verify: no partial file on disk; tmp file unlinked; validation_errors dumped to stderr; exit 6. |
| 28 | **[A4.5 / FAIL-05; A4.7 / R-TESTS-01, R-FAIL-03, R-FAIL-05; A4.9 / R8-COUPLING-01]** Signal handling **side-effects** (exit-code emission covered by criterion 7) | (a) SIGINT mid-write between **10f and 10g** (after packet.yml renamed, before packet.md write) → packet.yml present, no packet.md, no `.tmp` residue, exit 130. (b) SIGINT during LLM subprocess → no orphaned `claude` child process (verify via process-tree check), exit 130. (c) SIGTERM during DB transaction → DB rolled back (no half-row), files preserved, exit 143. (d) SIGINT before any write (during step 10b Layer 2 scan or earlier) → no packet on disk, no .tmp residue, exit 130. **Audit-rule note**: future amendments that renumber sub-steps MUST sweep cross-references via `grep -n 'step 10[a-z]'` across the spec — A4.7→A4.8 caught this exact regression class. |
| 29 | **[A4.5 / SEC-4; A4.7 / R-SEC-5, R-FAIL-09]** Gitignore notice integrity | (a) Fresh `~/.trail/repos/<sha>/` empty + repo `.gitignore` doesn't exclude `.trail/` → notice emitted on first successful run. (b) Subsequent run (after `.gitignore` actually updated AND parser confirms exclusion) → notice suppressed. (c) Pre-existing `.trail/.gitignore-checked` file inside repo (R-SEC-5 attack: planted via template) does NOT suppress notice — touch file is home-scoped, not repo-scoped. (d) First run with `--strict-redaction` exiting 5 → next run still emits notice (R-FAIL-09 — touch file created only after step 10f success). (e) `--quiet` does NOT suppress this notice (per §3 `--quiet` flag). |
| 30 | **[A4.5 / FAIL-19]** Schema version vs field-presence enforcement | Test: emit packet with `packet_version: "0.1"` but `_meta.capture_method: "post_hoc"` → schema validation fails with code 5 (semantic-v0.1.1 falsely labeled). |

Phase 1 is done when criteria 1–30 are all green AND `flow:integration-verifier` confirms parity oracles pass end-to-end.

---

## §X. AB-stage amendments (2026-05-09)

This section consolidates the AB-feedback resolutions surfaced during Phase 2 UI specification (B1–B5) and applied to the Phase 1 spec post-A4.9. **These are amendments, not rewrites** — the surrounding sections (§§1–13, Appendices) remain authoritative; this section captures the deltas + rationale.

Companion: `docs/specs/phase-2-ab-resolution.md` (one-page summary of all 10 AB items + status), `docs/specs/phase-2-architecture-reconciliation.md` §8 (the source AB-list table).

### X.1 Re-capture detection + versioned packet writes — **[AB-9 / MUST]**

**What changed**: §3 step 9a (NEW); §3 step 10f/g/h (path now `packet-<N>.{yml,md}`); §3 step 11 (summary line); §1 goals (persistence path); §10 / §10.1 (parity fixtures versioned).

**Why**: Phase 2 (B5 §5) decided that capture owns versioning, NOT the UI. Re-capture means same `session_id`, new generation timestamp; the packet YAML at write-time is immutable; subsequent re-captures write `packet-2.yml`, `packet-3.yml`, etc., under the same session directory.

**Algorithm** (re-stated from §3 step 9a for cross-reference):
1. Scan `<repo>/.trail/sessions/<session-id>/` for files matching `^packet-(\d+)\.yml$`.
2. `next_n = max(N) + 1` if any match; else `next_n = 1`.
3. Write target: `packet-<next_n>.yml` (and `.md` companion).
4. Populate `_meta.parent_packet_id`:
   - `next_n == 1` → `null`.
   - `next_n > 1` → read `packet-<next_n - 1>.yml`, parse `_meta.packet_id`, assign to `parent_packet_id`. On unreadable parent: warn (bypasses `--quiet`), set `null`, continue.

**Out of scope**: file-locking against concurrent re-captures of the same session. Phase 1 last-writer-wins per §2 deferral row; v0.2 adds locking.

### X.2 Parent packet linkage — **[AB-6 / MUST]**

**What changed**: schema `_meta.parent_packet_id` field (nullable string ULID).

**Why**: Phase 2 carry-forward (B5 §5.4) keys on the parent_packet_id chain to compute "what changed since last review". Without this field, Phase 2 falls back to text-similarity matching (lossy).

**Phase 1 obligation**: emit the field per §3 step 9a logic. NOT optional — first capture writes `null`, subsequent captures write the prior packet's ULID.

### X.3 Stable claim ID — **[AB-5 / MUST]**

**What changed**: §6 Universal rules (NEW bullet); schema `claims[].stable_id` field (16-char lowercase hex).

**Why**: re-captures may reorder or re-number claims (CLAIM-NNN drifts when diff order changes). Phase 2 carry-forward MUST key on a stable identifier; libSQL `claims.claim_id` PRIMARY KEY uses this stable id (per B5 §7.1 schema sketch).

**Algorithm** (locked):
```
stable_id = sha256(session_id || '|' || claim_text || '|' || position).hexdigest()[:16]
```
- `session_id`: transcript filename minus `.jsonl`.
- `claim_text`: post-redaction claim text written to YAML.
- `position`: 0-indexed insertion position in `summary.claims` (integer; NOT CLAIM-NNN string).
- Truncation to 16 hex chars (8 bytes) — collision space is 2^64; sufficient for solo OSS scope. v0.2 may extend to 32 chars if multi-tenant collision risk emerges.

**Test rollup claims** ("Ran N test/validation command(s)"): same algorithm; stable_id changes with N. Acceptable — N-delta IS a meaningful diff.

### X.4 Per-claim risk overrides — **[AB-1, AB-1a / SHOULD]**

**What changed**: schema `claims[].risk_classification.{agent, creator_override, reviewer_override}` blocks (all sub-fields nullable).

**Why**: Phase 2 J3 (review screen) needs to record creator and reviewer risk-level overrides AT CLAIM granularity (not packet-level). Storing in libSQL alone is insufficient — the YAML is the canonical artifact and must round-trip overrides.

**Phase 1 obligation**: emit the structure with all fields `null` (no agent classification computed in Phase 1; full classification is schema v0.2). Phase 2 (UI) populates `creator_override` / `reviewer_override` via the atomic-write saga (B5 §3).

### X.5 Approval trail (per-claim chronological) — **[AB-4 / MUST]**

**What changed**: schema top-level `approval_trail[]` array (NOT singleton).

**Why**: AB-4 confirmed approval_trail is per-claim, per-decision granularity (B5 §7.1 libSQL schema lists ONE row per (claim_id, decision event)). Schema must mirror.

**Phase 1 obligation**: emit empty array `[]`. Phase 2 appends entries.

**Shape**: `[{ claim_id, decision, reason, by, at }]` — see schema YAML for full doc. `claim_id` references the stable_id (AB-5) when populated; falls back to CLAIM-NNN id pre-AB-5 landing (transitional only).

### X.6 Posted-to-PR history (array) — **[AB-2 / SHOULD]**

**What changed**: schema top-level `posted_to_pr[]` array (NOT singleton).

**Why**: a packet may be posted to PR multiple times (re-edits, re-pushes). Mirrors libSQL `posted_to_pr_history` table (B5 §7.1).

**Phase 1 obligation**: emit empty array `[]`. Phase 3b appends entries on each successful `gh` post.

### X.7 Per-pattern × per-layer redaction breakdown — **[AB-8 / SHOULD]**

**What changed**: schema top-level `redaction_audit.{pattern_set_version, entries[]}` (NEW). The aggregate `agent_session.redaction_metadata.redactions_by_pattern` map is RETAINED for back-compat + quick rollup.

**Why**: B5 §7.1 libSQL `redaction_audit` table has per-pattern × per-layer rows. Schema must surface the same shape so libSQL is rebuildable from YAML (per B5 §7.4 rebuild contract).

**Phase 1 invariant** (from schema validation rules): sum of `entries[].count` for `layer == 1` MUST equal `agent_session.redaction_metadata.redactions_applied`. Cross-check enforced by Ajv.

### X.8 Redaction-preview in-memory cache — **[AB-7 / OPTIONAL]**

**What changed**: §5 (NEW subsection "Layer 1 in-memory redaction-preview cache").

**Status**: Opt-in. Phase 1 v0.1 NOT REQUIRED to implement. UI affordance gracefully degrades to "preview unavailable" when absent.

**Why opt-in**: cost is ~100 LOC + Tauri IPC; the UI degrades gracefully without it. Defer until UI usability data shows the affordance is missed.

### X.9 Tamper detection — closed at libSQL layer — **[AB-3 / MUST → CLOSED elsewhere]**

**What changed**: NOTHING in this spec or in `schema/pr-change-packet.v0.1.1.yml`.

**Why**: AB-3 was originally framed as "content-hash on approval_trail in the packet". B5 §7.1 resolved this differently — tamper detection is a `packets.last_known_hash` libSQL column, computed on ingest and checked on subsequent reads. The packet YAML carries no integrity hash; integrity is the storage saga's responsibility (B5 §3.3).

**No Phase 1 schema bump required for AB-3.** This removed a perceived blocker for Phase 1 build.

### X.10 Versioned fixture file naming — **[AB-10 / MUST]**

**What changed**: §10 Parity oracle fixture paths; §10.1 backports list (items 5, 6, 8, 9, 10).

**Why**: now that capture emits `packet-<N>.yml` (AB-9), fixtures must follow the same naming. Flat `canonical-session.yml` layout is incompatible with the versioned-write logic — there's no way to byte-compare TS output (`packet-1.yml`) against a fixture named `canonical-session.yml` without test-side rename hacks.

**A7 task scope** (fixture regeneration) MUST:
- Move fixtures to `py-reference/fixtures/sessions/<session-id>/packet-1.yml` (and `packet-1-perdiff.yml`, `packet-1.md`).
- Remove legacy flat fixtures in the same commit.
- (OPTIONAL) Add a `packet-2.yml` fixture exercising AB-9 re-capture detection (populated `_meta.parent_packet_id`); locks the versioned-write algorithm.

### X.11 Summary table — AB items × Phase 1 build dependencies for #21

| ID | Severity | Status post-AB-stage |
|---|---|---|
| AB-1 | SHOULD | Resolved in v0.1.1 schema (additive) |
| AB-1a | SHOULD | Resolved in v0.1.1 schema (additive) |
| AB-2 | SHOULD | Resolved in v0.1.1 schema (additive) |
| AB-3 | MUST | **Closed at libSQL layer** (no Phase 1 schema change) |
| AB-4 | MUST | Resolved in v0.1.1 schema (additive); blocks #21 (Phase 1 emits `[]`) |
| AB-5 | MUST | Resolved in v0.1.1 schema + §6 spec amendment; blocks #21 |
| AB-6 | MUST | Resolved in v0.1.1 schema (additive); blocks #21 |
| AB-7 | OPTIONAL | Documented as opt-in; NOT a Phase 1 v0.1 dependency |
| AB-9 | MUST | Resolved via §3 step 9a + §10 amendments; blocks #21 |
| AB-10 | MUST | Resolved via §10 / §10.1 amendments; blocks A7 (fixture regen), NOT #21 (capture impl) directly |

**Phase 1 build (#21) hard dependencies** post-AB-stage: AB-4, AB-5, AB-6, AB-9. (AB-3 closed elsewhere; AB-10 blocks A7 not #21; AB-1/1a/2/7/8 are SHOULD/OPTIONAL or already in schema.)

---

## §Y. Post-implementation review amendments (2026-05-09)

Driven by Phase 1 implementation findings (PR #7) + Phase 2 Sprint 1 implementation findings (PR #6) + Path A multi-lens review of both PRs (review comments [#4412444717](https://github.com/synaptiai/trail/pull/7#issuecomment-4412444717), [#4412443795](https://github.com/synaptiai/trail/pull/6#issuecomment-4412443795)). Founder decisions per AskUserQuestion 2026-05-09. **These amend §10, §13, §3, §10.1**; the surrounding sections remain authoritative — this section is the diff.

### Y.1 Byte-parity criteria 2/3/4 + 15 deferred to v0.2 — **[MUST]**

**Decision**: structural parity is the v0.1 ship bar; byte-identity (against canonical fixture YAML/MD) is deferred to a v0.2 close-condition.

**Why**: The canonical fixture's source `<sid>.jsonl` transcript at `~/.claude/projects/<sanitized-cwd>/18e374b5-...jsonl` was never committed during A7 (decision-log gap). Without a frozen reproducible source, byte-identity vs `packet-1.yml`/`packet-1-perdiff.yml`/`packet-1.md` is structurally unprovable: the live transcript at `~/.claude/projects/...` keeps growing as Claude Code is used. Two paths considered: (a) commit a redacted frozen transcript snapshot now (v0.1 unblock), (b) revise criteria to structural-only for v0.1 + treat byte-parity as v0.2 close-condition. Founder chose (b) to ship v0.1 sooner; (a) becomes a v0.2 task tracked separately.

**Affects**:
- §13 criteria 2, 3, 15: PARTIAL acceptable for v0.1 (structural parity vs py-reference live transcript verified by py-reference subprocess invocation).
- §10 Markdown parity: byte-parity deferred; structural parity acceptable for v0.1.
- §10 YAML byte-identity: locked options remain authoritative; byte-vs-canonical-fixture deferred.

**v0.2 close-condition**: commit `py-reference/fixtures/sessions/18e374b5-.../session.jsonl` (post-Layer-1 redaction); regenerate `packet-1.yml` + `packet-1-perdiff.yml` + `packet-1.md` from the frozen source; lock byte-parity from there. Tracked as a v0.2 milestone task.

### Y.2 `pattern_set_version` regex ratification — **[MUST]**

**Decision**: ratify the schema relaxation at `schema/pr-change-packet.v0.1.1.schema.json` (lines 240, 436) from `^v\d+\.\d+\.\d+$` to `^v?\d+\.\d+\.\d+$`.

**Why**: §4 field-level mapping for `pattern_set_version` cites `version` field of the active patterns YAML, which mirrors `package.json#version` convention (canonical npm semver, no `v` prefix). The original `^v\d+...` regex was a schema bug. The relaxation accepts both bare semver (canonical) and `v`-prefixed (back-compat tolerance).

**Future spec discipline**: any new `version`-format fields use bare semver. The `^v?` regex is for back-compat tolerance only.

### Y.3 Bundled patterns YAML normalization (drop Python `(?i)` inline-flag) — **[MUST]**

**Decision**: normalize `bin/trail-redaction-patterns.yml` to use a per-pattern `flags` field instead of inline `(?i)` syntax. Pattern YAML schema becomes:

```yaml
patterns:
  - name: <string>            # required; unique per file
    pattern: <regex string>   # required; NO inline-flag prefix (e.g., NO `(?i)` at start)
    flags: <string>           # OPTIONAL; default ''; subset of 'ims'
                              #   'i' = ignoreCase
                              #   's' = dotAll (`.` matches `\n`)
                              #   'm' = multiline (`^`/`$` per-line)
                              # Python's 'x' (VERBOSE) flag has no JS RegExp equivalent;
                              # the loader at apps/capture/src/redaction/patterns.ts:159-168
                              # rejects 'x' with PatternLoadError(d). Document divergence
                              # explicitly here so writers of custom --patterns YAML
                              # know the supported subset.
```

**Why**: Phase 1 agent's `(?i)`-prefix translator (handles only start-of-pattern inline flags, not mid-pattern or group-scoped) is a brittle subset that creates a footgun for downstream consumers writing custom patterns. Both Python `re.compile(pattern, re.IGNORECASE)` and JS `new RegExp(pattern, 'i')` accept flags as a separate argument, so the `flags` field maps directly with no engine-specific handling. Removes the translator dependency from the bundled-pattern code path.

**Affects**:
- `bin/trail-redaction-patterns.yml` v0.1.3 (additive bump): 2 patterns updated (`aws-secret-key`, `cloudflare-api-token`); each gets `flags: 'i'` field; `(?i)` prefix removed from `pattern`.
- `apps/capture/src/redaction/patterns.ts` (PR #7 fix cycle): parser reads `flags` field; constructs `new RegExp(pattern, flags || '')`. Translator REMAINS as defense-in-depth for **user-supplied** patterns (graceful handling of Python-style inline-flag input via `--patterns <path>`); bundled patterns no longer require it.
- `py-reference/cli/trail.py` + `py-reference/bin/trail-audit-precommit`: same `flags`-field reading for parity.
- §13 criterion 22 (regex engine equivalence property test): augment to verify the `flags` field is honored equivalently in both engines.
- §3 `--patterns` flag documentation: add the `flags` field schema above.

**Defensive policy**: user-supplied patterns via `--patterns <path>` MAY still use Python-style inline-flag prefixes; the parser translates `(?i)` at start-of-pattern. Mid-pattern or group-scoped inline flags fail at safe-regex / parse time with clear error message — documented limitation.

### Y.4 Criterion 18 (YAML byte-identity property test) revision — **[MUST]**

**Decision**: criterion 18 becomes "YAML round-trip property test (parse → serialize → reparse → deep-equal) green via fast-check." The cross-language `js-yaml` ≡ `pyyaml` byte-equivalence requirement is dropped.

**Why**: `js-yaml` and `pyyaml` differ in string-quoting heuristics, line-wrapping behavior, and empty-value rendering. Cross-engine byte-equivalence requires a custom emitter (~200-400 LOC) — high-effort, low-ROI for v0.1 because (a) the parity oracle gives byte-identity for the canonical fixture, which is what users care about; (b) cross-engine parity is implementation detail, not a user-facing contract. v0.1 ships round-trip; v0.2+ may revisit if cross-engine parity becomes load-bearing for a downstream consumer.

**Affects**:
- §13 criterion 18: revised verification text.
- §10 YAML byte-identity rules: locked options remain; cross-language byte-equivalence no longer asserted.
- PR #7 reviewer's F3 finding (test name `"matches pyyaml safe_dump on simple input"` is misleading — actually compares js-yaml-to-js-yaml) is closed by this amendment via test-rename / -delete.

### Y.5 Path A reviewer protocol caveat — **[INFORMATIONAL; CORRECTED post-cycle-2]**

**Observation (cycles 1 + 2)**: Across all four review runs (PR #6 cycle-1, PR #7 cycle-1, PR #6 cycle-2, PR #7 cycle-2), reviewers verified via `ToolSearch select:Task,Agent` that the **Agent / Task dispatch primitive is not exposed to spawned threads in this harness** — only to the actual top-level conversation thread. The team-coordination skill's prescribed 12-paired-reviewer parallel dispatch + 10-prompt challenge round is therefore unrunnable from any orchestrator agent; only `EnterWorktree`, `Monitor`, `NotebookEdit`, `WebFetch`, `WebSearch`, MCP servers, and file-edit tools are available in the spawned context.

Reviewers performed in-process lens-switching across the 5 facets + 2 holdout-validation, applied the consolidation table, and produced disposition vocabulary correctly. Independence-of-perspective was preserved by lens-discipline rather than process-isolation; LLM cost was ~1 in-context analysis pass per review instead of the protocol's ≈23 calls. Both cycle-1 (19+18 findings) and cycle-2 (5+20 findings) produced legitimate, file-line-cited results that have proven actionable.

**Correction to the original §Y.5 wording**: the boundary is NOT "main thread vs subagent" — it is "actual top-level conversation thread vs anything spawned (orchestrator subagents included)." The cycle-1 amendment misread the harness shape.

**Implication for v0.1**: full Path A protocol (12-paired-reviewer parallel dispatch) requires direct dispatch from the top-level conversation thread, which consumes top-level context heavily. The pragmatic alternative — single-orchestrator in-process lens-switching with conservative confidence calibration (no `consensus` HIGH; HIGH reserved for spec-unambiguous-AND-evidence-direct findings) — has been verified to produce legitimate review signal across four cycles. **Both modes are acceptable for v0.1**; the choice is a context-budget decision at review time.

**Discipline going forward**: orchestrator-style reviewers MUST disclose the protocol mode used in the posted review comment (already practiced; preserve). They MUST run actual quality-gate commands (typecheck/lint/test) at the PR HEAD as part of the review (cycles 1+2 did this; preserve). Confidence vocabulary calibration follows the protocol caveat appendix (see review.md A.1 in the flow plugin).

---

## Appendix A — Module structure (proposed)

**[A4.5 amendments]**: split per coupling findings; explicit DI seams.

```
apps/capture/
├─ src/
│  ├─ index.ts                    # PUBLIC API: re-exports `generate`, packet types,
│  │                              #             StorageWriter interface. Internal modules
│  │                              #             are NOT stable across minor versions.
│  ├─ cli.ts                      # commander/cac wiring; arg parsing+validation BEFORE I/O
│  ├─ generate.ts                 # top-level pipeline orchestrator
│  ├─ transcript/
│  │  ├─ reader.ts                # streaming jsonl parse, normalize
│  │  └─ types.ts                 # Claude Code transcript types
│  ├─ git/
│  │  └─ state.ts                 # simple-git wrappers; pr.* + diff_summary.*; userinfo strip
│  ├─ redaction/
│  │  ├─ patterns.ts              # load + validate active patterns YAML (default or --patterns)
│  │  ├─ layer1.ts                # capture-time redaction (also exported for LLM-prompt path)
│  │  └─ layer2.ts                # write-time re-validation; 8-char-hex sha256 snippet (R-COUPLING-02)
│  ├─ test-runners/
│  │  └─ patterns.ts              # load trail-test-runners.yml
│  ├─ semantic-changes/
│  │  ├─ extract.ts               # walk transcript tool uses → DIFF-NNN
│  │  └─ excerpts.ts              # head/tail slicing + elision marker
│  ├─ commands/
│  │  └─ extract.ts               # walk transcript Bash uses → CMD-NNN (exit_code/duration_ms locked at 0)
│  ├─ tests-evidence/
│  │  └─ extract.ts               # consumes commands/ output; emits TEST-NNN with cmd_ref
│  ├─ provenance/
│  │  └─ authorship.ts            # constants for v0.1
│  ├─ claims/
│  │  ├─ types.ts                 # ClaimSynthesisInput struct (P2-COUPLING-06)
│  │  ├─ mechanical.ts            # per-file + per-diff modes
│  │  ├─ llm.ts                   # PURE: prompt-build + parse + fallback logic;
│  │  │                           #   imports redaction/layer1.ts for excerpt-preview redaction;
│  │  │                           #   takes subprocess-runner as DI parameter
│  │  └─ llm-subprocess.ts        # thin wrapper around `child_process.spawn`;
│  │                              #   timeout + SIGTERM/SIGKILL tree-kill
│  ├─ packet/
│  │  ├─ build.ts                 # assemble final shape from components
│  │  ├─ validate-schema.ts       # Ajv pre-write structural pass (uses generated schema.json)
│  │  ├─ validate-refs.ts         # post-build cross-reference pass (pure TS)
│  │  └─ types.ts                 # GENERATED from schema; see Appendix B
│  ├─ render/
│  │  └─ markdown.ts              # packet → packet.md (parity-tested per §10)
│  ├─ storage/
│  │  ├─ types.ts                 # StorageWriter interface (signature locked, see below)
│  │  ├─ stub.ts                  # Drizzle implementation (writes to .trail/trail.db)
│  │  └─ noop.ts                  # no-op for --no-storage
│  └─ atomic-write/
│     └─ tmp-rename.ts            # tmp+rename helper; signal-safe cleanup
├─ bin/
│  ├─ trail-redaction-patterns.yml   # bundled; copied to dist/ at build time
│  └─ trail-test-runners.yml         # bundled; copied to dist/ at build time
├─ test/
│  ├─ parity-yaml.test.ts         # canonical fixture (mechanical default)
│  ├─ parity-perdiff.test.ts      # canonical fixture (--per-diff)
│  ├─ parity-md.test.ts           # markdown render parity
│  ├─ parity-property.test.ts     # YAML byte-identity property test (criterion 18)
│  ├─ redaction-layer1.test.ts    # per-field × per-pattern × 3-position matrix (criterion 4)
│  ├─ redaction-layer2.test.ts    # criteria 6, 6a, 6b, 6c
│  ├─ regex-equivalence.test.ts   # criterion 22
│  ├─ schema.test.ts              # validation passes (both); criterion 30
│  ├─ exit-codes.test.ts          # criterion 7 matrix
│  ├─ llm-fallback.test.ts        # criterion 8 (6 triggers)
│  ├─ git-state.test.ts           # criterion 11 matrix
│  ├─ atomic-write.test.ts        # criterion 27
│  ├─ signal-handling.test.ts     # criterion 28
│  ├─ gitignore-notice.test.ts    # criterion 29
│  ├─ multiedit-cap.test.ts       # criterion 20
│  ├─ claim-synthesis-edges.test.ts # criterion 19
│  ├─ multi-model.test.ts         # criterion 14a
│  ├─ prompt-pipeline.test.ts     # criterion 23
│  ├─ userinfo-strip.test.ts      # criterion 24
│  ├─ llm-redaction.test.ts       # criterion 25
│  ├─ test-ref-redaction.test.ts  # criterion 26
│  └─ timestamp-tz.test.ts        # criterion 21
├─ package.json
└─ tsconfig.json
```

### StorageWriter interface (locked) — **[A4.7 / R-COUPLING-03; A4.9 / R8-COUPLING-02]**

```typescript
// apps/capture/src/storage/types.ts
import type { Packet } from '../packet/types.js';

// RedactionAudit, Claim, Evidence are sub-shapes of Packet:
//   RedactionAudit = Packet['agent_session']['redaction_metadata']
//   Claim = Packet['summary']['claims'][number]
//   Evidence = { kind: 'DIFF' | 'CMD' | 'TEST' | 'PROMPT'; id: string; ... } — derived view
//
// Exporting these as named types lets storage backends index them without
// importing the whole Packet shape:
export type RedactionAudit = Packet['agent_session']['redaction_metadata'];
export type Claim = Packet['summary']['claims'][number];
export type Evidence =
  | (Packet['diff_summary']['semantic_changes'][number] & { kind: 'DIFF' })
  | (Packet['commands_run'][number] & { kind: 'CMD' })
  | (Packet['test_evidence']['passed'][number] & { kind: 'TEST' })
  | { kind: 'PROMPT'; id: string; text: string };

export interface StorageWriter {
  writePacket(
    packet: Packet,
    redactionAudit: RedactionAudit,
    claims: Claim[],
    evidence: Evidence[]
  ): Promise<void>;
}
```

All three referenced types (`RedactionAudit`, `Claim`, `Evidence`) are derivable from the codegen'd `Packet` type — the codegen step (Appendix B) produces these as part of `packet/types.ts`. `storage/stub.ts` (Drizzle) and `storage/noop.ts` (`--no-storage`) MUST implement this interface and NOTHING ELSE — no method overloads, no extra public methods. `generate.ts` depends on the interface, never the concrete classes. This is the Phase-1.5-deferral seam: the stub can be replaced with a real implementation without touching callers. Criterion 10 sub-case (R-COUPLING-03): "noop and stub both implement StorageWriter without further method overloads" — verified by structural type-check in tests.

## Appendix B — Dependencies + codegen

| Package | Why |
|---|---|
| `js-yaml` | YAML serialization (locked options per §10). |
| `simple-git` | Git state read. |
| `commander` (or `cac`) | CLI parsing. Pick at implementation time. |
| `ulid` | packet_id generation. |
| `ajv` (+ `ajv-formats`) | JSON Schema validation (validate-schema.ts only). |
| `drizzle-orm` + `better-sqlite3` (or `@libsql/client`) | Layer 2 storage stub. |
| `fast-check` (dev) | Property tests (criterion 18). |
| `json-schema-to-typescript` (dev) | Codegen step. |
| `safe-regex` | **[A4.9 / R8-COUPLING-03]** Static-analysis ReDoS guard for `--patterns`-loaded regexes (sub-shape h). Runs at pattern-load time; lightweight. |

No runtime LLM SDK dependency: LLM synthesis goes through the `claude` CLI subprocess.

### Codegen toolchain (locked) — **[A4.5 / P1-COUPLING-01]**

Schema → JSON Schema → TS types is a deterministic three-step process:

1. **Authority**: `schema/pr-change-packet.v0.1.1.yml` (hand-authored; Apache-2.0 protocol artifact).
2. **JSON Schema**: `schema/pr-change-packet.v0.1.1.schema.json` (hand-authored; tracks YAML rules + adds Ajv-strict format). Phase 1 deliverable.
3. **TS types**: `apps/capture/src/packet/types.ts` (generated; committed to repo).
   - Generation command: `pnpm run schema:gen` → invokes `json-schema-to-typescript schema/pr-change-packet.v0.1.1.schema.json -o apps/capture/src/packet/types.ts`.
   - CI guard: pre-commit (or CI step) re-runs `schema:gen` and fails if `git diff` shows changes — forces author to commit regenerated types alongside schema changes.

### Asset resolution (package-bundled bin/) — **[A4.5 / P1-COUPLING-05]**

`new URL('./bin/<file>', import.meta.url)` resolves the YAML files relative to the running module. Build (`tsc` + asset-copy step in `package.json#scripts.build`) copies `apps/capture/bin/` → `apps/capture/dist/bin/` so the resolver works in both dev and post-build modes. Phase 4 npm publish includes `bin/` in `package.json#files`.

## Appendix C — Markdown render details (carried from py-reference; parity-tested per §10)

`packet.md` produced alongside `packet.yml` when `--format both` (or `md`). Structure:

- Header: title + redaction summary line + Layer-2 warning blockquote (when validation_errors non-empty).
- Initial prompt block: `<a id='prompt-001'></a>` anchor + 1000-char-truncated initial prompt in fenced code block.
- Per-claim section: claim text as heading; for each evidence_ref, inline anchor section:
  - DIFF: operation + file + excerpts (`−` marker for `before*` kinds, `+` for `after*`; fenced code blocks; `*(elided)*` italic suffix on elided).
  - CMD: command + stdout fence.
  - TEST: ref string.
  - Unresolved refs: `_(unresolved)_`.
- Orphan evidence appendix: evidence not cited by any claim. Caps: 40 cmds, 30 diffs, 30 tests. Folded into `<details>`.
- Footer: `*Generated by Trail v<version> (post-hoc) from <packet-path>.*`

Language hints (extension → lang): py, yml/yaml, md, json, js/jsx, ts/tsx, sh, rs, go. Unknown → no lang hint.

**[A4.5 / P2-COUPLING-08]** packet.md is parity-tested per §10 (markdown parity criterion 2, fixture `canonical-session.md`).

## Appendix D — Audit + design-review references

- A1 blind draft (no longer current; superseded).
- A2 audit at `docs/specs/phase-1-capture-audit.md` (preserved; canonical "why does the schema say X").
- A3 reconciliation logged in `.claude/harness/decision-log.md` 2026-05-08.
- A4 design review at `docs/specs/phase-1-capture-design-review.md` (preserved; canonical "why does the spec amendment exist").
- A4.5 amendments logged in `.claude/harness/decision-log.md` 2026-05-08.

Rationale for any specific rule lives in A2's row references (e.g., "12-char snippet" = A37) OR A4's finding IDs (e.g., "atomic write contract" = FAIL-04).

---

**End of amended spec.** Next: A4.6 — second-pass design review on amended spec.
