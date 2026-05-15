# Phase 2 AB-stage resolution (2026-05-09)

**Stage**: AB (UX-driven schema gap reconciliation; Phase 2 → Phase 1 backflow)
**Date**: 2026-05-09
**Authoritative companion**: `docs/specs/phase-2-architecture-reconciliation.md` §8 (the source AB-list table)
**Affects**: `schema/pr-change-packet.v0.1.1.yml` (additive amendments), `docs/specs/phase-1-capture.md` (§X new section + threaded amendments to §1, §3, §5, §6, §10, §10.1, §11)
**Does NOT affect**: `py-reference/` (A6 task), libSQL schema (Phase 2 build), `docs/architecture.md` amendments (queued for B6)

---

## §1 Purpose

Phase 1 (capture pipeline, TS port of py-reference) is gated on a list of **AB feedback items** surfaced during Phase 2 UI specification (B1–B5 stages). Phase 2 cannot build the review screens (J3 review, J4 redaction preview, P1 open saga, P2 decision saga, P3 PR-post saga) without specific shapes in the canonical packet schema and specific behaviors in the capture pipeline.

The AB list stabilized at **10 items** at end-of-B5 (`docs/specs/phase-2-architecture-reconciliation.md` §8). This stage applies them to the canonical artifacts.

The AB-stage is **additive**: schema bumps remain at v0.1.1 (no breaking change); spec amendments thread in around existing post-A4.9 markers without overwriting prior decisions.

---

## §2 The 10 AB items — status table

| ID | Severity | Status post-AB-stage | Surface(s) changed |
|---|---|---|---|
| AB-1 | SHOULD | **RESOLVED** in v0.1.1 schema (additive) | `schema/pr-change-packet.v0.1.1.yml` (`claims[].risk_classification.creator_override`) |
| AB-1a | SHOULD | **RESOLVED** in v0.1.1 schema (additive) | `schema/pr-change-packet.v0.1.1.yml` (`claims[].risk_classification.reviewer_override`) |
| AB-2 | SHOULD | **RESOLVED** in v0.1.1 schema (additive) | `schema/pr-change-packet.v0.1.1.yml` (top-level `posted_to_pr[]` array) |
| AB-3 | MUST | **DOCUMENTED as closed elsewhere** (libSQL `packets.last_known_hash`) | `phase-1-capture.md` §X.9 (no schema change); validation-rules block |
| AB-4 | MUST | **RESOLVED** in v0.1.1 schema (additive) | `schema/pr-change-packet.v0.1.1.yml` (top-level `approval_trail[]` array) |
| AB-5 | MUST | **RESOLVED** in v0.1.1 schema + spec amendment | schema (`claims[].stable_id`) + `phase-1-capture.md` §6 + §X.3 |
| AB-6 | MUST | **RESOLVED** in v0.1.1 schema (additive) | schema (`_meta.parent_packet_id`) + `phase-1-capture.md` §X.2 |
| AB-7 | OPTIONAL | **DOCUMENTED as opt-in** | `phase-1-capture.md` §5 (Layer 1 in-memory redaction-preview cache subsection) |
| AB-8 | SHOULD | **RESOLVED** in v0.1.1 schema (additive) | `schema/pr-change-packet.v0.1.1.yml` (top-level `redaction_audit.entries[]`) |
| AB-9 | MUST | **RESOLVED** via spec amendment | `phase-1-capture.md` §3 step 9a (NEW) + §1 + §10 + §X.1 |
| AB-10 | MUST | **RESOLVED** via spec amendment | `phase-1-capture.md` §10 / §10.1 (versioned fixture paths) + §X.10 |

**Tally**:
- 10 of 10 resolved.
- 8 via additive schema field additions.
- 4 via spec amendments to `phase-1-capture.md`.
- 1 closed without schema change (AB-3 — moved to libSQL).
- 1 documented as opt-in non-requirement (AB-7).

No item escalated to P1 for B6.

---

## §3 Schema diff summary

`schema/pr-change-packet.v0.1.1.yml` remains at packet_version `0.1.1` (all changes additive). Field additions:

### 3.1 `_meta` block
- **NEW**: `parent_packet_id` (string | null) — AB-6.

