# @synapti/trail-audit — Trail Layer 3

Pre-commit audit of `.trail/` packets for unredacted secret-shape patterns. TypeScript port of `py-reference/bin/trail-audit-precommit`.

## What this is

The Layer-3 enforcement gate of [Trail](https://github.com/synaptiai/trail). Re-scans staged or on-disk packet YAML/Markdown files using the bundled redaction pattern set (`bin/trail-redaction-patterns.yml` v0.1.3, loaded via `@synapti/trail-capture`'s `loadPatterns()`). Catches:

- Bugs in Layer 1 (capture-time redaction).
- Bugs in Layer 2 (write-time validation).
- New patterns added after the packet was captured.
- User-edited packet files that re-introduced secrets.
- Force-added gitignored files.

See `docs/specs/phase-1-capture.md` §5 for the three-layer redaction architecture.

## Install (workspace)

```bash
pnpm install
pnpm --filter @synapti/trail-audit build
```

Not yet published to npm; v0.1 is consumed via the pnpm workspace.

## CLI

```
trail-audit precommit [--staged-only] [--root <path>] [--patterns <path>]
                      [--json] [--quiet]
```

| Flag | Default | Effect |
|---|---|---|
| `--staged-only` | off | Scan only files staged for commit (`git diff --cached --name-only --diff-filter=AM`). Pre-commit hook mode. |
| `--root <path>` | cwd | Repository root containing `.trail/`. |
| `--patterns <path>` | bundled | Override the patterns YAML (advanced — usually unset). |
| `--json` | off | Emit one JSON object per finding to stderr (NDJSON), `{file, line, pattern, snippet_hash}`. |
| `--quiet` | off | Suppress `[trail-audit] OK — scanned N file(s)` on clean runs. |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Clean (or no `.trail/` to scan) |
| 2 | Git-state failure (not a repo when `--staged-only`, or `git diff --cached` failed; also CLI arg-parse failures) |
| 4 | Patterns YAML load failure |
| 8 | Policy violation — one or more files contain unredacted secret-like patterns. Pre-commit hooks should block the commit. |

The audit NEVER prints raw match content. Findings are reported with `pattern=<name>  hash=<sha256[:8]>` only (per spec §5 SEC-9).

## Pre-commit hook installation

Save this as `.git/hooks/pre-commit` and `chmod +x` it:

```bash
#!/usr/bin/env bash
# Trail Layer 3 pre-commit gate. Blocks commits containing unredacted
# secret-shape patterns under .trail/sessions/<sid>/packet-*.{yml,md}.
set -e
exec node "$(git rev-parse --show-toplevel)/apps/audit/dist/cli.js" \
  precommit --staged-only --quiet "$@"
```

Or, once installed globally:

```bash
ln -sf "$(pnpm --filter @synapti/trail-audit exec which trail-audit)" .git/hooks/pre-commit
```

The hook runs on `git commit`; exit 8 aborts the commit. To bypass (NOT recommended):

```bash
git commit --no-verify  # bypasses ALL pre-commit hooks
```

## Architecture

Module layout (`src/`):

| Module | Purpose |
|---|---|
| `cli.ts` | commander wiring; arg parsing + I/O sinks (test seam: `RunCliDeps`) |
| `audit.ts` | pure orchestrator; `audit()` returns `AuditResult` (no `process.exit`) |
| `scanner.ts` | `scanText` / `scanFile` — pattern execution + line counting + sha256[:8] hashing |
| `staged.ts` | simple-git integration for `--staged-only`; `isPacketPath` boundary regex |
| `violations.ts` | text-mode + JSON-mode reporters |
| `exit-codes.ts` | named exit-code constants |
| `index.ts` | public API surface |

The `audit()` entry point is pure-ish (returns `AuditResult` with `exitCode`, `findings`, `diagnostics`); CLI-side I/O is wired only at `cli.ts`. Other callers (e.g., a future GitHub Action variant) can integrate without spawning the CLI subprocess.

## Scan boundary

```
.trail/sessions/<session-id>/packet-<N>.{yml,md}
```

Other `.trail/` artefacts (sqlite db, lockfiles, scratch files) are ignored — patterns are calibrated for packet-shape content, and a tighter boundary reduces the false-positive rate that drives users toward `--no-verify`.

## Testing

```bash
pnpm --filter @synapti/trail-audit test         # 75 tests
pnpm --filter @synapti/trail-audit typecheck    # tsc --noEmit
pnpm --filter @synapti/trail-audit lint         # biome check
```

Planted-secret coverage uses `test/fixtures/synthetic-pattern-fixtures.json` with a `parts:[]` indirection, so the repository contains no literal secret-shape strings. `pre-commit`-style external secret scanners (gitleaks, trufflehog) and the `.claude/hooks/gate.sh` Trail-internal gate both pass on this package's source.

## License

Apache-2.0 — see root `LICENSE`.
