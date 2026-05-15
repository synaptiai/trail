# Changelog

All notable changes to Trail are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-rc.2] — 2026-05-15

Second release candidate. Re-publish of rc.1 after a partial-publish: the
release.yml propagation poll timed out at 5 minutes during rc.1 because
npm CDN took longer than expected to surface `@synapti/trail-capture@0.1.0-rc.1`.
Capture published successfully; audit publish was skipped (gated on the
poll). Recovery: deprecate rc.1 of capture, cut rc.2 with both packages
publishing in lockstep. Workflow change: propagation poll extended from
5 min to 15 min (30 attempts × 30s) to absorb npm CDN tail latencies.

Same substance as rc.1 otherwise. See rc.1 entry below for the full
release-candidate framing.

## [0.1.0-rc.1] — 2026-05-15 (deprecated; use rc.2)

First release candidate of the OSS MLP. **Partial-published**:
`@synapti/trail-capture@0.1.0-rc.1` is on npm; `@synapti/trail-audit@0.1.0-rc.1`
is not. Deprecated via `npm deprecate` post-rc.2. Use 0.1.0-rc.2 instead.

Published to npm under the `next`
dist-tag (not `latest`) so `npm i @synapti/trail-capture` continues to no-op until
the acceptance test on a real dogfood repo (gh#5 AC#9) passes and the tag
is promoted via `npm dist-tag add @synapti/trail-capture@0.1.0 latest`. Tauri
installers ship the same `0.1.0-rc.1` binary via GitHub Release. Substance
of the release is identical to 0.1.0 below — the `-rc.1` suffix exists to
keep the publish pipeline reversible while the dogfood loop runs.

## [0.1.0] — 2026-05-XX (in progress)

The OSS MLP. v0.1.0 ships the four MLP must-haves named by external
respondents (per `opp-001`, `ht-002` panel n=11) as gating for actual use,
plus enough installation polish to be usable by someone other than the
founder.

### Added — capture (Layer 1)

1. **Post-hoc capture** — `@synapti/trail-capture` reads a Claude Code session
   transcript (`~/.config/claude/projects/<repo-hash>/<session>.jsonl`),
   walks tool-results inline (no separate FS lookups), aggregates into a
   `pr-change-packet.v0.1.1` artefact. TS port of `py-reference/cli/trail.py`
   with byte-parity oracle (`docs/specs/phase-1-capture.md` §10).
2. **Dual-render** — agent-handoff YAML (machine) plus human markdown
   with claims rendered alongside actual diff hunks (Mermaid + Shiki).
   Closes the F1 Part B "skim-fatigue" finding from the define phase.
3. **Three-layer redaction**:
   - Layer 1 capture-time pattern scan (`bin/trail-redaction-patterns.yml`,
     ReDoS-guarded via `safe-regex`, 64 KiB cap).
   - Layer 2 write-time scan over serialised YAML bytes (sha256[:8]
     audit snippet without re-leaking the secret).
   - Layer 3 pre-commit audit via `@synapti/trail-audit` over staged `.trail/`
     paths. Self-tests every catalog pattern against planted fixtures
     before scanning the diff (`bin/secrets-scan.mjs --self-test`).
4. **PR-body posting** — `trail packet post <session> --pr <n>` shells
   to `gh` CLI to attach the markdown render to the PR body. Persona-
   gated (Reviewer/Auditor); idempotent via marker comments.
5. **Risk classification** — every claim carries `low|medium|high|
   critical` with rationale. Aligns to the F25 character-identity
   discipline shipped in PR #21.
6. **Approval trail** — per-claim `accept|override` decisions with
   identity + timestamp, persisted under `.trail/sessions/<id>/decisions/`
   via the saga + intent-log pattern.
7. **Interactive review UI** — Tauri 2.x + React + libSQL desktop app
   with three personas (Creator / Reviewer / Auditor). 14 typed IPCs
   pinned via `ts-rs` + `tauri-specta`. 5 IPCs persona-gated against
   Auditor (post / decide / save_decision / override_risk / write_settings).
   `capabilities_negative.rs` enforces a closed-set permission discipline
   (no FS write outside `.trail/`, no shell:execute beyond `gh`, no
   shell:open beyond declared schemes).
8. **GitHub integration** — `trail packet post` + `trail packet decide`
   end-to-end against a real PR; tested in PR #20 (gh#12) closure.
9. **Install & distribution**:
   - `@synapti/trail-capture` + `@synapti/trail-audit` published to npm under the
     `@synapti` scope. `npm install -g @synapti/trail-capture` puts `trail`
     on `$PATH`.
   - Tauri installers attached to the v0.1.0 GitHub Release for
     macOS arm64 + x64 (`.dmg`), Linux x64 (`.deb`, `.AppImage`), and
     Windows x64 (`.msi`).
   - `.github/workflows/release.yml` triggers on tag `v*.*.*`: builds,
     publishes to npm, attaches installers to the Release.

### Added — schema + protocol

- `schema/pr-change-packet.v0.1.1.schema.json` — JSON Schema for the
  PR Change Packet. Apache-2.0; consumable independent of the Trail
  CLI / app.
- `bin/trail-redaction-patterns.yml` — canonical redaction pattern
  set. Synced into `apps/capture/bin/` at build time (single source of
  truth — F19 fix, PR #7).

### Added — quality gates

- `.github/workflows/ui-quality-gates.yml`: TypeScript typecheck +
  ESLint + Vitest (incl. `jest-axe` a11y scans) + Vite build + Rust
  `cargo check --locked` + `cargo test --locked` + secrets-scan with
  self-test (added during PR #6 cycle-1 review F10/N15).
- `.github/workflows/validate.yml`: Mycelium framework structural
  integrity (Python coverage + canvas schema validation).
- `.github/workflows/dogfood.yml`: scenario regression battery on PR
  for `.claude/**` framework changes.
- 490+ Vitest cases (apps/ui) and 168+ Rust cargo tests at v0.1.0
  closure (up from 73 / 50 at Phase 2 Sprint 1 entry).

### Added — distribution + licensing

- Apache-2.0 LICENSE at repo root and per-package LICENSE files in
  `apps/{capture,audit,ui}/LICENSE`.
- Bundled font: Newsreader (variable, opsz + wght) WOFF2 vendored
  with upstream OFL-1.1 license file (`apps/ui/public/fonts/
  Newsreader-OFL.txt`) per OFL §3.

### Security

- happy-dom 15→20.8.9 (CVE-bumped during Sprint 6).
- drizzle-orm 0.36→0.45.2 (CVE-bumped during Sprint 2).
- esbuild ≥0.25.0 enforced via `pnpm.overrides` (CVE-bumped).
- `cargo audit` in CI for the Tauri shell.
- Persona enum closes the unknown-string deserialise boundary at the
  Rust IPC handler.
- `is_argv_safe` predicate rejects empty / oversize / dash-prefix /
  control-character `gh` arguments before subprocess spawn.
- npm provenance enabled on `@synapti/trail-capture` + `@synapti/trail-audit` publishes
  via `publishConfig.provenance: true` and `--provenance` flag, with
  `permissions: id-token: write` on the release workflow.
- Tauri CSP hardened with `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'`, `frame-ancestors 'none'`.
- `apps/ui/scripts/font-integrity-update.mjs` clamps manifest paths
  inside `public/fonts/` (path-traversal guard) and rejects symlinks.
- Release workflow pins all third-party Actions to commit SHAs (no
  floating tag/branch refs).

### Known limitations / explicit "out of scope" for v0.1.0

- **macOS code signing + notarisation**: v0.1.0 ships un-signed.
  Documented "Right-click → Open" workaround in the README.
  Notarisation via Apple Developer ID lands in v0.1.x once enrolment
  completes.
- **Windows code signing**: v0.1.0 ships un-signed. Documented
  SmartScreen "More info → Run anyway" workaround in the README.
  Code signing lands in v0.1.x once a cert is procured.
- **Public Sans + Commit Mono fonts**: deferred to v0.1.x. Upstream
  sources do not publish pre-built variable WOFF2 matching the
  manifest declarations; CSS fallback chain (Public Sans →
  `system-ui`; Commit Mono → JetBrains Mono / Menlo) handles them
  gracefully meanwhile.
- **Runtime font-integrity verifier** (`apps/ui/src/design/
  font-integrity.ts`, B3 §15.1): the static manifest hashes serve as
  audit reference; the runtime SHA-256 verifier lands in v0.1.x.
- **Auto-update mechanism**: deferred to v0.2.
- **Telemetry / opt-in error reporting**: deferred to v0.2.
- **Live-hook capture, Cursor / Codex / Aider support**: deferred to
  v0.2 (see opp-001 §"What v0.2 DOES include").
- **Multi-language packaging**: deferred to v0.2+.
- **Self-hosted / Docker enterprise variant**: out of scope; tracked
  as opp-006 (Phase 5+ commercial).

### Cumulative engineering investment

Trail v0.1 is the result of:

- **6 Phase 2 sprints** (gh#2, #8, #9, #10, #11, #12, #13) — Tauri UI
  build-out from scaffold through closure polish.
- **Phase 1** (gh#1) — capture CLI TS port.
- **Phase 3a** (gh#3) — audit CLI TS port.
- **Phase 3b** (gh#4) — `gh` CLI integration + PR-body posting.
- **Phase 4** (gh#5, this release) — installers + npm + release CI.
- **~75 review-cycle findings** addressed across PR #6, #14, #15, #16,
  #17, #18, #19, #20, #21 via paired skeptic+verifier protocol.
- **L3 diamond `l3-mvp-packet-pipeline`**: define→develop→deliver→
  complete per `/diamond-progress` 2026-05-10 (12 theory gates pass;
  BVSSH quick-check all five answered).

[0.1.0]: https://github.com/synaptiai/trail/releases/tag/v0.1.0