### 3.2 `summary.claims[*]` block
- **NEW**: `stable_id` (16-char lowercase hex; required when stable id derivation lands per AB-5).
- **NEW**: `risk_classification` block with three sub-blocks (each fields nullable):
  - `agent.{level, rationale}` — Phase 1 emits null block; full classification deferred to v0.2.
  - `creator_override.{level, reason, at, by}` — AB-1.
  - `reviewer_override.{level, reason, at, by}` — AB-1a.

### 3.3 Top-level (NEW)
- **NEW**: `approval_trail[]` — array of `{ claim_id, decision, reason, by, at }`. AB-4. Phase 1 emits `[]`.
- **NEW**: `posted_to_pr[]` — array of `{ pr_url, pr_number, body_hash, posted_at, posted_by }`. AB-2. Phase 1 emits `[]`.
- **NEW**: `redaction_audit.{pattern_set_version, entries[]}` — entries array of `{ pattern_id, layer, count, locations_summary }`. AB-8. Phase 1 populates from singleton pattern set (per A4.7 R-SEC-2).

### 3.4 Validation rules added
- `_meta.parent_packet_id` MUST be string-or-null; ULID when non-null.
- `claims[].stable_id` MUST be 16-char lowercase hex.
- `claims[].risk_classification.*.level` MUST be ∈ {null, "low", "med", "high", "crit"}.
- When any override `level` is non-null, `reason / at / by` MUST also be non-null.
- `approval_trail[].decision` MUST be ∈ {"accept", "changes", "block", "reject"}.
- `approval_trail[].claim_id` MUST resolve to a claim in this packet.
- `approval_trail` entries chronological; `at` ISO 8601 with `+00:00` suffix.
- `posted_to_pr[].body_hash` 64-char lowercase hex; `posted_at` ISO 8601.
- `redaction_audit.entries[].layer` ∈ {1, 2, 3}; entries sorted by `(pattern_id, layer)`.
- Cross-check: sum of `redaction_audit.entries[].count` for `layer == 1` MUST equal `agent_session.redaction_metadata.redactions_applied`.
- Tamper-detection field is explicitly NOT present (AB-3 closed at libSQL layer).

---

## §4 Phase 1 spec diff summary (`phase-1-capture.md`)

Sections amended (all additive; no overwrites of post-A4.9 amendment markers):

| Section | Change |
|---|---|
| §1 (Goals) | Persistence path now `packet-<N>.yml` / `packet-<N>.md` (versioned per AB-9 / AB-10). |
| §3 step 9a (NEW) | Re-capture detection algorithm: scan for prior `packet-N.yml`, compute `next_n`, populate `_meta.parent_packet_id`. AB-9. |
| §3 step 10f, 10g, 10h | Atomic-write paths now versioned (`packet-<N>.yml` / `packet-<N>.md` instead of unversioned `packet.yml` / `packet.md`). AB-9. |
| §3 step 11 | Summary line shows `packet-<N>` and full versioned path. |
| §5 (Redaction contract) | NEW subsection "Layer 1 in-memory redaction-preview cache" documenting AB-7 opt-in contract. |
| §6 (Claim synthesis) | NEW Universal-rule bullet specifying `stable_id` algorithm (sha256 → 16 hex chars). AB-5. |
| §10 (Parity oracle) | Fixture paths now `py-reference/fixtures/sessions/<session-id>/packet-1.yml`. AB-10. |
| §10.1 (Backports) | Items 5/6 retargeted to `packet-1-perdiff.yml` / `packet-1.md`; new items 8/9/10 cover AB-9 re-capture logic, AB-10 versioned fixture layout, AB-5 stable_id derivation. |
| §11 (Schema tensions — closed) | AB resolutions added: per-claim risk overrides, approval_trail array, parent_packet_id, posted_to_pr array, redaction breakdown, claim id stability, tamper detection at libSQL. |
| §X (NEW; AB-stage amendments) | Consolidated section before Appendix A. Per-AB rationale, algorithms, scope, dependencies. Cross-references back to threaded amendments above. |

---

## §5 What was NOT done (deliberately out of scope)

These are explicitly out of AB-stage scope per the original task framing:

