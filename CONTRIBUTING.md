# Contributing to Trail

Thanks for your interest. Trail is currently in v0.1 release-candidate
status — expect rough edges, and please surface them.

## What's in scope for v0.1

- Bug reports against the published binaries (`@synapti/trail-capture`,
  `@synapti/trail-audit`, Tauri desktop app)
- Documentation issues (typos, unclear instructions, broken links)
- Compatibility issues on platforms named in the README install snippets

## What's deferred

- New features (those land via the v0.2 roadmap once v0.1 stabilizes)
- Major refactors of `apps/`
- Code-signing for the Tauri installers (in progress for v0.1.x)

## How to file an issue

Please use the issue templates at
<https://github.com/synaptiai/trail/issues/new/choose>. Include:

- What you ran (exact command line + flags)
- What you saw (paste output, redact secrets first)
- What you expected
- Platform: OS + version + node version + (if relevant) Tauri OS

## Pull requests

For v0.1 we're not yet accepting unsolicited PRs while the redaction
pattern set and packet schema are still settling. If you spot a clear bug
with a 1–5 line fix, open an issue and reference the file:line — happy
to thank you in the changelog. Larger contributions: please open an issue
first to discuss scope before investing time.

## Code of conduct

Be kind. Assume good intent. Disagreement is welcome; harassment, slurs,
and personal attacks are not.

## Licensing

By submitting a contribution you agree it is licensed under Apache-2.0
(the project's license).
