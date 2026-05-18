#!/usr/bin/env bash
# audit-release-symbols.sh — fail CI if forbidden symbols leak into the
# production Tauri release binary.
#
# Closes synaptiai/trail#8 criteria (i) per-platform binary symbol audit
# and (ii) CI fail-on-symbol-present.
#
# The cfg-gate at apps/ui/src-tauri/src/ipc.rs
# (`#[cfg(any(debug_assertions, feature = "test-fixtures"))]`) is meant to
# remove `seed_stress_packets` (and any future debug/test-fixture symbols)
# from any release build that is NOT compiled with `--features test-fixtures`
# and NOT compiled with `debug_assertions` enabled. This script verifies
# the cfg-gate is load-bearing: if a release artifact ever ships with a
# forbidden symbol, CI fails immediately.
#
# Detection method: `grep -a` (binary-as-text) on each compiled binary.
# Cross-platform: works on macOS / Linux / Windows-via-Git-Bash. Catches
# both the mangled symbol-table name (`__ZN8trail_ui...seed_stress_packets...`)
# and any format-string literal (e.g. `format!("seed_stress_packets: {e}")`).
# A clean release build emits zero matches; a test-fixtures build emits
# three (verified locally during initial implementation).
#
# Usage:
#   ./scripts/audit-release-symbols.sh
#
# CI invocation: .github/workflows/release.yml runs this after the
# tauri-build matrix's tauri-action step, before the upload step.

set -euo pipefail

# Symbols that MUST be absent from a production release binary. Add new
# entries here when a new cfg-gated test-only IPC ships.
FORBIDDEN_SYMBOLS=(
  "seed_stress_packets"
)

TARGET_ROOT="apps/ui/src-tauri/target"
if [ ! -d "$TARGET_ROOT" ]; then
  echo "ERROR: $TARGET_ROOT not found — run from repo root." >&2
  exit 2
fi

# Locate every production trail-ui binary under target/. Includes:
#   - target/release/trail-ui                          (Linux, Windows non-cross)
#   - target/release/trail-ui.exe                      (Windows)
#   - target/<triple>/release/trail-ui                 (universal-apple-darwin sub-targets)
# Excludes intermediate object files (deps/, build/, incremental/) and any
# debug-profile binaries (which legitimately contain the symbol).
binaries=()
while IFS= read -r f; do
  binaries+=("$f")
done < <(find "$TARGET_ROOT" -type f \
  \( -name 'trail-ui' -o -name 'trail-ui.exe' \) \
  -not -path '*/deps/*' \
  -not -path '*/debug/*' \
  -not -path '*/build/*' \
  -not -path '*/incremental/*' \
  2>/dev/null | sort -u)

if [ ${#binaries[@]} -eq 0 ]; then
  echo "ERROR: no release binaries found under $TARGET_ROOT." >&2
  echo "Expected at least one of: trail-ui or trail-ui.exe under a release/ path." >&2
  echo "Run 'cargo build --release --bin trail-ui' before invoking the audit." >&2
  exit 2
fi

echo "Auditing ${#binaries[@]} binary(ies):"
printf '  %s\n' "${binaries[@]}"
echo "Forbidden symbols:"
printf '  %s\n' "${FORBIDDEN_SYMBOLS[@]}"
echo

fail_count=0
for bin in "${binaries[@]}"; do
  for sym in "${FORBIDDEN_SYMBOLS[@]}"; do
    if grep -a -q "$sym" "$bin"; then
      hits=$(grep -a -c "$sym" "$bin")
      echo "FAIL: '$sym' found ${hits}× in $bin"
      fail_count=$((fail_count + 1))
    else
      echo "OK:   '$sym' absent from $bin"
    fi
  done
done

echo
if [ $fail_count -gt 0 ]; then
  echo "Audit FAILED: $fail_count leak(s) detected."
  echo
  echo "The cfg-gate at apps/ui/src-tauri/src/ipc.rs is NOT removing the"
  echo "test-fixture IPC from this release binary. Likely causes:"
  echo "  1. cargo build invoked without --release (debug_assertions on)"
  echo "  2. cargo build invoked with --features test-fixtures"
  echo "  3. a #[cfg(...)] attribute was removed or weakened in ipc.rs/main.rs"
  echo
  echo "Inspect with: nm -gU <binary> | grep <symbol>"
  exit 1
fi

echo "Audit PASSED: all forbidden symbols absent from release binaries."
exit 0
