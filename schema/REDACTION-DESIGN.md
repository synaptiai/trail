# Trail Redaction Layer — Design (F5)

Status: discover-phase artifact, 2026-05-08. Closes /devils-advocate finding F5
("v0.1 captures prompts + bash output to repo with no redaction = secrets committed
by default"). This is a HARD GATE on develop phase per Mycelium L3 security gate.

## Why this exists

`/devils-advocate` (decision-log 2026-05-08, Red Team #3): "Trail captures every
user prompt and every bash command output to a file in the repo. By default. With
no redaction. Daniel committed `.trail/sessions/...` to the repo. Now the repo
contains: API keys typed in prompts; database connection strings in bash output;
production hostnames; internal company names. Trail is a footgun."

This document defines how Trail v0.1 prevents that. No develop-phase capture code
ships until this design is implemented.

## Threat model

What Trail captures, and what's at risk in each:

| Capture surface | Secret risk examples | Severity |
|---|---|---|
| `agent_session.prompts.initial` / `followups` (text) | API keys pasted into prompts; "use this DB connection: postgres://user:pw@..."; internal hostnames; PII in test data examples | HIGH |
| `commands_run[].stdout_summary` / `stderr_summary` | Connection strings printed by tools; tokens echoed by `env`; `git config --list` output containing emails; AWS CLI output with account IDs | HIGH |
| `commands_run[].command` (the command itself) | `curl -H "Authorization: Bearer $TOKEN"` — token might be inlined; `psql -h prod-db.internal ...` reveals infra | MEDIUM |
| `diff_summary.semantic_changes[]` (heuristic descriptions of file edits) | Edited files may contain secret-bearing lines; description could echo "added AWS_SECRET_KEY = '...'" | MEDIUM |
| File content snapshots (PreToolUse → diff computation) | Source files may contain `.env`-style secrets; configuration files; certificates | HIGH (snapshots stay in memory only by design — see below) |
| Transcript file (`transcript_path` jsonl, gitignored by default) | Same as prompts but more verbose — full conversation history including all prompts and responses | HIGH (mitigated by gitignore but not eliminated) |
| `pr.author`, `pr.repository`, `pr.branch` | Internal hostnames in repo URLs; private GitHub Enterprise hosts; sensitive branch names | LOW-MEDIUM |

## Design principles

1. **Default-on**: redaction runs without opt-in. Disabling requires explicit per-project config.
2. **Defense in depth**: redaction at capture, validation at write, audit at commit. Three layers; if one fails, others catch.
3. **Evidence-grounded**: every redaction event is logged in the packet itself with the pattern that matched (no silent drops).
4. **Conservative-by-default**: better to over-redact (false positive) than leak (false negative). False positives produce `[REDACTED:pattern-name]` markers users can review.
5. **Transparent**: redaction patterns are open-source, inspectable, and configurable per project.

## Redaction architecture

### Layer 1 — Capture-time redaction (synchronous, in-hook)

When a Trail hook script runs (PreToolUse / PostToolUse / UserPromptSubmit), it
applies the redaction pattern set BEFORE writing to disk. Raw values never touch
`.trail/sessions/...`.

Performance constraint: redaction adds <20ms p99 to hook execution (well under
the <100ms p99 hook budget). Implementation: precompiled regex set, single-pass
scan over each captured string.

### Layer 2 — Write-time validation (synchronous, before any file write)

Before writing the packet or any session artifact to disk, run a validation pass:
re-scan the redacted output with the SAME pattern set. If any match is found,
the write is aborted with an error logged to `agent_session.redaction_errors[]`
in the packet metadata. This catches bugs in capture-time redaction.

### Layer 3 — Pre-commit audit (asynchronous, optional but recommended)

Trail ships a pre-commit hook script (`bin/trail-audit-precommit`) that scans
all `.trail/` files for known secret patterns before allowing a git commit. This
catches:
- Bugs in Layers 1 and 2
- New patterns added after files were captured
- User-edited packet files that re-introduced secrets

If the audit finds matches, the commit is blocked with a clear message.

## Default redaction patterns

Patterns ship in `bin/trail-redaction-patterns.yml` and load by default. All
patterns produce `[REDACTED:<pattern-name>]` markers.

```yaml
# Cryptographic and API secrets
- name: "aws-access-key"
  pattern: '\bAKIA[0-9A-Z]{16}\b'
- name: "aws-secret-key"
  pattern: '\b(?i)aws[_-]?secret[_-]?access[_-]?key["\s:=]+[A-Za-z0-9/+=]{40}\b'
- name: "github-token"
  pattern: '\bghp_[A-Za-z0-9]{36}\b'
- name: "github-fine-grained-token"
  pattern: '\bgithub_pat_[A-Za-z0-9_]{82}\b'
- name: "openai-api-key"
  pattern: '\bsk-[A-Za-z0-9]{32,}\b'
- name: "anthropic-api-key"
  pattern: '\bsk-ant-[A-Za-z0-9-]{32,}\b'
- name: "stripe-key"
  pattern: '\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{24,}\b'
- name: "private-key-pem"
  pattern: '-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----'

# Connection strings
- name: "postgres-url"
  pattern: '\bpostgres(?:ql)?://[^\s"''<>]+\b'
- name: "mysql-url"
  pattern: '\bmysql://[^\s"''<>]+\b'
- name: "mongodb-url"
  pattern: '\bmongodb(?:\+srv)?://[^\s"''<>]+\b'
- name: "redis-url"
  pattern: '\bredis://[^\s"''<>]+\b'

# Generic patterns (high false-positive rate; on by default but configurable)
- name: "bearer-token-header"
  pattern: '\b[Aa]uthorization:\s*[Bb]earer\s+[A-Za-z0-9_\-\.=]{16,}\b'
- name: "high-entropy-string"
  # Conservative: only match obvious base64-looking strings ≥40 chars
  pattern: '\b[A-Za-z0-9+/]{40,}={0,2}\b'
- name: "jwt"
  pattern: '\beyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=\-+/]+\b'
```

## Per-project configuration

`.trail/redaction.yml` (gitignored by default — projects opt in to commit it):

```yaml
# Add to default patterns
additional_patterns:
  - name: "internal-hostname"
    pattern: '\b[a-z0-9-]+\.corp\.example\.com\b'
  - name: "employee-email"
    pattern: '\b[a-z]+\.[a-z]+@example\.com\b'

# Disable specific default patterns (requires conscious opt-out)
disabled_patterns: []
# Each disable requires a justification:
# - name: "high-entropy-string"
#   justification: "Project uses base64-encoded test fixtures; pattern fires too often"

# Redaction marker format (default: [REDACTED:pattern-name])
marker_format: "[REDACTED:{pattern}]"

# What to do on Layer 2 validation failure
on_validation_failure: "abort"   # abort | warn | log-only
```

## Failure modes and responses

| Failure mode | Detection | Response |
|---|---|---|
| Capture-time redaction misses a secret | Layer 2 validation catches it on the same write | Abort write, log to `redaction_errors[]`, surface to user |
| Layer 2 validation has the same bug as Layer 1 | Layer 3 pre-commit audit catches at commit time | Block commit, surface diff |
| User disables a default pattern without realizing | Justification required in `redaction.yml`; audit at every Trail upgrade flags missing justifications | Warn user; require re-confirmation |
| New secret type not in default patterns | Generic high-entropy + JWT + Bearer-token catch most | Document the gap; users can add to `additional_patterns` |
| Secret appears in file content snapshot (PreToolUse) | Snapshots stay in memory only — never written to disk for v0.1 | Memory-only design eliminates this risk class |
| User commits `.trail/sessions/*/transcript.jsonl` despite gitignore | Pre-commit audit scans gitignored Trail paths even if force-added | Block commit |
| Anthropic transcript file (`transcript_path` outside Trail's control) leaks secrets | Out of Trail's control; document risk to user | At SessionStart, warn user that Anthropic transcripts may contain unredacted prompts; recommend `CLAUDE_CODE_SKIP_PROMPT_HISTORY` for sensitive sessions |

## File content snapshot policy (Risk 1 fallback)

The hook event matrix (HOOK-EVENT-MATRIX.md Risk 1) requires PreToolUse snapshots
of file content to compute diffs. **Snapshots stay in memory ONLY** — they are
diffed against the post-write file content, the diff is redacted, and only the
redacted diff is written to the packet. The raw before/after content never
touches disk.

If memory pressure becomes an issue (large files), v0.1 falls back to: skip the
snapshot, mark the file as "captured-with-degraded-fidelity" in the packet, and
let the user opt in to file-content-disk-cache via `.trail/redaction.yml`.

## Schema additions for v0.1

The packet schema (`pr-change-packet.v0.1.yml`) must add:

```yaml
agent_session:
  redaction_metadata:
    pattern_set_version: ""        # version of the pattern file in use
    redactions_applied: 0          # count of total redactions
    redactions_by_pattern: {}      # pattern_name → count
    validation_errors: []          # Layer 2 catches that aborted writes
    skipped_files: []              # files where snapshot was skipped due to memory
```

This makes redaction observable per-packet — reviewers can see how many secrets
Trail caught (transparency) without being shown the secrets themselves.

## Develop-phase TODO (gates that block ship)

- [ ] Implement Layer 1 (capture-time redaction) in hook scripts.
- [ ] Implement Layer 2 (write-time validation) as a re-scan before disk write.
- [ ] Implement Layer 3 (pre-commit audit) as `bin/trail-audit-precommit`.
- [ ] Ship `bin/trail-redaction-patterns.yml` with the default pattern set.
- [ ] Add `redaction_metadata` block to the packet schema (`pr-change-packet.v0.1.yml`).
- [ ] Add unit tests for each default pattern (must catch known examples; must not catch known false positives).
- [ ] Document the `.trail/redaction.yml` per-project override format in user-facing docs.
- [ ] Test on a recent Claude Code session that includes deliberate secret-pasting (in a test repo) — confirm zero leaks.

## Source

`/devils-advocate` finding F5 (decision-log 2026-05-08, Red Team #3); Mycelium L3
security gate (theory-gates.md); OWASP A02 (cryptographic failures) and A03
(injection — secret leakage as injection-class threat); industry baseline
(detect-secrets, gitleaks, trufflehog) for default pattern coverage.
