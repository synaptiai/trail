# Trail

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![v0.1.0](https://img.shields.io/badge/v0.1.0-in_progress-orange.svg)](https://github.com/synaptiai/trail/issues/5)
[![Schema: v0.1.1](https://img.shields.io/badge/schema-v0.1.1-green.svg)](schema/pr-change-packet.v0.1.1.schema.json)

AI-native change-control. Trail captures every AI-assisted code change as a
structured, reviewable, auditable packet on top of Git/GitHub — making AI work
auditable without forcing humans to read full agent transcripts.

> **v0.1.0 status.** v0.1 is at L3 develop→complete (per `/diamond-progress`).
> Phases 1, 2, 3a, 3b are merged. Phase 4 (this PR) ships installers + npm
> packages + release CI. The quickstart below describes the end-state once
> v0.1.0 is tagged. Workspace-installed flow (Section 2 below) works today.

## What Trail does

When you run an AI assistant (Claude Code, Cursor, Codex, …) against a
repository, Trail produces a **PR Change Packet**: a YAML artefact with
risk-classified claims that each trace back to evidence (diff hunks, test
output, command logs, issue text). The packet posts to the PR body via
`gh` so reviewers — and your future self — can approve a structured
summary instead of reading the full transcript.

The four MLP capabilities that gate v0.1.0 (per `opp-001`):

1. **Risk classification** — every claim carries `low|medium|high|critical`
   with rationale.
2. **Approval trail** — per-claim accept/override decisions with timestamp +
   identity.
3. **Interactive review UI** — Tauri 2.x desktop app (Creator / Reviewer /
   Auditor personas).
4. **GitHub integration** — `trail packet post` posts the packet to the PR
   via `gh` CLI.

## 30-second quickstart (post-v0.1.0)

```bash
# 1. Install the desktop app + CLIs.
#    macOS:    download Trail.dmg from the v0.1.0 GitHub Release, drag to
#              /Applications. (Un-signed v0.1.0: Right-click → Open the
#              first time to bypass Gatekeeper. Signing arrives in v0.1.x.)
#    Linux:    download Trail.AppImage or trail.deb; chmod +x; run.
#    Windows:  download Trail.msi; install. (Un-signed v0.1.0: SmartScreen
#              "More info → Run anyway" the first time.)
#    CLI only: npm install -g @synapti/trail-capture @synapti/trail-audit
gh release download v0.1.0 --repo synaptiai/trail
npm install -g @synapti/trail-capture @synapti/trail-audit

# 2. Generate your first packet from a Claude Code session.
cd <your-project>
trail packet generate <session-id>          # writes .trail/sessions/<id>/packet.yml

# 3. Open the packet for review.
open .trail/sessions/<session-id>/packet.yml   # or use the Trail desktop app

# 4. Post the rendered markdown to the PR (uses gh CLI; requires `gh auth login`).
trail packet post --packet .trail/sessions/<session-id>/packet.yml --pr <number>

# 5. Record per-claim decisions (Reviewer / Auditor persona).
#    --decision is one of: accept | changes | block | reject.
trail packet decide \
  --packet .trail/sessions/<session-id>/packet.yml \
  --claim <claim-id> \
  --decision accept
```

Find your `session-id`: `trail packet list` reads
`~/.config/claude/projects/<repo-hash>/*.jsonl` and shows recent sessions.

## What's in this repo

| Path | What it is |
|---|---|
| [`schema/pr-change-packet.v0.1.1.schema.json`](schema/) | The protocol: PR Change Packet JSON Schema v0.1.1. Apache-2.0. |
| [`docs/architecture.md`](docs/architecture.md) | v0.1 architecture: 4-layer model (Capture / Storage / UI / Sync), Tauri 2.x + React + libSQL. |
| [`docs/specs/`](docs/specs/) | Per-phase specs: phase-1-capture.md, phase-2-screen-specs.md, etc. |
| [`apps/capture`](apps/capture) | `@synapti/trail-capture` — Layer 1, the post-hoc capture CLI (TS port of `py-reference/cli/trail.py`). |
| [`apps/audit`](apps/audit) | `@synapti/trail-audit` — Layer 3, the pre-commit secrets-redaction audit CLI. |
| [`apps/ui`](apps/ui) | Trail desktop app (Tauri 2.x + React + libSQL). |
| [`bin/trail-redaction-patterns.yml`](bin/trail-redaction-patterns.yml) | Default redaction pattern set (consumed by capture + audit). |
| [`py-reference/`](py-reference/) | Python reference implementation — preserved as the executable spec for the TS port. |
| [`CHANGELOG.md`](CHANGELOG.md) | Per-version what shipped, what deferred. |

## Workspace install (developers, today)

```bash
git clone https://github.com/synaptiai/trail
cd trail
pnpm install                                   # installs all workspaces
pnpm --filter @synapti/trail-capture build             # builds capture CLI
pnpm --filter @synapti/trail-audit build               # builds audit CLI
pnpm --filter @trail/ui tauri:dev              # boots desktop app in dev
```

## Three-layer redaction

Trail enforces secrets-redaction at three layers (the F5 design from
`docs/specs/redaction-design.md`):

- **Layer 1 — capture-time:** `redaction/layer1.ts` scans prompts,
  command lines, stdout summaries, and test refs against
  `bin/trail-redaction-patterns.yml` and replaces with
  `[REDACTED:<name>]` before any value crosses the packet boundary.
  Diff excerpts are clipped (not pattern-redacted) at this layer; Layer 2
  is the byte-level safety net for diff content.
- **Layer 2 — write-time:** byte-level scan over the serialized YAML
  *after* dump. Catches anything that leaked through Layer 1
  serialization. Surfaces as `sha256(match)[:8]` for audit without
  re-leaking the secret.
- **Layer 3 — pre-commit:** `@synapti/trail-audit` re-scans staged `.trail/`
  packets via a pre-commit hook. Belt-and-suspenders against operator
  error or new-pattern drift.

`bin/secrets-scan.mjs` (consumed by CI workflows) self-tests every
catalog pattern against planted fixtures before scanning the diff.

## License

The protocol (`schema/`) and all v0.1.0 code are Apache-2.0. See
[`LICENSE`](LICENSE) for the canonical text and per-package licenses
under `apps/{capture,audit,ui}/LICENSE`. Bundled fonts ship with their
upstream OFL-1.1 license files in `apps/ui/public/fonts/` per OFL §3.

The open-core product license posture is decided per layer at L4 release
(post-v0.1.0).

## Status & build

v0.1.0 ships when issue [#5](https://github.com/synaptiai/trail/issues/5)
closes. The acceptance test (`trail packet generate` → `trail packet
post` against a real PR) IS the dogfood validation. Track the L3 diamond
in `.claude/diamonds/active.yml#l3-mvp-packet-pipeline` (already
`complete` per `/diamond-progress`) and follow-up work in the v0.2
milestone.

## Contributing

This is a solo founder project at v0.1; external contributions are not
yet accepted. File issues for bug reports + suggestions. The roadmap and
design canvas are public under `.claude/canvas/`.
