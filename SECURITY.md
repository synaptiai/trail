# Security Policy

## Supported versions

| Version       | Supported          |
| ------------- | ------------------ |
| `0.1.0-rc.*`  | yes (latest only)  |
| `< 0.1.0-rc`  | no (pre-release)   |

## Reporting a vulnerability

**Do not file public GitHub issues for security reports.**

Email **security@synapti.ai** with:

- Affected version(s) and how to reproduce
- Impact (data exposure / privilege escalation / DoS / etc.)
- Whether you have a suggested fix

We aim to acknowledge within 72 hours and publish a fix or mitigation
within 14 days of acknowledgement. We will credit reporters in the
release notes unless you request otherwise.

## Threat model (v0.1)

Trail's design assumes:

- The user runs Trail against their own AI-coding session transcripts
- Transcripts may contain secrets the user did not intend to share
- Trail's job is to **redact** before any packet leaves the user's
  machine (Layer 1) AND to **re-scan** before any packet is staged for
  commit (Layer 3 audit)

Reports that fall within this model are top priority:

- Redaction-pattern bypasses (a real secret pattern Trail's catalog fails
  to redact)
- ReDoS in `bin/trail-redaction-patterns.yml` (we use `safe-regex` but
  bug reports welcome)
- Path-traversal in saga writes (`.trail/sessions/<id>/...`)
- IPC privilege boundary violations in the Tauri shell

Reports outside the threat model (e.g., the desktop app crashing on
malformed input that the user themselves provided) are still welcome
but lower priority.

## Supply-chain

- npm packages publish with [sigstore provenance](https://docs.npmjs.com/generating-provenance-statements)
  attestations from this repo's GitHub Actions workflows
- All GitHub Actions are SHA-pinned, not tag-floating
- Tauri installers ship unsigned for v0.1 (code-signing arrives in v0.1.x);
  verify SHA-256 against the GitHub Release page