- **py-reference modifications** — A6 task. py-reference will need backports for AB-5 (stable_id derivation), AB-9 (re-capture detection), and AB-10 (versioned fixture output). The Phase 1 spec §10.1 documents these as backport requirements; A6 implements.
- **A7 fixture regeneration** — A7 task. Fixtures move to versioned subdirectory (`py-reference/fixtures/sessions/<session-id>/packet-1.yml`) per AB-10; legacy flat fixtures (`canonical-session.yml`) deleted in same commit. AB-stage only documents the requirement; A7 executes.
- **libSQL schema implementation** — Phase 2 build (#22) task. AB-stage references the libSQL schema (B5 §7.1) but does not modify it.
- **Tauri IPC handlers** — Phase 2 build task. AB-7's `preview_redacted` IPC contract is documented in §5 spec amendment but not implemented.
- **`docs/architecture.md` amendments** — queued for B6 design review per B5 §9. AB-stage does not touch architecture.md.

---

## §6 Items that couldn't be resolved cleanly (for B6 escalation)

**None.**

All 10 AB items closed with clear resolution paths. AB-3 is the only "non-resolution" — and it's a clean documentation closure, not a punt: tamper detection lives at the libSQL layer (`packets.last_known_hash`) per B5 §3.3, NOT in the packet schema. This was confirmed by the architecture reconciliation (B5 §8) and is now documented in `phase-1-capture.md` §X.9 + the schema validation rules block.

If B6 design review wants tamper-detection ALSO mirrored in the YAML (defense-in-depth), that would be a v0.1.2 schema bump, separately scoped. For v0.1.1, the libSQL-only resolution is sufficient.

---

## §7 Phase 1 build (#21) dependency status

The 5 MUST items minus AB-3 (closed elsewhere) = AB-4, AB-5, AB-6, AB-9. (AB-10 blocks A7 fixture regen, NOT #21 capture impl directly.)

| Item | Phase 1 #21 obligation |
|---|---|
| AB-4 | Emit `approval_trail: []` (empty array) on every capture. Schema accepts non-empty arrays for Phase 2 use. |
| AB-5 | Compute `claims[].stable_id` per the locked sha256 algorithm; emit on every claim. |
| AB-6 | Populate `_meta.parent_packet_id` per re-capture detection logic (null on first capture; prior packet's ULID otherwise). |
| AB-9 | Implement re-capture detection in §3 step 9a. Output path is `packet-<N>.yml` (no more unversioned `packet.yml`). |

**Phase 1 build is unblocked**: all 4 obligations are well-specified, additive, and have locked algorithms. No further AB negotiation needed before #21 starts.

A6 (py-reference backports) inherits the same 4 obligations + AB-10 (fixture layout).
A7 (fixture regeneration) inherits AB-10 + emits a regen of `packet-1.yml` etc. from the canonical session.

---

## §8 Validation performed

- **Schema YAML**: parsed via `python3 -c "import yaml; yaml.safe_load(open(...))"` — valid YAML, all top-level keys present (`packet_version`, `_meta`, `pr`, `task_intent`, `agent_session`, `diff_summary`, `commands_run`, `test_evidence`, `provenance`, `summary`, `approval_trail`, `posted_to_pr`, `redaction_audit`).
- **`_meta.parent_packet_id`** present and exemplified.
- **`approval_trail`** and **`posted_to_pr`** at top level, both default `[]`.
- **`redaction_audit`** at top level with `pattern_set_version` and `entries[]` sub-fields.
- **Phase 1 spec**: amendments threaded into existing sections; new §X added before Appendix A. No post-A4.9 markers overwritten.

Out of AB-stage scope: pytest runs, TS build, parity tests. Those are A6/A7/#21 territory.

---

## §9 Provenance

- Stage: AB (UX-driven schema gap reconciliation; #41).
- Date: 2026-05-09.
- Predecessor stages: B1 (stories), B2 (flows), B3 (design system), B4 (screen specs), B5 (architecture reconciliation — source of AB list).
- Successor tasks: A6 (py-reference backports), A7 (fixture regen), #21 (Phase 1 build), #22 (Phase 2 build).
- Decision log: this file + amendments threaded into `docs/specs/phase-1-capture.md` + `schema/pr-change-packet.v0.1.1.yml`.
- Trail product identity preserved (Trail = product, Mycelium = framework).
