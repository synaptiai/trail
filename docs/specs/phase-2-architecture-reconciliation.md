# Phase 2 UI — Architecture Reconciliation (B5)

**Status**: B5 draft
**Date**: 2026-05-09
**Authoritative**: this document for Phase 2-specific architecture decisions; defers to `docs/architecture.md` for unchanged Layer 2/3 fundamentals
**Scope**: Phase 2 (Tauri + React + Vite) — reconcile B1–B4 with `docs/architecture.md`; lock atomic-write protocol, watcher self-race, re-capture model
**Blocks**: B6 (design review), Phase 2 build (#22)
**Blocked by**: B1, B2, B3, B4 ✓
**Companion specs**:
- B1 stories, B2 flows, B3 design system, B4 screen specs (`docs/specs/phase-2-*.md`)
- `docs/architecture.md` v0.1 (define-phase, locked 2026-05-08)
- `docs/specs/phase-1-capture.md` v1.2 (post-A4.9 spec)
- `schema/pr-change-packet.v0.1.1.yml`

---

## §1 Scope & relationship to architecture.md

`docs/architecture.md` defines the four-layer model (Capture / Storage / UI / Sync) and locks the v0.1 solo OSS substrate (local libSQL + filesystem + Tauri + same React codebase for hosted). It does **not** specify:
- Atomic-write semantics between YAML (canonical, git-committed) and libSQL (derived index)
- Filesystem watcher behavior under self-write
- Re-capture (multi-packet-per-session) versioning
- Concrete Tauri IPC channel surface area
- Phase-2-bound libSQL schema additions (review state in solo OSS)

B5 closes those gaps. Where B5 decisions extend or refine architecture.md, §9 lists the proposed amendments (apply now or queue for B6).

This doc does **not** address:
- Layer 4 sync (Cloudflare-native, v0.2+ commercial product)
- libSQL ↔ Turso Cloud sync semantics (deferred)
- E2EE for review state (architecture.md ¶218 deferred)
- Audit-trail export formats (B1 §7.2 deferred)

---

## §2 Storage substrate review

### 2.1 Architecture.md current statement (verbatim summary)

Per `docs/architecture.md` §Layer 2:
- **Provenance store (2a)**: Turso/libSQL embedded; `.trail/trail.db` per repo; single-user solo OSS.
- **Tables sketched**: `packets`, `claims`, `evidence`, `redaction_audit`.
- **Review state store (2b)**: same `.trail/trail.db` for solo (DOs are commercial-only).
- **Tables sketched**: `approvals`, `reviewers`, `comments`, `decisions`, `session_metadata`.

### 2.2 What B1–B4 require

B4 §11 introduced 15 screen-level components consuming concrete data. Mapping to storage:

| B4 component | Reads from | Writes to |
|---|---|---|
| `<TrailSidebar>` | `packets`, `claims` (count + risk distribution) | — |
| `<PacketHeader>` | `packets`, `claims` (risk dist), `posted_to_pr_history` | — |
| `<ClaimRow>` decision actions | `claims`, `approval_trail` | `approval_trail`, `packets.last_known_hash` |
| `<RiskOverrideModal>` | `claims.risk_classification_*` | `claims.risk_classification_creator_override`, `claims.risk_classification_reviewer_override` |
| `<RedactionTable>` | `redaction_audit` | — |
| `<ApprovalTrail>` | `approval_trail` chronological | — |
| `<TamperBanner>` | computed `current_hash` vs stored `last_known_hash` | `audit_log` |
| `<CarryForwardPanel>` | parent packet's `claims` + `approval_trail` | — |

This drives the libSQL schema in §7 — concrete additions over architecture.md's sketch.

### 2.3 Gaps closed by B5

| Gap (vs architecture.md) | Closed by |
|---|---|
| `approval_trail` not formally specced as a per-claim chronological row table | §7.1 schema |
| `last_known_hash` for tamper detection (AB-3 manifestation) | §7.1 schema column on `packets` |
| `posted_to_pr_history` array semantics | §7.1 schema (separate table, row per post) |
| Three-layer risk override (agent / creator / reviewer) | §7.1 schema (sub-columns on `claims`) |
| Reviewer columns (per-claim decision granularity, AB-4) | §7.1 schema |
| `parent_packet_id` (AB-6, re-capture chain) | §7.1 schema + Phase 1 amendment in §5 |
| Atomic-write protocol semantics | §3 contract |
| Watcher self-race contract | §4 contract |
| Tauri IPC surface area | §6 contract |

---

## §3 OQ-B5-1 — Atomic-write protocol

The B2 P2 primitive specified: "libSQL transaction commits BEFORE YAML rename succeeds, OR YAML write fails and libSQL is rolled back. No state where libSQL says X and YAML says Y."

Implementation choice: **saga pattern with idempotent libSQL rebuild**, not two-phase commit. Rationale: YAML is canonical (git-committed); libSQL is a derived index that can always be rebuilt from YAML. This is simpler, handles all failure modes deterministically, and matches the architecture.md "git is the data plane for content; Trail is the control plane" framing.

### 3.1 The saga pattern

```
┌─────────────────────────────────────────────────────────────┐
│  P2 Save Decision (saga)                                     │
├─────────────────────────────────────────────────────────────┤
│ 1. UI: optimistic React state update (immediate visual)     │
│ 2. Backend: read current packet.yml from disk                │
│ 3. Backend: compute new YAML with decision applied           │
│ 4. Backend: validate new YAML against schema (Ajv)           │
│ 4a. Backend: write intent-log marker                         │
│       .trail/sessions/<sid>/.pending-<N>.json                │
│       { packet_id, expected_yaml_hash, stage: 'pre-rename' } │
│ 5. Backend: write packet.yml.tmp + fsync                     │
│ 6. Backend: atomic rename tmp → packet.yml (POSIX guarantee) │
│ 6a. Backend: update intent-log marker stage = 'pre-libsql'   │
│ 7. Backend: compute sha256(approval_trail block)             │
│ 8. Backend: BEGIN libSQL TX                                   │
│       INSERT/UPDATE rows derived from new YAML state          │
│       UPDATE packets.last_known_hash = computed hash          │
│       COMMIT TX                                               │
│ 8a. Backend: delete intent-log marker (saga complete)        │
│ 9. Backend: emit IPC `decision-saved` to UI                   │
│ 10. UI: confirm visual state; enable next action              │
└─────────────────────────────────────────────────────────────┘
```

**Ordering is intentional**: YAML write happens BEFORE libSQL update. Why?
- If YAML write fails → libSQL untouched → no inconsistency.
- If libSQL update fails after YAML write → YAML is canonical; libSQL rebuilds on next P1 open. User's decision IS persisted.

**Intent-log marker (closes the crash window between step 6 and step 8)**: a small JSON marker file (`.trail/sessions/<sid>/.pending-<N>.json`) records the saga's stage so a SIGKILL / OS reboot / OOM kill / Tauri crash between the YAML rename (step 6) and the libSQL commit (step 8) can recover deterministically. Without the marker, the recovery path in §3.2 would never fire (the `libsql_dirty` flag is only set inside the libSQL TX that crashed). On Tauri startup, the backend scans `.trail/sessions/*/.pending-*.json`. For each marker:
- If `stage = 'pre-libsql'` AND the on-disk YAML hash matches `expected_yaml_hash`: invoke `rebuild_libsql_for_packet(packet_id)` (idempotent per §3.3) and delete the marker. No J12 fired — this was a crashed self-write, not external tampering.
- If `stage = 'pre-rename'` AND no `packet.yml` exists with the new content: cleanup the orphaned `.tmp` file (if any) and delete the marker. The decision was lost; UI must re-prompt.
- If marker is older than 1 hour and unresolvable: log to audit_log and delete (do not block startup).

### 3.2 Failure case matrix

| Failure point | Effect | Recovery | UI surface |
|---|---|---|---|
| Step 2 read fails (file I/O error) | No write occurred | None needed | T5 "Decision could not be saved" + retry |
| Step 4 schema validation fails (computed YAML invalid) | No write occurred | Bug in compute logic — logged | T5 + diagnostic in audit log |
| Step 5 tmp write fails (disk full, permissions) | No canonical write | Cleanup tmp file | T5 + free-space hint |
| Step 6 rename fails (rare on POSIX; Windows-specific edge cases) | Tmp orphaned | Cleanup tmp on next launch | T5 + retry |
| **Step 6 succeeds, process dies before step 8** (SIGKILL / OS reboot / OOM kill / Tauri crash) | YAML canonical; libSQL untouched; `last_known_hash` STILL points at the OLD YAML; `libsql_dirty` is NOT yet set | Intent-log marker (per §3.1 step 4a / 6a) detected on next launch with `stage='pre-libsql'`; backend invokes `rebuild_libsql_for_packet(packet_id)` automatically; marker deleted; **no J12 fired** | (N/A — recovery is silent and idempotent; audit_log records `event_type=saga_recovered` with marker contents for visibility) |
| Step 8 libSQL TX fails (DB locked, schema mismatch) | YAML canonical; libSQL stale | Mark `packets.libsql_dirty = TRUE`; rebuild on next P1 open | T1 "Decision saved" (success — YAML wrote) + warning in audit log |
| Step 9 IPC fails (Tauri shell crash) | Both stores updated; UI thinks it wasn't | On reload, P1 sees correct state | (N/A — UI restart recovers) |

### 3.3 libSQL rebuild contract

Triggered when (a) `packets.libsql_dirty = TRUE`, (b) hash mismatch detected on P1 open, (c) explicit user action via Settings.

```
rebuild_libsql_for_packet(packet_id):
  yaml = read .trail/sessions/<sid>/packet.yml  # subject to §6.5 YAML safety
  validate(yaml)  # may abort and surface E4 malformed
  
  BEGIN IMMEDIATE TRANSACTION  # acquires write lock; concurrent readers see pre-rebuild state until COMMIT
    DELETE FROM claims WHERE packet_id = ?
    DELETE FROM approval_trail WHERE packet_id = ?
    DELETE FROM redaction_audit WHERE packet_id = ?
    DELETE FROM posted_to_pr_history WHERE packet_id = ?
    
    INSERT INTO packets (...) VALUES (...)  # ON CONFLICT UPDATE
    INSERT INTO claims SELECT FROM yaml.claims
    INSERT INTO approval_trail SELECT FROM yaml.approval_trail
    INSERT INTO redaction_audit SELECT FROM yaml.redaction_audit
    INSERT INTO posted_to_pr_history SELECT FROM yaml.posted_to_pr
    
    UPDATE packets SET 
      last_known_hash = sha256(yaml.approval_trail),
      libsql_dirty = FALSE
  COMMIT
```

`BEGIN IMMEDIATE` (vs `BEGIN DEFERRED`, the SQLite default) acquires the write lock at TX start, so concurrent readers (the trail browser polling for refresh) see the pre-rebuild state until COMMIT — preventing a "0 claims" flicker for the packet under rebuild. Cosmetic-but-noticeable; cheap to fix here.

Idempotent: rebuild can run multiple times without side effects beyond DB rows.

### 3.4 Performance budget

- Step 2 read: ≤ 20ms (typical packet 50-200 KB).
- Steps 3-4 compute + validate: ≤ 30ms.
- Step 5 tmp write + fsync: ≤ 50ms (dominated by fsync on macOS HFS+/APFS).
- Step 6 rename: ≤ 5ms.
- Step 7 hash: ≤ 5ms.
- Step 8 libSQL TX: ≤ 50ms.
- Step 9 IPC: ≤ 5ms.
- **Total durable confirmation**: ≤ 200ms (within B2 P2 budget of 500ms; comfortable margin for slower disks).

UI optimistic feedback (step 1) is ≤ 100ms (B2 P2 budget); decoupled from backend completion.

### 3.5 Concurrency

v0.1 is single-user, single-process Tauri. No concurrent writers expected. Backend serializes P2 calls per packet via an in-memory mutex keyed by `packet_id`. If two decisions arrive for the same packet, the second waits for the first.

Cross-process concurrency (e.g., user runs `trail packet generate` simultaneously while UI saves a decision): handled via the watcher self-race protocol (§4). The capture pipeline writes to a different filename pattern (versioned `packet-N.yml` per §5), so collision is structurally avoided.

---

## §4 OQ-B5-2 — Watcher self-race avoidance

### 4.1 The problem

P4 (filesystem watcher) reacts to `.trail/` directory changes. P2 (atomic write) IS such a change. Without self-race protection, every UI write would re-trigger P4, which would re-read the YAML the UI just wrote — wasted work + potential state desync.

Worse: if the watcher fires during a write (between tmp-write and rename, or between rename and libSQL update), it could surface a half-state to the UI.

### 4.2 The contract

**Debounce + saga-in-flight flag + content-hash compare against libSQL.**

Debounce alone is unsafe when slow disks (Windows + spinning disk + Defender real-time scan; libSQL TX under disk pressure 200-500ms) push the saga total beyond the debounce window. The watcher would then read the new YAML hash before step 8 commits, see "external edit," and fire J12 against the user's own write — training users to dismiss J12 routinely (security desensitization). Self-write detection is therefore NOT debounce alone — it's debounce + a backend-internal "saga in flight" flag, with hash compare as the FALLBACK for cross-process / external writes.

```
# In-memory state (process-local; survives restarts via §3.1 intent-log marker)
saga_in_flight: Map<packet_id, true>  # set on §3.1 step 4a; cleared on step 8a

on_fs_change(path: PathBuf):
  if not path.matches("**/.trail/sessions/*/packet*.yml"):
    return  # ignore non-packet files
  
  debounce(500ms)  # widened from 200ms; matches B2 P2 durable-confirmation budget
  
  packet_id = parse_packet_id_from_path(path)
  
  # Fast path: skip if our own saga is in flight
  if saga_in_flight.contains(packet_id):
    return  # backend wrote this; no UI notification needed
  
  current_yaml_hash = sha256(read path).approval_trail_block
  stored_hash = libsql.SELECT last_known_hash FROM packets WHERE packet_id = ?
  
  if current_yaml_hash == stored_hash:
    return  # libSQL is in sync; either saga finished cleanly or this is a no-op rewrite
  
  # External edit detected (cross-process or out-of-app)
  if packet_id is currently_open_in_ui:
    emit_ipc("packet-changed-externally", packet_id)
    # UI displays J12 tamper warning if user is in the packet view
  
  if currently_in_trail_browser:
    emit_ipc("trail-needs-refresh")
    # UI re-queries libSQL to update timeline
```

**Two-layer self-write detection**: (1) saga-in-flight flag is the primary mechanism — covers the slow-disk window where saga exceeds debounce; (2) hash compare is the fallback — covers cross-process external writes (someone runs `vim packet-1.yml` while Trail is open). The flag is in-memory only; it survives saga crashes via the §3.1 intent-log marker (recovery on next launch sets `libsql_dirty` and rebuilds, which updates the hash; subsequent watcher events read the new hash and become no-ops).

### 4.3 Why this is elegant

Solves three concerns at once:
1. **Self-race avoidance**: hash-compare correctly identifies UI's own writes (libSQL was updated AFTER YAML, so by debounce-time, libSQL has the new hash).
2. **Tamper detection**: any external edit (manual YAML edit, git pull bringing in someone else's update) shows as hash mismatch → triggers J12 banner.
3. **No fragile lock-file mechanism**: the file-system itself becomes the source of truth; no `.write-lock` files to clean up on crash.

### 4.4 Failure modes

| Failure | Effect | Recovery |
|---|---|---|
| Watcher misses an event (notify crate rare bug) | UI doesn't auto-refresh on external change | User explicitly opens packet → P1 hash-check fires J12 if needed |
| libSQL query in step 5 fails | Watcher cannot determine self vs external | Default to `external` (safe choice); UI shows tamper warning; user dismisses if they know it was their own action |
| Saga in-flight flag missed (e.g., flag-set bug) | Self-write detected as external | Falls back to hash compare; if saga step 8 has committed by then, hash matches → no J12. If still pre-step-8: J12 fires; user dismisses; recovery via re-verify. |
| Debounce window > 500ms (very slow disk under heavy IO) | First event may be treated as external | Saga-in-flight flag still catches the common case; only triggers if both debounce AND saga-in-flight miss. Spurious J12 cost: low and infrequent. |

### 4.5 Performance budget

- Debounce window: **500ms (locked; widened from 200ms)** — decoupled from saga budget to absorb slow-disk windows.
- Saga-in-flight flag check: ≤ 1ms (in-memory map lookup).
- Hash compute on event: ≤ 10ms (small file).
- libSQL hash query: ≤ 5ms.
- IPC emission: ≤ 5ms.
- **Total per event**: ≤ 521ms from FS event to UI notification (or no-op).

The 500ms budget costs slight delay on cross-process external edits surfacing in UI; cheap relative to the J12-noise harm prevented. Bursty captures still collapse to one event.

Bursty captures (e.g., agent writes 5 files in quick succession): debounce collapses to one event; backend processes once. Acceptable.

### 4.6 What is watched

```
.trail/
├── sessions/
│   ├── <session-id>/
│   │   ├── packet-1.yml           ← watched
│   │   ├── packet-1.md            ← watched (markdown sibling, may be regenerated)
│   │   ├── packet-2.yml           ← watched
│   │   └── packet-2.md
│   └── ...
├── trail.db                       ← NOT watched (libSQL handles its own change events via better-sqlite3)
├── audit.log                      ← NOT watched (append-only; reads are explicit)
└── settings.json                  ← NOT watched (lives in ~/.trail/, not repo .trail/)
```

Recursive watch on `.trail/sessions/`. Single watcher per repo (one Tauri instance = one repo).

---

## §5 OQ-B5-3 — Re-capture model

### 5.1 The decision

**Phase 1 (capture pipeline) owns versioning.** Phase 2 (UI) consumes versioned packets transparently.

Rationale:
- Capture is the artifact-creation layer; it knows when a session is being re-captured (same session_id, new generation timestamp).
- UI should not have to detect re-capture from filesystem state alone (race-prone, fragile).
- Versioning at write-time means the YAML itself is immutable post-write; no UI-side renames needed.

### 5.2 Phase 1 spec amendment requirements

`docs/specs/phase-1-capture.md` v1.2 currently writes `packet.yml`. Phase 1 must amend:

1. **Detect existing sessions**: on `trail packet generate <session-id>`, scan `.trail/sessions/<sid>/` for prior `packet-N.yml` files.
2. **Determine version**: `next_n = max(N for packet-N.yml in dir) + 1`. First capture: `packet-1.yml`.
3. **Populate `parent_packet_id`**:
   - First capture (`N=1`): `parent_packet_id = null`.
   - Subsequent (`N>1`): `parent_packet_id = read packet-(N-1).yml._meta.packet_id`.
4. **Write to versioned path**: `.trail/sessions/<sid>/packet-<N>.yml` (and `packet-<N>.md` if rendered).
5. **No more `packet.yml`** (without `-N` suffix). Migration of v0.1 fixtures: regenerate via A7.

### 5.3 Schema impact

`schema/pr-change-packet.v0.1.1.yml` requires:

```yaml
# Addition under _meta:
_meta:
  packet_id: string  # ULID, already present
  session_id: string  # already present
  parent_packet_id:
    type: ["string", "null"]
    description: "ULID of the prior packet in this session's chain. Null for first capture."
```

This is **additive**, so it lands in v0.1.1 (no breaking change). **AB-6 is now confirmed as MUST in v0.1.1**.

### 5.4 Phase 2 consumption pattern

```
on_open_packet(packet_path):
  yaml = read packet_path  # subject to §6.5 YAML safety contract
  packet = parse(yaml)
  current_repo_path = git rev-parse --show-toplevel
  
  if packet._meta.parent_packet_id is null:
    # First capture in chain — no carry-forward
    render_packet_view(packet)
    return
  
  parent = libsql.SELECT * FROM packets WHERE packet_id = packet._meta.parent_packet_id
  
  if not parent exists:
    # Parent missing (e.g., partially synced repo); degrade gracefully
    render_packet_view(packet)
    log_warning("parent_packet_id references missing packet")
    return
  
  # Cross-repo isolation: verify parent is from this repo before folding into carry-forward
  if parent.repo_path != current_repo_path:
    log_warning(
      "parent_packet_id resolved to a packet from a different repo: " + parent.repo_path
    )
    render_packet_view(packet)  # no carry-forward
    return
  
  # Defensive: a real re-capture chain stays within one session
  if parent.session_id != packet._meta.session_id:
    log_warning("parent_packet_id resolves across sessions; skipping carry-forward")
    render_packet_view(packet)
    return
  
  carry_forward = compute_carry_forward(packet.claims, parent.claims)
  render_packet_view_with_carry_forward(packet, carry_forward)
```

**Cross-repo isolation rationale (P2 finding)**: `libsql.SELECT * FROM packets WHERE packet_id = ?` queries the per-repo libSQL. If the user has two checkouts (worktree, fork, submodule) or a deliberately crafted ULID collision, a `parent_packet_id` could resolve to a packet from a different repo. ULID uniqueness is astronomical, but craft is non-zero. Verifying `parent.repo_path == current_repo_path` AND `parent.session_id == packet._meta.session_id` catches both accidental cross-repo overlap and deliberate ULID craft. Low-likelihood high-impact: parent-confusion crosses the "the trail says X" trust boundary.

`compute_carry_forward` matches claims by stable `claim.id` (AB-5 dependency); on AB-5 not landed, falls back to text-similarity matching with warning UI.

### 5.5 Trail browser consumption

The trail browser timeline (§3 of B4) groups packets by `session_id`; "Your recent sessions" pin aggregates across the chain via `parent_packet_id` traversal. Display rules:
- Most-recent packet of each chain shown by default.
- Expanding a session row shows all packets in chain, ordered by capture time.
- Display label: "packet-N (latest)" / "packet-N-1" / etc.

### 5.6 Migration concern

Existing fixtures in `py-reference/fixtures/` use `canonical-session.yml` (no version suffix). A7 (fixture regeneration) must produce `packet-1.yml` (versioned) under `py-reference/fixtures/sessions/<sid>/`. **Add to A7 task scope**.

---

## §6 Tauri IPC channel surface area

### 6.1 IPC contract

Tauri's IPC is the only channel between Rust backend and React frontend. Strict allowlist; no dynamic command invocation.

| Command | Direction | Args | Returns | Notes |
|---|---|---|---|---|
| `read_packet` | FE → BE | `{ packet_id: string }` | `Packet \| Error` | Calls P1 Open |
| `save_decision` | FE → BE | `{ packet_id, claim_id, decision, reason?, by, at }` | `{ ok: bool, error? }` | Calls P2 saga |
| `override_risk` | FE → BE | `{ packet_id, claim_id, layer: 'creator'\|'reviewer', new_level, reason, by, at }` | `{ ok, error? }` | Variant of P2 |
| `post_to_pr` | FE → BE | `{ packet_id, pr_number?: int }` | `{ ok, pr_url?, error?, destination?: { owner, name } }` | Calls P3 sync. **Hardening**: `pr_number` validated as int32 > 0 in Rust handler (reject `<= 0`, `> 2^31`, non-integers). Args passed as array (no shell-string interpolation). Before invoking `gh pr api`, backend runs `gh repo view --json nameWithOwner` and returns `destination` in the response so M4 can DISPLAY "Posting to: github.com/{owner}/{name}" for explicit user confirmation. Rejects `gh.enterprise` / non-`github.com` hostnames in v0.1. |
| `query_trail` | FE → BE | `{ filter: TrailFilter, limit?: int = 50, cursor?: string }` | `{ packets: Packet[], nextCursor?: string }` | Trail browser query. **Mandatory pagination**: cursor is opaque (server-encoded `(captured_at, packet_id)` tuple). Trail browser virtualizer fetches next page on scroll. At 1000 packets × ~10KB each, an unpaginated query would push 10MB JSON over Tauri IPC per filter change — the trail-browser 300ms budget cannot be met. Without pagination: not supported in v0.1. |
| `query_recent_sessions` | FE → BE | `{ limit: int = 5 }` | `Session[]` | "Your recent sessions" pin. Default limit 5 matches B4 §3.4 sidebar pin display. Higher limits up to 50 valid; backend caps at 50. |
| `read_settings` | FE → BE | `{}` | `Settings` | Reads `~/.trail/settings.json` |
| `write_settings` | FE → BE | `{ partial: Settings }` | `{ ok }` | Atomic settings write |
| `preview_redacted` | FE → BE | `{ packet_id, redaction_id }` | `{ original?, error? }` | Opt-in, in-memory only |
| `audit_log_append` | FE → BE | `{ event_type: 'tamper_dismissed' \| 'tamper_re_verified' \| 'settings_changed_via_ui', packet_id?, details }` | `{ ok }` | **Restricted enum**: frontend-callable only for UI-attributable events. Backend rejects any other `event_type` value. Server-internal events (`tamper_detected`, `settings_validation_failed`, `saga_recovered`, `yaml_parse_rejected`) use a backend-private logger that does NOT flow through IPC, so a future JS-injection vector cannot fake them. |
| `subscribe_fs_watch` | FE → BE | `{}` (channel subscription) | event stream | Watcher events |
| `subscribe_settings_change` | FE → BE | `{}` | event stream | Cross-window settings sync (v0.2+) |

| Event (BE → FE) | Payload | When |
|---|---|---|
| `packet-changed` | `{ packet_id }` | P4 detects change matching open packet |
| `packet-changed-externally` | `{ packet_id, mismatch_type }` | P4 detects external write (J12 trigger) |
| `trail-needs-refresh` | `{}` | P4 detects change to non-open packets |
| `decision-saved` | `{ packet_id, claim_id }` | P2 step 9 |
| `decision-failed` | `{ packet_id, claim_id, error }` | P2 abort |
| `post-progress` | `{ stage, packet_id }` | P3 progress (auth-check / posting / done) |

### 6.2 Allowlist

Tauri's `allowlist` config (`tauri.conf.json`):
- `fs.readDir` / `fs.readFile`: scoped to `.trail/` and `~/.trail/` only
- `fs.writeFile`: scoped to `.trail/sessions/*/packet-*.yml.tmp` and `~/.trail/settings.json` only
- `fs.rename`: scoped to `.trail/sessions/*/packet-*.yml.tmp` → `.trail/sessions/*/packet-*.yml`
- `shell.execute`: ONLY `gh` CLI with whitelisted args (`gh auth status`, `gh pr view`, `gh repo view --json nameWithOwner`, `gh api repos/.../pulls/N`). **Args are passed as array (no shell-string interpolation)**; `pr_number` validated as int32 > 0 in the Rust command handler before invocation; destination owner/name derived from `gh repo view` and surfaced to M4 for user confirmation; `gh.enterprise` / non-`github.com` hostnames rejected in v0.1. This converts the "review a malicious PR" path (drive-by OSS contributor sets a malicious `origin` remote URL) from "post my review with embedded secrets to attacker's repo" into "user sees the destination owner/name in M4 and aborts."
- `shell.open`: external URL (deep-link-safe whitelist)
- `notification`: yes (toast surface uses native notifications optionally)
- `dialog`: open-file dialog scoped to git-repo directories
- `clipboard.writeText`: yes (for copy-button affordances) — **denied during M3 redaction-preview modal lifetime**: M3's render-context flag (`window.__trailInRedactionPreview === true`) is the gate; a global wrapper around `navigator.clipboard.writeText` rejects writes when the flag is set. Tauri 2.x per-window capability tokens are the long-term gate (v0.2+).
- `clipboard.readText`: NO (defense-in-depth — Trail does not need to paste)

### 6.3 Permission boundary

Tauri's permission model is the security gate. Anything outside the allowlist is BLOCKED by the framework, not by app code. This means:
- App cannot read arbitrary filesystem paths.
- App cannot execute arbitrary shell commands.
- App cannot make HTTP requests (no `http` allowlist by default).
- All network egress goes through `gh` CLI (which is explicitly auth'd to GitHub).

### 6.4 IPC type safety

Generated TypeScript types from a single Rust source-of-truth (using `ts-rs` or `tauri-specta` crate). Rust types in `apps/ui/src-tauri/src/ipc.rs`; TS types in `apps/ui/src/ipc/generated.ts`. Build script regenerates on Rust changes.

### 6.5 YAML safety (parse-time hardening for git-pulled packets)

Phase 2 ingests YAML from packets a contributor may have committed to a PR you check out (B1 J6 reviewer arrival case; the watcher §4 auto-parses on `git pull`). Parsers default to permissive YAML 1.1 modes (custom tags, anchors with merge keys, `yes`/`no`/`on` booleans) that admit DoS via billion-laughs / quadratic-blowup anchor bombs (CVE-2013-4660 family is evergreen). Phase 1 spec §11 already requires safe-load on `bin/trail-redaction-patterns.yml`; Phase 2 inherits the responsibility for packet YAML and pins it explicitly here.

**Parse-time policy (binding on §3.1 step 4, §3.3 `rebuild_libsql`, §5.4 `on_open_packet`)**:

1. **Library + mode**: use `yaml` package (eemeli/yaml) with `{ schema: 'core' }` mode (no custom tags, no merge keys, YAML 1.2 spec). If `js-yaml` is used instead, `safeLoad` / `load(... { schema: CORE_SCHEMA })` only — never `load` with default options.
2. **Size cap**: reject if input exceeds **10 MB** before parse. (Typical packet 50-200 KB per §3.4; 10 MB is generous.)
3. **Parse timeout**: wrap parse in 500ms timeout via `Promise.race`. Quadratic blowup (anchor bombs) triggers timeout before exhausting memory.
4. **Anchor cap**: reject if anchor count > 100 (anti billion-laughs heuristic; counted by pre-parse string scan for `&` / `*`).
5. **Failure surfacing**: parse failure produces a new IPC error variant `{ ok: false, error: 'yaml-parse-rejected', reason: 'size-cap'|'timeout'|'anchor-count'|'syntax' }`. Surfaced in B4 §6.4 E4 malformed packet card with the reason code visible to user. Audit log records `event_type=yaml_parse_rejected, packet_id, reason`.

This contract applies to ALL packet YAML reads, including the canonical packet, parent packets traversed during carry-forward (§5.4), and packets re-read during rebuild (§3.3).

### 6.6 Settings file integrity

`~/.trail/settings.json` lives outside the repo's `.trail/` directory and outside the `fs.writeFile` allowlist scope (§6.2). Any other app the user runs can write it. Without validation on read, a malicious flip of `theme: "off"` (defeats theme contract) or `disable_tamper_warnings: true` (B4 §6.8 surfaces a Settings → Redaction toggle of similar shape) is silently honored on the next launch.

**Read-path integrity contract**:

1. **Strict schema validation**: Settings shape defined in zod (or valibot). On read:
   - Reject unknown keys (drop with audit_log entry).
   - Reject type-mismatch values (fall back to default for that field; log entry).
   - On structural validation failure (entire file unparseable), fall back to all-defaults; log `event_type=settings_validation_failed` to audit_log.
2. **HMAC integrity check**: settings.json includes a non-secret HMAC field, keyed by a per-install secret stored in the OS keychain (Tauri `tauri-plugin-stronghold` or `keyring` crate). On read mismatch, fall back to defaults; log to audit_log.
3. **Documented limitation**: settings integrity is best-effort. A root-level attacker can read the keychain and forge the HMAC; the design does not prevent this. Documented as v0.1 hardening in this section.

The same contract applies to settings-write: `write_settings` IPC validates against the schema; any unknown key is rejected before disk write. This prevents silent extension of the settings shape via bug or compromised UI code.

---

## §7 libSQL schema (v0.1 solo OSS)

### 7.1 Tables

```sql
-- Packets — one row per packet (versioned via parent_packet_id chain)
CREATE TABLE packets (
  packet_id          TEXT PRIMARY KEY,         -- ULID
  session_id         TEXT NOT NULL,
  parent_packet_id   TEXT REFERENCES packets(packet_id),  -- null for first in chain
  repo_path          TEXT NOT NULL,            -- absolute path of repo at capture time
  captured_at        TEXT NOT NULL,            -- ISO 8601
  schema_version     TEXT NOT NULL,            -- e.g. "v0.1.1"
  yaml_path          TEXT NOT NULL,            -- relative path from repo: .trail/sessions/<sid>/packet-N.yml
  last_known_hash    TEXT,                     -- sha256(approval_trail block); null until first decision
  libsql_dirty       INTEGER NOT NULL DEFAULT 0,  -- bool; flagged when libSQL needs rebuild
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_packets_session  ON packets(session_id);
CREATE INDEX idx_packets_captured ON packets(captured_at DESC);
CREATE INDEX idx_packets_parent   ON packets(parent_packet_id);

-- Claims — one row per claim
CREATE TABLE claims (
  claim_id                              TEXT PRIMARY KEY,           -- stable across re-captures (AB-5)
  packet_id                             TEXT NOT NULL REFERENCES packets(packet_id) ON DELETE CASCADE,
  claim_text                            TEXT NOT NULL,
  synthesis_mode                        TEXT NOT NULL,              -- 'mechanical'|'llm-augmented'|'per-diff'
  -- agent's classification:
  risk_level_agent                      TEXT NOT NULL,              -- 'low'|'med'|'high'|'crit'
  risk_rationale_agent                  TEXT,
  -- creator's override (AB-1):
  risk_level_creator_override           TEXT,                       -- null if not overridden
  risk_reason_creator_override          TEXT,
  risk_creator_override_at              TEXT,
  risk_creator_override_by              TEXT,
  -- reviewer's override (AB-1a):
  risk_level_reviewer_override          TEXT,                       -- null if not overridden
  risk_reason_reviewer_override         TEXT,
  risk_reviewer_override_at             TEXT,
  risk_reviewer_override_by             TEXT,
  -- ordering within packet:
  position                              INTEGER NOT NULL
);
CREATE INDEX idx_claims_packet  ON claims(packet_id, position);

-- Claim evidence — one row per evidence item (diff hunk, command, test, prompt)
CREATE TABLE claim_evidence (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id          TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  evidence_type     TEXT NOT NULL,             -- 'diff'|'command'|'test'|'prompt'
  evidence_ref      TEXT NOT NULL,             -- file:line / cmd hash / test id / prompt id
  evidence_payload  TEXT,                      -- excerpt, output, etc.
  position          INTEGER NOT NULL
);
CREATE INDEX idx_evidence_claim ON claim_evidence(claim_id, position);

-- Approval trail — chronological per-claim decision history (AB-4)
CREATE TABLE approval_trail (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  packet_id    TEXT NOT NULL REFERENCES packets(packet_id) ON DELETE CASCADE,
  claim_id     TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  decision     TEXT NOT NULL,                 -- 'accept'|'changes'|'block'|'reject'
  reason       TEXT,
  decided_by   TEXT NOT NULL,                 -- 'creator'|'reviewer'|<user-identity>
  decided_at   TEXT NOT NULL,
  position     INTEGER NOT NULL                -- chronological order within packet
);
CREATE INDEX idx_trail_packet     ON approval_trail(packet_id, position);
CREATE INDEX idx_trail_claim      ON approval_trail(claim_id, decided_at);

-- Redaction audit — per pattern × layer counts (AB-8)
CREATE TABLE redaction_audit (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  packet_id              TEXT NOT NULL REFERENCES packets(packet_id) ON DELETE CASCADE,
  pattern_set_version    TEXT NOT NULL,
  pattern_id             TEXT NOT NULL,        -- e.g. 'slack-token'
  layer                  INTEGER NOT NULL,     -- 1, 2, or 3
  match_count            INTEGER NOT NULL,
  locations_summary      TEXT                   -- e.g., '2 command outputs, 1 prompt'
);
CREATE INDEX idx_redact_packet ON redaction_audit(packet_id);

-- Posted-to-PR history (AB-2 — array semantics)
CREATE TABLE posted_to_pr_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  packet_id   TEXT NOT NULL REFERENCES packets(packet_id) ON DELETE CASCADE,
  pr_url      TEXT NOT NULL,
  pr_number   INTEGER NOT NULL,
  body_hash   TEXT NOT NULL,                   -- sha256 of the markdown that was posted; enables future J13 "PR body diverged" check (see §7.1.1)
  posted_at   TEXT NOT NULL,
  posted_by   TEXT NOT NULL
);
CREATE INDEX idx_posted_packet ON posted_to_pr_history(packet_id, posted_at DESC);

-- Audit log — append-only event ledger (J12, settings changes, future events)
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT NOT NULL,                  -- 'tamper_detected'|'tamper_re_verified'|'settings_changed'|'saga_recovered'|'yaml_parse_rejected'|...
  packet_id    TEXT REFERENCES packets(packet_id),  -- nullable (settings events have no packet)
  details      TEXT NOT NULL,                  -- JSON blob
  prev_hash    TEXT,                           -- hash of the previous row's row_hash; null for first row
  row_hash     TEXT NOT NULL,                  -- sha256(event_type || coalesce(packet_id,'') || details || occurred_at || coalesce(prev_hash,''))
  occurred_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_time ON audit_log(occurred_at DESC);

-- Append-only enforcement (catches accidental + naive tampering at SQL layer)
CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(FAIL, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(FAIL, 'audit_log is append-only');
END;
```

**Three-level audit-log integrity defense**:
1. **Schema-level (this trigger)**: blocks `UPDATE` and `DELETE` via SQLite triggers. Catches accidental + naive tampering. Cannot defend against `DROP TABLE` followed by recreate, or direct file edit of `trail.db`.
2. **Hash-chain integrity** (`prev_hash` + `row_hash` columns): each row's hash is computed over its own fields plus the prior row's hash. On read, the audit-log loader recomputes the chain; first mismatch is detected and surfaced as a tamper event in `audit_log_verify` IPC. Catches sophisticated direct-SQL tampering (a deletion mid-chain breaks the chain at the next row).
3. **Documented v0.2 path**: §9.7 (architecture amendment) records that audit-log integrity is best-effort in v0.1 solo OSS; commercial v0.2+ moves audit_log to write-once cloud storage (DOs). B5 threat model §4.4 gains a new case-d "audit log rewrite" with v0.2 deferred status.

Total: 7 tables, 13 indexes, 2 triggers.

### 7.1.1 `body_hash` use (documented future verifier; v0.1 records, v0.2 surfaces)

`posted_to_pr_history.body_hash` is sha256 of the markdown posted at each entry. Trail's stated value is "the trail is dispositive" — that extends to the PR body the user posted. A reviewer who edits the Trail-managed section of the PR body should be detectable.

**v0.1**: hash is recorded; not surfaced in UI. The column is not dead data — it documents intent and reserves the verifier path.

**v0.2 path**: a future `verify_pr_body(packet_id) → { match: bool, last_posted_at, current_body? }` IPC compares the live PR body's Trail-managed section against the most recent `body_hash`. UI surface: J13 "PR body diverged from posted state" banner on the packet view (analogous to J12 tamper warning, scoped to the GitHub side).

This documentation closes the dead-data finding and pre-stages the v0.2 surface; no v0.1 implementation cost beyond the column already specced.

### 7.2 ORM choice

**Drizzle** (recommended in architecture.md and re-confirmed here). Rationale:
- TypeScript-first; schema definition mirrors the SQL above.
- Same client works for `better-sqlite3` (Node) and `@libsql/client` (Tauri's libSQL).
- Migrations via `drizzle-kit`.
- No runtime overhead (no query builder magic at request time).

Alternatives rejected: Prisma (heavy runtime; less Tauri-friendly), Kysely (good but less ecosystem).

### 7.3 Migration strategy

Phase 2 ships migration v0001 (initial schema, the 7 tables above). Migrations live in `apps/ui/src/db/migrations/`. Drizzle-kit auto-generates SQL from schema diffs; reviewed by hand before commit.

For v0.2+ schema changes:
- Additive (new column, new table): straightforward migration.
- Breaking (column rename, type change): migration + data backfill script.
- libSQL rebuild from YAML is always the fallback recovery path if migration corrupts.

### 7.4 Rebuild contract (formal)

Per §3.3, libSQL is rebuildable from YAML. Implementation:

```ts
async function rebuildLibSQL(packetId: string): Promise<void> {
  const yaml = await fs.readFile(yamlPathFor(packetId), 'utf8');
  const packet = parsePacket(yaml);  // throws on schema invalid
  
  await db.transaction(async (tx) => {
    await tx.delete(claims).where(eq(claims.packet_id, packetId));
    await tx.delete(approval_trail).where(eq(approval_trail.packet_id, packetId));
    await tx.delete(redaction_audit).where(eq(redaction_audit.packet_id, packetId));
    await tx.delete(posted_to_pr_history).where(eq(posted_to_pr_history.packet_id, packetId));
    
    await tx.insert(packets).values({...packet.meta, libsql_dirty: false}).onConflictDoUpdate(...);
    await tx.insert(claims).values(packet.claims.map(claimToRow));
    await tx.insert(approval_trail).values(packet.approval_trail.map(trailToRow));
    await tx.insert(redaction_audit).values(packet.redaction_audit.map(redactToRow));
    await tx.insert(posted_to_pr_history).values((packet.posted_to_pr ?? []).map(postToRow));
    
    const hash = computeApprovalTrailHash(packet);
    await tx.update(packets).set({last_known_hash: hash}).where(eq(packets.packet_id, packetId));
  });
}
```

Triggered by:
- P1 step 3 detects hash mismatch (after user dismiss of J12 with re-verify).
- Settings → "Rebuild trail database" action.
- Auto-triggered if `libsql_dirty = TRUE` flag is set.

---

## §8 Updated AB feedback (closes B5 contributions)

Updating the running AB list with B5 resolutions:

| ID | Item | Severity | Status post-B5 |
|---|---|---|---|
| AB-1 | `risk_classification.creator_override.{level, reason, at, by}` (claim-level) | SHOULD | Unchanged from B2; needs Phase 1 schema confirmation |
| AB-1a | `risk_classification.reviewer_override.{level, reason, at, by}` (claim-level) | SHOULD | Unchanged from B2 |
| AB-2 | `posted_to_pr` as array | SHOULD | **Resolved at libSQL layer** (separate `posted_to_pr_history` table); Phase 1 YAML can mirror as array OR singleton — either works since libSQL accumulates history. Recommendation: array in YAML for consistency. |
| **AB-3** | content-hash on approval_trail | **MUST** | **Refined**: NOT a packet schema field — it's a `packets.last_known_hash` libSQL column (per §7.1). No Phase 1 schema change needed. AB-3 is **closed at the storage layer**. |
| AB-4 | per-claim approval_trail granularity | MUST | **Resolved**: §7.1 `approval_trail` table has per-claim, per-decision rows. Phase 1 YAML schema must support same — confirm in v0.1.1 or amend. |
| AB-5 | claim.id stability across re-captures | MUST | **Unchanged**; Phase 1 amendment required. Closing event: A6/A7 backports + fixture regen. |
| **AB-6** | `parent_packet_id` for re-capture chains | **MUST** | **Resolved as Phase 1 v0.1.1 amendment** (§5.3); additive schema bump. Phase 1 spec must add re-capture detection + versioned-write logic per §5.2. |
| AB-7 | session-only in-memory cache for J4 redaction preview | OPTIONAL | **Unchanged**; defaults to "preview unavailable" if cache absent. UI affordance gracefully degrades. |
| AB-8 | per-pattern-per-layer redaction breakdown | SHOULD | **Resolved**: §7.1 `redaction_audit` table has per-pattern × per-layer rows. Phase 1 YAML schema needs same field shape — confirm. |
| **AB-9 (NEW)** | Phase 1 spec re-capture amendment (versioned packets, parent_packet_id population, no `packet.yml` without -N suffix) | MUST | **NEW** — surfaced by B5 §5.2; blocks Phase 2 J2 carry-forward; A6 task scope must include this. |
| **AB-10 (NEW)** | A7 fixture regen must produce versioned `packet-1.yml` (not `canonical-session.yml`) | MUST | **NEW** — surfaced by B5 §5.6; blocks Phase 1 parity tests against fixtures. A7 task scope must include this. |

**AB count is now 10.** Of these:
- 5 are MUST (AB-3 resolved at storage layer; AB-4/5/6/9/10 require Phase 1 changes).
- 4 are SHOULD (AB-1/1a/2/8).
- 1 is OPTIONAL (AB-7).

**Critical observation**: AB-3 (the only B1-listed MUST) is now closed at the storage layer with NO Phase 1 schema change. This removes a perceived blocker; Phase 1 can proceed without v0.1.2 schema bump for tamper detection.

**Remaining Phase-1-blocking AB items**: AB-4, AB-5, AB-6, AB-9, AB-10. All addressable in v0.1.1 additive schema bump + Phase 1 spec amendments via A6 task.

### 8.1 Recommendation for #41 AB stage

#41 (UX-driven schema gap reconciliation) should:
1. Confirm v0.1.1 schema accepts AB-1, AB-1a, AB-2 (or schedule v0.1.2).
2. Apply AB-4, AB-5, AB-6 to Phase 1 spec (`docs/specs/phase-1-capture.md` amendment).
3. Update A6 task scope to include AB-9 (re-capture detection logic in Phase 1 backports).
4. Update A7 task scope to include AB-10 (fixture file naming).
5. Mark AB-3 closed (resolved at libSQL layer).
6. Defer AB-7 to v0.1.x as opt-in feature.
7. AB-8 confirms or schedules.

This is a tractable triage list; each item has a clear resolution path.

### 8.2 Degraded-mode behavior on un-landed AB items

A coordination accident (e.g., Phase 1 v0.1.1 lands AB-4 but not AB-6) puts Phase 2 in undefined territory unless degraded-mode behavior is specified. Phase 2 build is NOT blocked on this matrix — each MUST item has a documented fallback so the team can ship with partial AB resolution.

| AB item missing in Phase 1 | Phase 2 degraded behavior |
|---|---|
| **AB-4 absent** (per-claim approval_trail granularity) | Trail tab shows placeholder card: "approval_trail not available; this is a Phase 1 v0.1.0 packet." Decisions still record locally to libSQL (since libSQL schema in §7.1 has the per-claim columns); they just don't sync back to YAML. UI banner: "Decisions captured here will not propagate to YAML until packet is regenerated against v0.1.1+." |
| **AB-5 absent** (claim.id stability) | `compute_carry_forward` falls back to text-similarity matching with confidence threshold; J2 step 8 surfaces a warning UI ("suggestions are approximate; verify each match"). Already specified in §5.4. |
| **AB-6 absent** (`parent_packet_id`) | All packets treated as first-of-chain. Carry-forward (J2) is disabled with explanatory tooltip on the disabled control: "Re-capture chains require Phase 1 v0.1.1+ for parent_packet_id support." |
| **AB-9 absent** (re-capture detection in Phase 1) | Phase 2 implements re-capture detection itself by scanning for matching session_ids on packet open (suboptimal — race-prone — but functional). Documented as "Phase 2 fallback path; Phase 1 ownership preferred for performance and correctness." |
| **AB-10 absent** (fixture regen) | Phase 1 parity tests against fixtures fail; Phase 2 build CAN ship but a CI parity-gate flags the regression. Adds a release-note entry: "Fixtures last regenerated against v0.1.0; verify against current schema before shipping." |

This matrix unblocks Phase 2 from Phase 1 sequencing accidents. The product team picks the fallback when a MUST item slips; build does not stop. AB-9 fallback is the most expensive (race-prone re-capture detection in Phase 2); the others are straightforward UI degradations.

---

## §9 Architecture.md amendment proposals

These extend `docs/architecture.md` with B5 specifics. Recommendation: queue for B6 design review; apply post-review.

### 9.1 §Layer 2 / 2a Provenance store — schema sketch update

Replace the schema-sketch bullet list with a forward reference:

> **Schema (v0.1 solo OSS)**: see `docs/specs/phase-2-architecture-reconciliation.md` §7.1 for the full table definitions. Provenance + review state share the same local libSQL DB; the table set covers packets, claims, claim_evidence, approval_trail, redaction_audit, posted_to_pr_history, audit_log.

### 9.2 §Layer 2 / 2b Review state store — solo equivalent

Update the "Solo equivalent" line to reference the consolidated schema:

> **Solo equivalent**: solo OSS uses the same physical DB as the provenance store (`.trail/trail.db`) with one consolidated schema (per `docs/specs/phase-2-architecture-reconciliation.md` §7.1). The split into separate stores lands in v0.2+ commercial product (DOs).

### 9.3 New §Layer 2 / 2e — Atomic-write protocol

Add a new subsection:

> **Atomic-write protocol**: writes to packet artifacts use the saga pattern documented in `docs/specs/phase-2-architecture-reconciliation.md` §3. YAML is canonical (git-committed); libSQL is a derived index that can be rebuilt from YAML. Order: tmp-write → fsync → atomic-rename → libSQL update. On any failure, the canonical YAML state is preserved; libSQL drift is detected by content hash and rebuilt automatically.

### 9.4 New §Layer 3 / 3.1 — IPC contract

> **IPC contract**: the Rust↔React boundary uses a strict allowlist of typed commands documented in `docs/specs/phase-2-architecture-reconciliation.md` §6. Tauri's permission model is the security gate; no dynamic shell execution, no arbitrary HTTP, scoped filesystem access only.

### 9.5 New §Layer 3 / 3.2 — Filesystem watcher contract

> **Filesystem watcher**: the Tauri backend watches `.trail/sessions/` recursively for packet changes. Self-race avoidance uses a debounce + content-hash compare pattern (per `docs/specs/phase-2-architecture-reconciliation.md` §4). The hash compare doubles as the tamper-detection trigger for J12.

### 9.6 Repo structure update (Layer 2 line)

Update the proposed repo structure to reflect:
```
trail/
├─ apps/
│  ├─ ui/
│  │  ├─ src/
│  │  │  ├─ db/
│  │  │  │  ├─ schema.ts            # Drizzle schema (per §7)
│  │  │  │  └─ migrations/          # Migration files
│  │  │  └─ ipc/
│  │  │     └─ generated.ts          # Auto-gen from Rust types (per §6.4)
│  │  └─ src-tauri/
│  │     └─ src/
│  │        └─ ipc.rs                # Rust source-of-truth for IPC types
```

---

## §10 Cross-stage consistency check (B1 → B5)

| Concern | B1 | B2 | B3 | B4 | B5 | Status |
|---|---|---|---|---|---|---|
| Persona model (3) | ✓ | ✓ | ✓ | ✓ | (n/a) | Consistent |
| MLP must-haves (4) | ✓ | ✓ | (n/a) | ✓ | (n/a) | Consistent |
| Atomic-write contract | (referenced) | P2 spec | (n/a) | (deferred) | §3 locked | Resolved |
| Watcher self-race | (n/a) | OQ | (n/a) | (deferred) | §4 locked | Resolved |
| Re-capture model | AB-5 hint | OQ | (n/a) | (deferred) | §5 locked + Phase 1 amendments | Resolved |
| Risk encoding (color+glyph+label) | constraint | (n/a) | §4 locked | applied | (n/a) | Consistent |
| Three-layer override | story | flow | §4.4 visual | M1 modal | §7.1 schema | Consistent |
| Tamper detection | AU-AT-01 story | J12 flow | §6.8 banner | E6 banner | §4 + §7 hash mechanics | Resolved |
| Performance budgets | (n/a) | listed | (n/a) | per-screen | concrete in §3.4, §4.5 | Consistent |
| Tauri/webapp parity | OQ | (deferred) | §14 locked | applied | (deferred to v0.2+) | Consistent |
| Keyboard shortcuts | RV-UI-01 | references | catalog | full §9 + `?` overlay | (n/a) | Consistent |
| Dark mode default | OQ | (deferred) | §3 locked | applied | (settings-driven, §6.1) | Consistent |
| Single-window | (n/a) | (deferred) | (n/a) | OQ resolved | (consistent with IPC scope) | Consistent |
| AB feedback list | 5 items | 9 items | (n/a) | (n/a) | 10 items, 5 resolved | Tightened |

**Result**: B1–B5 consistency holds. No contradictions surfaced. AB-3 closed at the storage layer is the most significant tightening.

---

## §11 Provenance

| Source | Used for |
|---|---|
| `docs/architecture.md` v0.1 (define-phase) | Layer 2/3 baseline; locked decisions; tech stack |
| `docs/specs/phase-1-capture.md` v1.2 | Schema fields available; atomic-write requirements; redaction metadata; cross-checked with §5 amendment proposals |
| `docs/specs/phase-2-ui-stories.md` (B1) | Story coverage; AB-1..AB-5 origins |
| `docs/specs/phase-2-ui-flows.md` (B2) | Flow primitives (P1-P4); OQ-B5-* scope; AB-1a, AB-6, AB-7, AB-8 origins |
| `docs/specs/phase-2-design-system.md` (B3) | Token/component vocabulary referenced by IPC events |
| `docs/specs/phase-2-screen-specs.md` (B4) | Component-to-storage mapping (§2.2) driving §7 schema |
| `schema/pr-change-packet.v0.1.1.yml` | Schema field availability for Phase 1 amendment proposals |
| `.claude/canvas/scenarios.yml` scn-001..007 | Concrete scenarios that storage architecture must serve |

---

**End of B5.**

Next: **B6 (design review across B1–B5)** — multi-lens review of the full UI spec stack; expected to surface refinements analogous to A4-A4.9 cycle but at lower volume given fewer existing artifacts to ground against. Then **B7 (/preflight Phase 2)** declares Phase 2 success criteria + GO. The AB stage (#41) can run in parallel with B6 since the AB list is now stable (10 items, all with resolution paths).
