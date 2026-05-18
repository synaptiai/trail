# Test fixtures

## `18e374b5-4eb9-424d-a3ff-a639d1c6fada.redacted.jsonl`

Frozen redacted transcript fixture consumed by the three parity tests:

- `parity-mechanical.test.ts`
- `parity-md.test.ts`
- `parity-perdiff.test.ts`

The fixture is the first ~1600 records of session `18e374b5-…`, sliced to
stay under the 5 MB acceptance-criterion cap and passed through Layer 1
redaction so every string leaf outside the structural-key allowlist is
substituted with a `[REDACTED:<pattern-name>]` marker. The redaction
metadata in any generated packet still references that pipeline.

Closes synaptiai/trail#5.

### Why this fixture exists

Pre-#5, the parity tests read a live `~/.claude/projects/<dir>/<sid>.jsonl`
and self-skipped via `describe.runIf` when that path was absent — every CI
run, every fresh contributor checkout. A regression in either pipeline
could land in `main` if the maintainer forgot to run the test manually
before merging. The committed fixture removes that gate.

### How the parity tests find the fixture

1. `test/helpers/parity-fixture.ts` resolves the fixture path and copies it
   into a tempdir laid out as
   `<tempdir>/-fixture/<SESSION_ID>.jsonl`.
2. The TS-side test calls `readTranscriptSync(staging.fixturePath)` and
   builds a packet in-process.
3. The py-reference subprocess is spawned with
   `TRAIL_CLAUDE_PROJECTS_ROOT=<tempdir>` on its env so its
   `CLAUDE_PROJECTS_ROOT` resolves to the staged fixture instead of the
   user's `~/.claude/projects/`. HOME is left untouched so Python still
   finds the user-site `pyyaml` install.

### Regenerating the fixture

Use `scripts/regen-redacted-transcript-fixture.mjs` (internal repo only —
the script reads from the maintainer's `~/.claude/projects/`). From the
repo root:

```
pnpm --filter @synapti/trail-capture run build
node scripts/regen-redacted-transcript-fixture.mjs
node bin/secrets-scan.mjs --files apps/capture/test/fixtures/18e374b5-4eb9-424d-a3ff-a639d1c6fada.redacted.jsonl
./apps/capture/node_modules/.bin/vitest --root apps/capture run test/parity-mechanical.test.ts test/parity-md.test.ts test/parity-perdiff.test.ts
```

Order matters: the build step refreshes `apps/capture/dist/redaction/` so
the regen script loads the latest Layer 1 patterns. After the regen,
secrets-scan asserts the fixture contains zero pattern matches, and the
three parity tests confirm TS port and py-reference still agree on the
new redacted bytes.

### When to regenerate

Whenever a redaction-pattern PR lands in
`bin/trail-redaction-patterns.yml`. The fixture freezes the redactor's
output for a specific pattern set; new patterns or pattern tightenings
will shift the fixture's bytes and the parity assertions will surface the
divergence. Bundle the regenerated fixture into the same PR as the
pattern change so the CI gate stays green.

## `canonical-session.yml` / `canonical-session.md` / `canonical-session-perdiff.yml`

Canonical packet outputs from running the production capture pipeline
against the redacted-transcript fixture above with deterministic
`packetId` + `generatedAt`. Closes synaptiai/trail#4.

The byte-equality test in `apps/capture/test/canonical-session.test.ts`
catches regressions in:

- Layer 1 redaction (pattern catalog, post-match filters)
- extraction order / dedup / schema field shape
- packet serialization (YAML key order, trailing newlines)

The `.md` test is currently a structural smoke (file exists + key
sections + size within ±10%) rather than byte-equality, due to a
cross-context non-determinism in the markdown renderer (regen-script
output differs from vitest-context output for the same `generate()` call
and same dist build). Tracked as a follow-up. The two `.yml` fixtures
ARE byte-equality-pinned and provide the structured-data regression
gate.

### Regenerating the canonical fixtures

```
pnpm --filter @synapti/trail-capture run build
node apps/capture/scripts/regen-canonical-fixtures.mjs
./apps/capture/node_modules/.bin/vitest --root apps/capture run test/canonical-session.test.ts
```

If the regen produces fixture diffs, commit them ALONGSIDE the source
change so the diff carries the rationale. The fixture is the
documentation of the production pipeline's contract.
