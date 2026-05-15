# @synapti/trail-capture — Trail Layer 1

Post-hoc capture from Claude Code transcripts. TypeScript port of `py-reference/cli/trail.py`.

## What this is

The Layer-1 capture pipeline of [Trail](https://github.com/synaptiai/trail), an AI-native change-control layer. Reads a Claude Code session transcript (`.jsonl`) and emits a PR Change Packet conforming to `schema/pr-change-packet.v0.1.1.yml`.

## Install (workspace)

```bash
pnpm install
pnpm --filter @synapti/trail-capture build
```

The package is not yet published to npm; v0.1 is consumed via the pnpm workspace.

## CLI

```
trail packet generate <session-id>          # mechanical synthesis
trail packet generate --no-llm <session-id> # force mechanical
trail packet generate --per-diff <session-id>
trail packet generate --dry-run <session-id>
trail packet list
```

See `docs/specs/phase-1-capture.md` §3 for the full flag inventory and exit-code contract.

## Architecture

Module layout (`src/`):

| Module | Purpose |
|---|---|
| `cli.ts` | commander wiring; arg parsing + validation BEFORE I/O |
| `generate.ts` | top-level pipeline orchestrator (spec §3 default behavior) |
| `transcript/reader.ts` | JSONL parser; tool_result inline extraction |
| `git/state.ts` | simple-git wrappers; `pr.*` + `diff_summary.*` |
| `git/url.ts` | `stripUserinfo` chokepoint (A4.5 SEC-2 / A4.7 R-SEC-4) |
| `redaction/patterns.ts` | YAML loader; FAILSAFE_SCHEMA; 64KB cap; safe-regex ReDoS guard |
| `redaction/layer1.ts` | capture-time redaction; replacement format `[REDACTED:<name>]` |
| `redaction/layer2.ts` | write-time scan over serialized YAML bytes; sha256(match)[:8] snippet |
| `extract/extract.ts` | transcript walk → DIFF/CMD/TEST/PROMPT |
| `claims/mechanical.ts` | per-file (default) and per-DIFF synthesis |
| `claims/llm.ts` | claude CLI subprocess; 6 fallback triggers; SIGINT-safe spawn |
| `packet/build.ts` | assemble Packet from components |
| `packet/ulid.ts` | inline Crockford base32 ULID generator |
| `packet/stable-id.ts` | AB-5 sha256 stable_id derivation |
| `packet/yaml.ts` | js-yaml dump options locked for parity with pyyaml |
| `packet/recapture.ts` | AB-9 packet-N versioning + `_meta.parent_packet_id` |
| `packet/validate-schema.ts` | Ajv 2020-12 structural pass |
| `packet/validate-refs.ts` | post-build cross-reference pass (pure TS) |
| `render/markdown.ts` | parity-tested markdown render |
| `io/atomic.ts` | tmp+rename helper |
| `io/signals.ts` | SIGINT/SIGTERM tree-kill + cleanup |
| `storage/sqlite.ts` | optional better-sqlite3 + drizzle-orm storage |
| `storage/noop.ts` | no-op for `--no-storage` |

## Test layout

```
test/
├─ ulid.test.ts                 # 26-char Crockford base32
├─ stable-id.test.ts            # AB-5 sha256 derivation
├─ userinfo-strip.test.ts       # A4.5 SEC-2 single chokepoint
├─ patterns-load.test.ts        # 9 sub-shapes for exit 4
├─ redaction.test.ts            # Layer 1+2 unit
├─ redaction-matrix.test.ts     # 91 cases (10 patterns × 3 fields × 3 positions)
├─ recapture.test.ts            # AB-9 packet-N detection
├─ atomic-write.test.ts         # tmp+rename contract
├─ schema-validate.test.ts      # Ajv structural + cross-reference
├─ extract.test.ts              # transcript walk edge cases
├─ markdown-render.test.ts      # render unit
├─ llm-fallback.test.ts         # 6 trigger matrix
├─ yaml-property.test.ts        # fast-check round-trip
├─ generate-integration.test.ts # end-to-end (real transcript, real disk)
├─ parity-mechanical.test.ts    # 12 tests: TS vs py-reference (mechanical)
├─ parity-perdiff.test.ts       # TS vs py-reference (--per-diff)
└─ parity-md.test.ts            # 9 tests: markdown structural + line-by-line
```

192 tests; run via `pnpm --filter @synapti/trail-capture test`.

## Storage (optional)

`better-sqlite3` and `drizzle-orm` are optional dependencies. On platforms without prebuilt binaries (e.g., Node 26+ on Apple Silicon as of v0.1) the storage layer falls back to noop and the packet write proceeds (best-effort per spec §3 step 10i).

## Spec reference

Authoritative: `docs/specs/phase-1-capture.md` v1.2.

License: Apache-2.0.
