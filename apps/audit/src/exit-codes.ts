// Exit codes for `trail audit precommit`.
//
// These are scoped to the audit subcommand and intentionally diverge from
// `apps/capture`'s spec §8.3 codes:
//   - This is a different binary with a different scope (Layer 3 audit, not
//     packet generation), so the audit-side exit semantics are a fresh
//     contract per gh#3 issue acceptance criterion 3.
//   - py-reference/bin/trail-audit-precommit uses exit 1 for violations; the
//     TS port upgrades this to exit 8 (per issue body) so a pre-commit hook
//     can disambiguate "policy violation found" from "scanner crashed".
//
// Mapping:
//   0  = clean (or no .trail/ to scan)
//   2  = git-state failure (not a git repo when --staged-only is set, or
//        `git diff --cached` invocation failed)
//   4  = patterns YAML load failure (mirrors @synapti/trail-capture exit 4 shape)
//   8  = policy violation: one or more files contain unredacted secret-like
//        patterns. Pre-commit hooks should block the commit.
//
// Codes 1, 3, 5, 6, 7, 9 are deliberately unallocated for the audit binary
// to keep the surface minimal. Future v0.2+ may allocate additional codes
// for `--auto-fix` write failures or pattern-set override conflicts.

export const EXIT_OK = 0;
export const EXIT_GIT_STATE = 2;
export const EXIT_PATTERNS = 4;
export const EXIT_VIOLATION = 8;
