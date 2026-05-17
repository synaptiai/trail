# Changelog

All notable changes to Trail are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-05-16

First patch release after the v0.1.0 OSS MLP. The 0.1.0 desktop shell
was non-functional on install (every Tauri IPC failed with `missing
required key args`); 0.1.1 closes that ship-blocker and ships hardening
across the entire desktop surface uncovered by a comprehensive review
pass (security + code + test-methodology agents in parallel).

### Fixed — P0 ship-blocker

- **IPC wrapper-args mismatch (commit 9f3c2f0)**. Every `#[tauri::command]`
  has `args: Struct` parameter shape; Tauri 2's serde resolver expects
  the JS payload to be `{ args: ... }`. The IPC client at
  `apps/ui/src/ipc/client.ts:123` was passing `parsed.data` directly,
  producing `invalid args 'args' for command X: missing required key
  args` at runtime for every IPC call. Fixed by wrapping the payload
  as `{ args: parsed.data }`.

### Added — regression infrastructure

- **Production-runtime IPC dispatch smoke** (`apps/ui/src-tauri/tests/
  ipc_dispatch_smoke.rs`, commit 33a599c). Boots `tauri::test::
  mock_builder()` against the production handler set and dispatches
  every IPC with a schema-valid `{ args: ... }` payload through the
  real serde resolver. Includes a regression canary that sends a flat
  envelope and asserts the v0.1.0 error verbatim. 15 new tests + 167
  inline tests from pulled modules.
- **Strict-wrap test mock assertions**. The three direct-bridge mocks
  (`gh-post`, `M4PostToPrModal`, `M6SettingsModal-cli-bridge`) now
  throw on missing `args` wrapper instead of the v0.1.1 stop-gap
  `?? args` fallback. The Rust IPC smoke is the canonical pin; these
  are the second-tier net.
- **Playwright e2e job in CI** (`.github/workflows/ui-quality-gates.yml`).
  Browser-mode Playwright was passing locally but never CI-gated.
  Now runs after `ts-quality` against the production vite preview
  bundle.

### Fixed — security hardening

- **XSS via subprocess stderr `pr_url`** (commit 1c97de1). A compromised
  capture binary (settings-set `capture_cli_path`) or PATH hijack could
  emit `posted packet to javascript:fetch(...)` and one click on the
  post-success toast would execute script in the webview (the CSP at
  `tauri.conf.json` does NOT block `javascript:` hrefs in same-origin
  webviews). Closed at three layers: anchored Rust regex in
  `cli_bridge.rs::parse_post_outcome` and `parse_decide_outcome`;
  Zod regex on `postToPrResponseSchema.pr_url` and
  `decideOnPrResponseSchema.pr_url`; defensive `https://github.com/`
  prefix check in `PacketView.tsx`. 9 new Rust regression tests.
- **YAML safety gate at all parse sites**. Saga read path already had
  `yaml_safety::guard()`; cold paths (boot recovery, patterns load,
  watcher external-edit) did not. A hostile YAML in any cwd-ancestor
  (`bin/trail-redaction-patterns.yml`) could OOM the desktop via
  anchor-bomb. Extracted `yaml_safety::guard(text)` helper and applied
  at all 4 parse sites.
- **`settings.json` size cap** — `SETTINGS_MAX_BYTES = 64KB` in
  `settings::read_settings`. A 1GB-corrupted/malicious settings file
  would otherwise load entirely into memory at boot.
- **`read_packet` absolute-path reject** — `apps/ui/src-tauri/src/
  ipc.rs:read_packet` previously only rejected `..` traversal in
  `yaml_path`. Absolute paths (`/etc/passwd`) are now rejected too.
  Defensive close against future capture-side INSERTs that haven't
  landed yet but are coming in v0.1.x.

### Fixed — desktop refactor (commit 3825840)

- **Watcher dead-code-on-the-hot-path consolidation**. `watcher.rs::
  evaluate_change` was fully tested but never called; `main.rs`
  reimplemented the same classifier inline with two latent bugs:
  - **B6.1**: non-NotFound `fs::read_to_string` errors (EACCES, EIO)
    were silently dropped (`warn! + continue`). Now flow through
    `ReadError::Other` → `WatcherDecision::ParseError` and emit
    `packet-changed-externally` with `mismatch_type: 'parse-error'`.
  - **B6.2**: when `_meta.packet_id` couldn't be resolved from libSQL
    (fresh packet not yet INSERTed), the event was emitted with
    `packet_id: ''`. Wire shape is now `Option<String>` (`null` when
    unresolved); the React filter switches on null at the type level.
