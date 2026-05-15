# CSP rationale — `tauri.conf.json` security.csp

Cycle-3 review surfaced two questions about the CSP at `tauri.conf.json:26`. Both
are documented here so future PRs (and a security review of the shipped binary)
can see the intent without re-deriving it.

## `style-src 'self' 'unsafe-inline'`

**Why kept for v0.1.0** (cycle-3 C3-S-SEC-3): the design system relies on inline
`style={…}` props sprinkled across the B3 primitives and ad-hoc layout
adjustments in screen components. Removing `'unsafe-inline'` today would either
require migrating every inline `style={…}` to CSS-in-JS-with-nonces (substantial
refactor scope, ~80+ touchpoints) or hashing every literal style block (brittle,
breaks any runtime style mutation). Neither is justified for the v0.1 OSS MLP.

**Threat model**: `'unsafe-inline'` for `style-src` is materially less risky than
the same directive on `script-src` (script-src is `'self'`, explicitly NOT
`'unsafe-inline'`). A style-injection attacker can leak data via background-image
URL pivots, but they cannot execute code. Trail is a desktop app with no
attacker-controlled HTML surface — the renderer loads only our bundle, the IPC
boundary blocks injection.

**v0.1.x migration**: move inline styles to a nonced approach (`style-src 'self'
'nonce-…'`). Tracked in [umbrella issue
#30](https://github.com/synaptiai/trail/issues/30).

## `connect-src 'self' ipc: http://ipc.localhost`

**Why `http://` not `https://`** (cycle-3 C3-V-SEC-3): the loopback origin
`ipc.localhost` is Tauri v2's IPC bridge. Tauri injects its own handler at this
origin and traffic NEVER leaves the desktop process — TLS is meaningless on a
loopback IPC channel. The `http://` scheme is therefore intentional, not a TLS
downgrade.

**Verification**: a "tighten CSP to require https://" PR would break IPC entirely
because Tauri v2 does not present a TLS certificate on the loopback IPC channel.
External CSP linters that flag this line are looking at it through a remote-web
lens; the rationale is desktop-IPC-specific.

## Maintenance contract

If you change the CSP, update both this file and `CHANGELOG.md`. The frontend
test suite has no automated CSP regression test (Tauri's renderer doesn't
enforce CSP during vitest unit runs); changes are guarded by manual review and
the actionlint job catches workflow drift, not config drift.
