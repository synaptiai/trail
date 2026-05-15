# @trail/ui — Trail Layer 3

Tauri 2.x + React 18 + Vite desktop application. Single window, three personas
(Creator / Reviewer / Auditor) selected via the `?mode=` URL parameter.

## Status

Sprint 1 of the 7-sprint Phase 2 build per [gh#2](https://github.com/synaptiai/trail/issues/2).
Foundation: Tauri scaffold, design tokens (forensic instrument aesthetic),
13 B3 component primitives, IPC contract, libSQL schema + migrations,
saga / watcher / YAML-safety primitives.

Subsequent sprints land:

- **Sprint 2** — trail browser sidebar virtualization + libSQL boot + filters
- **Sprint 3a** — packet view foundation (header / risk histogram / claim list)
- **Sprint 3b** — packet view tabs (claims / diff / redaction / trail) + DiffHunk shiki integration
- **Sprint 4** — decisions + modals (M1, M3, M5, M6) + atomic-write saga + watcher integration + carry-forward
- **Sprint 5** — GitHub posting (M2 + M4) + edge flows (E1-E7)
- **Sprint 6** — `?` keyboard overlay + ARIA audit + reduced-motion verify + perf-budget CI gates

## Authoritative specs

- `docs/specs/phase-2-ui-stories.md` (B1)
- `docs/specs/phase-2-ui-flows.md` (B2)
- `docs/specs/phase-2-design-system.md` (B3) — this app's `DESIGN.md`
- `docs/specs/phase-2-screen-specs.md` (B4)
- `docs/specs/phase-2-architecture-reconciliation.md` (B5)
- `docs/specs/phase-2-design-review-b6.md` (B6)
- `docs/specs/phase-2-ab-resolution.md` (AB)

## Local commands

```bash
pnpm --filter @trail/ui install        # install deps (run once at workspace root)
pnpm --filter @trail/ui tokens:gen     # regenerate tokens.css from tokens.ts
pnpm --filter @trail/ui dev            # vite dev server (1420)
pnpm --filter @trail/ui tauri:dev      # full Tauri shell + dev server
pnpm --filter @trail/ui typecheck      # tsc --noEmit
pnpm --filter @trail/ui lint           # ESLint with no-raw-design-values
pnpm --filter @trail/ui test           # vitest
pnpm --filter @trail/ui build          # tsc -b && vite build
pnpm --filter @trail/ui tauri:build    # production .dmg / .deb / .msi
```

Rust tests:

```bash
cd apps/ui/src-tauri && cargo test
```

## Layout

```
apps/ui/
├── public/fonts/                # OFL fonts vendored at build time (per B3 §2.2)
├── src-tauri/                   # Rust shell — IPC handlers, saga, watcher, YAML safety
│   ├── capabilities/default.json   # Tauri allowlist (B5 §6.2)
│   ├── src/ipc.rs                  # 12 commands + Rust validators
│   ├── src/saga.rs                 # Intent-log marker (B5 §3.1)
│   ├── src/watcher.rs              # Saga-in-flight registry (B5 §4.2)
│   └── src/yaml_safety.rs          # Size + anchor caps (B5 §6.5)
├── src/
│   ├── App.tsx                  # Single-window shell, persona via ?mode=
│   ├── components/
│   │   ├── primitives/          # 13 B3 primitives (Risk, HorizonLine, …)
│   │   └── screens/             # Top-level screens composing primitives
│   ├── db/
│   │   ├── schema.ts            # Drizzle schema (7 tables, 13 indexes)
│   │   ├── migrations/0001_init.sql
│   │   └── audit-log-hash.ts    # SHA-256 hash chain (B5 §7.1)
│   ├── design/
│   │   ├── tokens.ts            # Source-of-truth token map
│   │   ├── tokens.css           # GENERATED from tokens.ts
│   │   ├── glyphs/              # Risk SVG glyphs (defense-in-depth, B3 §15.1)
│   │   └── shiki-themes/        # trail-dark.json / trail-light.json
│   ├── ipc/
│   │   ├── contract.ts          # Zod-validated 12 commands + 6 events
│   │   └── client.ts            # Typed Tauri-invoke wrapper
│   └── services/highlight.ts    # Shiki singleton + per-language warm cache
├── scripts/codegen-tokens.mjs   # tokens.ts → tokens.css
├── tests/unit/                  # Vitest + Testing Library
├── eslint.config.mjs            # `tokens/no-raw-design-values` rule (criterion 2)
├── drizzle.config.ts            # Drizzle migration tooling
├── tsconfig.json
├── tauri.conf.json -> src-tauri/tauri.conf.json
├── vite.config.ts
└── vitest.config.ts
```

## Risk encoding (the highest-leverage a11y surface)

Per WCAG 2.1 1.4.1 (color-not-alone) and B3 §4, every risk display pairs THREE
signals simultaneously:

| Level | SVG glyph | Label | Pigment |
|---|---|---|---|
| LOW | `◯` outline | `LOW` | sage |
| MED | `◐` half-fill | `MED` | mustard |
| HIGH | `●` filled | `HIGH` | terracotta |
| CRIT | `⨂` filled-with-cross | `CRIT` | oxblood (brightened to `#C84A40` in dark mode for WCAG 1.4.11) |

Glyphs render as inline SVG (defense-in-depth against font tamper per B3 §15.1
finding 3). The `<Risk>` primitive exposes `role="img"` with verbal `aria-label`
(`"Risk level: high"`), not the unicode rendering.
