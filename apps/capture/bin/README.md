# `apps/capture/bin/` — auto-synced from canonical (gitignored)

The `.yml` files in this directory are **build artefacts** and are NOT
committed. They are gitignored (`apps/capture/bin/*.yml` in repo-root
`.gitignore`) and regenerated from the canonical `bin/` directory (which
is the canonical source, also consumed by `py-reference/cli/trail.py`)
on every invocation of `pnpm --filter @synapti/trail-capture build`
(`prebuild` hook) and on every test run (`pretest` hook).

## Do NOT edit these files directly

Edits made here will be **silently overwritten** the next time `build`,
`test`, or `sync-bundled-yaml` runs. They will also fail to commit (the
path is gitignored).

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

The package needs the YAML colocated for the published npm bundle
(`files: ["dist", "bin", ...]` in `package.json`). The repo-root copy is
colocated with the schema and py-reference for the cross-language
workflow. Only the canonical (repo-root) copy is committed; this
directory's `.yml` files are generated.

The build script (`scripts/copy-bin.mjs`) syncs canonical → package
in stage 1, then package → `dist/bin/` in stage 2. Two test gates
defend the invariant:

- `patterns-load.test.ts` (F19 / 2026-05-09) — byte-equality between the
  canonical and (regenerated) package copies. Catches drift if the
  build script's stage 1 has a regression.
- `patterns-load.test.ts` (gh#9 / 2026-05-18) — `git ls-files` returns
  exactly one tracked YAML path per filename. Catches reintroduction of
  a second committed copy.

See spec §10, cycle-2 review F19, and gh#9 for the rationale.
