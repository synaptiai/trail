# `apps/capture/bin/` — auto-synced from canonical

The `.yml` files in this directory are **build artefacts**. They are
copied from the repo-root `bin/` directory (which is the canonical
source, also consumed by `py-reference/cli/trail.py`) on every
invocation of `pnpm --filter @synapti/trail-capture build` (`prebuild` hook)
and on every test run (`pretest` hook).

## Do NOT edit these files directly

Edits made here will be **silently overwritten** the next time `build`,
`test`, or `sync-bundled-yaml` runs.

To change a bundled pattern set (or test-runners catalog):

1. Edit `<repo-root>/bin/<filename>.yml`.
2. If the change rotates the file's SHA-256, update the corresponding
   pin in `apps/capture/test/patterns-load.test.ts` (F8 hash-pin test
   — that test additionally asserts byte-equality between the canonical
   and package copies, so drift is impossible to ship without test
   failure).
3. Bump `version:` inside the YAML if it's a meaningful pattern-set
   change (so the emitted `pattern_set_version` reflects it).

## Why two copies?

Historical: the package needs the YAML colocated for the published npm
bundle (`files: ["dist", "bin", ...]` in `package.json`). The repo-root
copy is colocated with the schema and py-reference for the
cross-language workflow.

The build script (`scripts/copy-bin.mjs`) syncs canonical → package
in stage 1, then package → `dist/bin/` in stage 2. The byte-equality
test in `patterns-load.test.ts` (F19 / 2026-05-09) catches any future
attempt to bypass the sync and edit only one copy.

See spec §10 + cycle-2 review F19 for the rationale.
