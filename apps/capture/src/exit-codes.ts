// Exit code constants — spec §8.3.
//
// The Phase 1 set is locked. Phase 3b (gh#4) reuses some codes for new
// failure classes per the issue's AC-8 (auth=3, network=7, PR-not-found=9):
//   - auth fail (gh)              → EXIT_GIT_STATE (3)
//   - rate limit (HTTP 403/429)   → EXIT_LLM_STRICT-shaped 7 reused as
//                                   EXIT_RATE_LIMIT/EXIT_NETWORK (alias)
//   - PR not found                → EXIT_CONCURRENT-shaped 9 reused as
//                                   EXIT_PR_NOT_FOUND (alias)
//   - gh CLI not installed        → EXIT_PATTERNS-shaped 4 reused as
//                                   EXIT_GH_MISSING

export const EXIT_OK = 0;
export const EXIT_GENERIC = 1;
export const EXIT_TRANSCRIPT_NOT_FOUND = 2;
export const EXIT_GIT_STATE = 3;
export const EXIT_PATTERNS = 4;
export const EXIT_VALIDATION = 5;
export const EXIT_WRITE = 6;
export const EXIT_LLM_STRICT = 7;
export const EXIT_INVALID_ARGS = 8;
export const EXIT_CONCURRENT = 9;
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

// gh#4 AC-8 aliases (Phase 3b). Same integers, semantic names.
export const EXIT_AUTH = EXIT_GIT_STATE; // 3
export const EXIT_GH_MISSING = EXIT_PATTERNS; // 4
// CV-2 (cycle-1 P3) known design choice: rate-limit (HTTP 403/429) and
// transient network failures both map to exit 7 in v0.1 per AC-8. The error
// MESSAGES distinguish them (rate-limit hint vs network-retry hint) but a
// downstream retry harness cannot key on exit code alone. Splitting into
// distinct codes (e.g. 7=rate-limit, 10=network) is deferred to v0.2 because
// the Phase 1 exit-code schedule is parity-locked at 0..9 (+130/143) and
// adding a new code is a wider schema change. Tracked in v0.1 follow-up.
export const EXIT_NETWORK = EXIT_LLM_STRICT; // 7
export const EXIT_RATE_LIMIT = EXIT_LLM_STRICT; // 7
export const EXIT_PR_NOT_FOUND = EXIT_CONCURRENT; // 9
// EH-1 (cycle-1 P3): packet ≠ transcript semantically. Phase 3b
// `trail packet post`/`decide` "missing packet path" reuses exit 2 because
// it is the closest existing class (NOT_FOUND for the artifact the command
// expects), but the alias makes the intent legible at call sites.
export const EXIT_PACKET_NOT_FOUND = EXIT_TRANSCRIPT_NOT_FOUND; // 2