- Dropped `#[allow(dead_code)]` on `WatcherDecision`, `MismatchKind`,
  `evaluate_change`, `ReadError`, `is_packet_yaml`,
  `parse_packet_id_from_yaml_path` — all now reachable from production.
- 2 new B6 regression tests + 15 total watcher tests passing.

### Fixed — audit-mode

- **Per-event audit-log persona gating**. `audit_log_append` previously
  rejected ALL auditor calls, but auditor IS the legitimate user of
  `tamper_dismissed` / `tamper_re_verified` events (audit mode reviews
  frozen trees and dismissals must be recorded). Refactored to
  per-event-type gating: only `settings_changed_via_ui` rejects
  auditor (the original W2 threat).

### Changed — release pipeline

- **Auto-deprecation polish**. The skip-if-already-deprecated check
  in `release.yml` is removed. Re-deprecates idempotently with the
  current message so prereleases stop carrying stale "Superseded by
  <older-rc>" messages.

### Deferred to v0.1.2

- macOS code-signing + notarisation (Apple Developer Program enrolment
  required). v0.1.1 ships unsigned with the `xattr -dr com.apple.
  quarantine` workaround documented in release notes.
- `seed_stress_packets` release-binary symbol audit + auditor reject.
- Auditor `pinned_sessions`-only write allowance.
- `apps/capture` CI workflow (#75).
- High-entropy regex SHA exclusion (#77).
- Canonical fixture regeneration with Layer 1 active (#78).
- DF-S6 full fix (custom js-yaml schema or py-reference stringify).
- `#[allow(dead_code)]` audit in `ipc.rs`.

### Test surface delta

- @trail/ui: 508 / 508 (no net change; mocks tightened).
- @synapti/trail-capture: 329 passed | 3 skipped (no net change).
- @synapti/trail-audit: 77 / 77 (no net change).
- trail-ui (Rust): 174 → **356** (+15 IPC dispatch smoke + 167 inline tests via `#[path]`, +2 B6 watcher regressions, +9 B1 url-shape regressions, +3 B5 audit-event-gating).

Acceptance gate for v0.1.1 — the same `npm install -g @synapti/trail-
capture && trail packet generate → post → decide → review in desktop`
loop that v0.1.0 botched at the desktop step.

## [0.1.0-rc.7] — 2026-05-15

Seventh release candidate. Substance is identical to rc.6 — same fixes,
same surface. rc.7 exists to **exercise a new release-pipeline step**:
auto-deprecation of superseded prereleases.

### Added — release pipeline

- `.github/workflows/release.yml` now includes a "Deprecate superseded
  prereleases" step after npm publish. For each prior prerelease
  matching the just-published version's major.minor.patch family, it
  runs `npm deprecate` with a message pointing to the new version.
  Uses the same Automation NPM_TOKEN that already publishes; no
  interactive 2FA required.

  Replaces the hand-cranked `for v in rc.1..rc.N-1; npm deprecate ...`
  loop that was a release-procedure smell across rc.1 → rc.6.
  Idempotent: already-deprecated versions are skipped on re-runs.

- A second step, "Align dist-tags on stable publish", runs **only**
  when shipping a non-prerelease version. `npm publish --tag latest`
  moves `latest` automatically; this step also moves `next` to point
  at stable so `@pkg@next` doesn't keep returning a superseded
  prerelease after stable lands. (Prerelease publishes leave `latest`
  alone — npm convention.)

### Validated against the rc.1-rc.6 backlog

Publishing rc.7 exercises the new step against 11 un-deprecated
prereleases:

- `@synapti/trail-capture@0.1.0-rc.{1..6}` (six versions)
- `@synapti/trail-audit@0.1.0-rc.{2..6}` (five versions; rc.1 was
  never published due to the partial-publish failure documented in
  the rc.2 entry below)

All eleven should land with the standardised "Superseded by
0.1.0-rc.7. Use @next (or @latest after stable ships)." message
after the rc.7 npm publish succeeds.

### No code changes

CLI behaviour, schema, redaction patterns, render output, and all
test fixtures are byte-identical to rc.6. The `_meta.generator.version`
field of newly generated packets will read `0.1.0-rc.7` (driven by the
bumped `VERSION` constant), but no semantic differences exist.

After rc.7 ships and the deprecation step is verified working, 0.1.0
stable can cut cleanly — its publish run will exercise the same step
to deprecate all rc.* in one shot.

## [0.1.0-rc.6] — 2026-05-15

Sixth release candidate. rc.5 fixed the bin entrypoint so the published
binary actually executes; a broader pre-0.1.0 dogfood pass against the
working rc.5 surfaced two more real bugs (plus two polish items) that
would have shipped to users in v0.1.0 final without this gate.

### Fixed — P1 (ship-blocker)

- **Schema file not bundled in npm package (DF-S1).** rc.1-rc.5 published
  tarballs that did not include `schema/pr-change-packet.v0.1.1.schema.json`.
  Combined with a `defaultSchemaPath()` that resolved upward from the
  source tree (which doesn't exist in the installed layout), every
  npm-installed `trail packet generate` exited 5 with `SchemaValidatorInternalError`.
  Bug was masked through rc.1-rc.4 by the silent-no-op entrypoint and
  only surfaced after rc.5 fixed the bin guard. Fix:
  - `apps/capture/scripts/copy-bin.mjs` now syncs canonical
    `schema/*.json,*.yml` → `apps/capture/dist/schema/` at build, so
    the dist tree (which ships in the tarball) carries the schema.
  - `defaultSchemaPath()` probes `../schema/` first (dist/packet/
    → dist/schema/ — works in production and dev `node dist/cli.js`)
    then falls back to `../../../../schema/` (apps/capture/src/packet/
    → repo-root/schema/ — works for vitest TS unit tests). Both layouts
    now resolve to an existing file.
  - Regression coverage in `apps/capture/test/bin-entrypoint.test.ts`:
    a packaging test that asserts `dist/schema/` is present and
    parseable, plus a spawn test that imports the COMPILED
    `validate-schema.js` and asserts `defaultSchemaPath()` returns
    a path that exists.

### Fixed — P2 (high-impact UX)

- **PR body too long for non-trivial sessions (DOGFOOD-2).** The
  full `renderMarkdown` embeds every diff excerpt inline (~5 KB per
  claim × hundreds of claims = hundreds of KB), blowing past GitHub's
  ~64 KB PR-body limit. `gh pr edit --body-file` rejects with
  `GraphQL: Body is too long`. `trail packet post` failed outright;
  `trail packet decide` posted the comment + updated `approval_trail`
  locally but failed to refresh the PR body. Fix:
  - New `renderMarkdownSummary()` in `render/markdown.ts`. Same
    essentials (packet ID, claim count, redaction summary, task
    intent, approval trail) but the claims table omits inline
    diff content and caps at 50 rows by priority (decided claims
    first, then appearance order). Footer links to the local
    full-fidelity packet file.
  - `packetPost` and `packetDecide` body-refresh now call
    `renderMarkdownSummary`. Full `renderMarkdown` still drives
    the local `.trail/sessions/<sid>/packet-N.md` for deep review.
  - Test coverage: 1000-claim packet renders to <50 KB; decided
    claims appear regardless of cap; approval trail still emits.

### Fixed — P3 (polish)

- **`trail packet generate` missing description (DF-S2).** Added
  `.description("Generate a packet from a Claude Code session transcript")`
  so `trail packet --help` shows the subcommand's purpose alongside
  the others.
- **Missing-required-option exit code + double-print (DF-S3).** rc.5
  exited 1 (not 8) on missing `--packet` etc., and the error message
  appeared twice (commander's automatic stderr write plus the
  catch handler's). Fix:
  - Extended the EXIT=8 catch list to include
    `commander.missingMandatoryOptionValue`, `commander.invalidOptionArgument`,
    and `commander.optionMissingArgument`.
  - `configureOutput({ outputError: noop })` suppresses commander's
    auto-print; the catch handler is canonical. Applied to both
    `trail` and `trail-audit`.

### Invalidated from the rc.5 dogfood report

- ~~Exit code 0 on gh failure~~ — was a shell pipeline measurement
  artifact (`$?` after `| tail` reads tail's exit). Both commands
  return exit 1 correctly.
- ~~`--per-diff` produces larger output~~ — works exactly as specified
  (`docs/specs/phase-1-capture.md:85`: "one claim per DIFF instead of
  per-file"). Larger output is the documented trade-off for granularity.

## [0.1.0-rc.5] — 2026-05-15

Fifth release candidate. rc.4 attached Tauri installers correctly and
both npm packages published with provenance — but during dogfood the
**`trail` and `trail-audit` bins published to npm were silently broken**:
every invocation exited 0 with no output. Root cause: the bottom-of-cli
entrypoint guard compared `import.meta.url` (which Node resolves through
symlinks) against `` `file://${process.argv[1]}` `` (which Node leaves at
the unresolved symlink path under default flags). The two never matched
when the bin was invoked through npm's symlink, so `runCli` was never
called.

The bug slipped past 658 vitest + 168 cargo tests because every existing
CLI test imports `runCli` from `../src/cli.js` directly, bypassing the
entrypoint guard entirely. AC#9 (real npm-install dogfood) was the first
exercise of the actual published-bin path.

### Fixed

- `apps/{capture,audit}/src/cli.ts`: resolve both sides of the
  entrypoint check through `fs.realpathSync` + `url.fileURLToPath`.
  Survives npm/pnpm/Yarn bin symlinks and direct `node dist/cli.js`.

### Added — tests

- `apps/capture/test/bin-entrypoint.test.ts` (regression)
- `apps/audit/test/bin-entrypoint.test.ts` (regression)
- Both tests spawn the built `dist/cli.js` through a synthetic
  symlink (the exact shape `npm install -g` produces) and assert
  `--version` produces real stdout output. The unit-test loophole
  that let rc.1–rc.4 ship a broken bin is now closed: skipping the
  guard requires removing the test, not just bypassing the import.

Same substance as rc.4 otherwise. npm packages from rc.1-rc.4 will
be deprecated post-rc.5 once dist-tag cleanup is run interactively.

## [0.1.0-rc.4] — 2026-05-15

Fourth release candidate. rc.3 fixed the tauri-action upload target
(releaseId → tagName) but uploaded still failed: tauri-action's
`getReleaseByTag` API does not return draft releases, so the tag
lookup 404'd. rc.4 replaces tauri-action's upload entirely with a
dedicated `gh release upload` step (gh CLI does find drafts by tag).
Also bumps release-finalise's permissions from `contents: read` to
`contents: write` so its `gh release view` call can see drafts (drafts
require push access to view).

Same substance as rc.3 otherwise. After rc.4 ships, v0.1.0 final cuts
cleanly with installers + npm published in one workflow run.

## [0.1.0-rc.3] — 2026-05-15

Third release candidate. rc.2 successfully published both npm packages
with provenance, but the Tauri installer matrix (Linux .deb/.AppImage,
macOS .dmg) built successfully and then failed to attach to the draft
GitHub Release. Root cause: release.yml's tauri-action step used the
`releaseId` parameter populated from `needs.create-draft-release.outputs.release_id`,
and that output expression resolved to empty in the tauri-build job
context — tauri-action emitted "No releaseId or tagName provided,
skipping all uploads". Switched to `tagName: ${{ github.ref_name }}`;
tauri-action's find-or-create logic locates the existing draft by tag
name reliably without depending on output propagation.

Same substance as rc.2 otherwise (CLI behavior, schema, redaction
patterns all unchanged). npm packages from rc.2 remain valid; rc.3
adds desktop installer attachment to the GitHub Release.

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

## [0.1.0] — 2026-05-15

The OSS MLP. v0.1.0 ships the four MLP must-haves named by external
respondents (per `opp-001`, `ht-002` panel n=11) as gating for actual use,
plus enough installation polish to be usable by someone other than the
founder.

Cut after a seven-rc prerelease cycle that surfaced (and fixed) a class
of bugs the unit-test suite couldn't see — including a silent-no-op bin
entrypoint, a schema file missing from the published tarball, a PR-body
size limit, and a manual `npm deprecate` step that was forgotten across
six release cycles before it was automated. The AC#9 dogfood acceptance
test, which exercises the full `npm install -g` → `trail packet generate
→ post → decide` happy path against a real GitHub PR, is **green** on
the rc.7 binary as of 2026-05-15. v0.1.0 is byte-identical to rc.7 in
substance.

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
