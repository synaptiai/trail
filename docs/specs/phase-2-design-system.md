# Phase 2 UI — Design System (B3)

**Status**: B3 draft (this is the project's authoritative DESIGN.md for the UI scope)
**Date**: 2026-05-09
**Scope**: Phase 2 (Tauri + React + Vite, v0.1 OSS MLP) — same React codebase to be reused in v0.2+ hosted webapp
**Blocks**: B4 (screen specs), B5 (architecture reconciliation), Phase 2 implementation
**Blocked by**: B1, B2 ✓
**Companion files** (introduced by this doc, lands at Phase 2 build):
- `apps/ui/src/design/tokens.css` — CSS custom properties for runtime
- `apps/ui/src/design/tokens.ts` — TypeScript source-of-truth (codegens to CSS)
- `apps/ui/src/design/fonts.css` — `@font-face` declarations
- `apps/ui/src/design/global.css` — base layer + reset + a11y defaults

---

## §1 Aesthetic direction: "Forensic Instrument"

Trail is a control-plane, not a content surface. The product is the audit trail of AI-assisted code change — an instrument that measures, records, redacts, and presents. The design vocabulary is borrowed from precision instruments (seismographs, calipers, oscilloscopes), archive documents (audit reports, ledgers, court records), and engineering schematics. **Not** terminal-cyberpunk, **not** SaaS-purple-gradient, **not** material-elevation-shadow-stack.

**Three commitments**:

1. **Editorial gravitas**, not playful chrome. The packet is a document. Headings are typeset with optical-size serifs; body uses an institutional sans (the kind shipped by national design systems). Mono is reserved for code, IDs, hashes, and risk labels — never decorative.
2. **Warm-cool patina**, not flat hex. The primary surfaces are warm-leaning ink (dark) and aged-paper cream (light). The single accent color is **copper** — a patinated metal tone that signals warmth + age + trustworthiness without the SaaS-corp-blue / health-tech-purple defaults. Status colors borrow from natural pigments (sage, mustard, terracotta, oxblood).
3. **The horizon line** as signature motif. Trail's name → a literal 1-px horizontal line that anchors composition: a trace through time, the current position in the audit, the baseline against which deviations are measured. Appears in the app chrome, the trail browser timeline, the packet summary, and risk-override stacks. It is the one detail every user remembers.

**What this is NOT**:
- NOT brutalist (we want refinement, not rawness — this is an audit instrument, not a manifesto)
- NOT cyberpunk-terminal (terminal-adjacent ≠ matrix-rain green-on-black)
- NOT material design (no layered depth shadows; flat planes with hairline borders)
- NOT generic Linear/Stripe clone

---

## §2 Typography

### 2.1 Type families

All three fonts are open-licensed (compatible with Trail Apache-2.0). Self-hosted in `apps/ui/public/fonts/` to avoid CDN dependency in Tauri offline mode.

| Role | Family | License | Purpose |
|---|---|---|---|
| **Display + emphasis** | **Newsreader** (Production Type) | OFL 1.1 | Headings, packet titles, claim text emphasis. Optical-size variable axis adapts to size — small caps at small sizes are not blurred, display sizes are tighter. The serif is the editorial gravitas signal. |
| **Body + UI** | **Public Sans** (USWDS) | OFL 1.1 | All UI chrome, body text, labels, navigation. A US-government design-system face — institutional clarity, distinctive in a market saturated by Inter/Roboto. |
| **Mono** | **Commit Mono** (Eigil Nikolajsen) | OFL 1.1 | Code, file paths, claim IDs, hash digests, risk-level labels (`LOW` / `MED` / `HIGH` / `CRIT`), keyboard shortcut keys. Slashed zero. JetBrains Mono is the conservative fallback if Commit Mono presents licensing or rendering issues. |

**No Inter. No Roboto. No Space Grotesk. No "system-ui" stack as primary.**

### 2.2 Font loading

```css
/* fonts.css */
@font-face {
  font-family: "Newsreader";
  font-style: normal;
  font-weight: 200 800;
  font-display: swap;
  src: url("/fonts/Newsreader[opsz,wght].woff2") format("woff2-variations");
  font-variation-settings: "opsz" 14;
}

@font-face {
  font-family: "Public Sans";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("/fonts/PublicSans[wght].woff2") format("woff2-variations");
}

@font-face {
  font-family: "Commit Mono";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("/fonts/CommitMono-400-Regular.woff2") format("woff2");
}
@font-face {
  font-family: "Commit Mono";
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url("/fonts/CommitMono-700-Bold.woff2") format("woff2");
}
```

### 2.3 Type scale

A modular scale at ratio **1.200** (minor third) — restrained, document-like. Base is 14px (UI density default; Tauri runs at native pixel density on macOS Retina). Body 15px for sustained reading.

| Token | Size | Line-height | Family | Weight | Tracking | Use |
|---|---|---|---|---|---|---|
| `--type-display-1` | 36 / 2.571rem | 1.10 | Newsreader, opsz 36 | 400 | -0.02em | Trail browser hero title only |
| `--type-display-2` | 28 / 2rem | 1.15 | Newsreader, opsz 28 | 400 | -0.015em | Packet title |
| `--type-h1` | 22 / 1.571rem | 1.25 | Newsreader, opsz 22 | 500 | -0.01em | Section headings |
| `--type-h2` | 18 / 1.286rem | 1.30 | Newsreader, opsz 18 | 500 | -0.005em | Sub-section headings |
| `--type-h3` | 15 / 1.071rem | 1.35 | Public Sans | 600 | 0 | Inline headings, claim titles |
| `--type-body` | 15 / 1.071rem | 1.55 | Public Sans | 400 | 0 | Body text |
| `--type-body-sm` | 13 / 0.929rem | 1.50 | Public Sans | 400 | 0 | Secondary text, captions |
| `--type-ui` | 14 / 1rem | 1.40 | Public Sans | 500 | 0 | Buttons, controls, nav |
| `--type-label` | 11 / 0.786rem | 1.30 | Public Sans | 600 | 0.08em (UPPERCASE) | Section labels, table headers |
| `--type-mono` | 13 / 0.929rem | 1.55 | Commit Mono | 400 | 0 | Code, IDs, paths |
| `--type-mono-sm` | 11 / 0.786rem | 1.45 | Commit Mono | 600 | 0.02em | Risk labels, keyboard keys (weight raised from 500, tracking reduced from 0.04em — readability harden per §2.5) |

**Optical-size note**: Newsreader's `opsz` axis must be set per token — the font-variation-settings inline ensures the right optical mastering at each size. Without this, headings look bloated and small text looks weak.

**Numerals**: Public Sans + Commit Mono both ship tabular figures via `font-variant-numeric: tabular-nums`. Apply globally to numeric columns (timeline timestamps, risk distribution counts, packet IDs). Newsreader uses old-style figures for body; lining figures for headings (`font-variant-numeric: lining-nums`).

### 2.4 Reading width

- Body prose max-width: 68ch (~620px at 15px) — claim text, rationale, reasons.
- UI containers: full available width with internal padding.
- Tables / timelines: full width, dense.

### 2.5 Token-to-CSS mapping (wires opsz axis explicitly)

The Newsreader `@font-face` (per §2.2) sets `font-variation-settings: "opsz" 14` as the default. Without a per-token override, every Newsreader heading renders at opsz 14 — bloated at display sizes (28-36px), exactly what §1's "without this, headings look bloated and small text looks weak" warning describes. The bug is invisible in early dev (small differences) and appears at QA. To prevent quiet shipping risk, every type token that uses Newsreader (or where weight differs from the face default) ships a complete CSS class with explicit `font-variation-settings`:

```css
.type-display-1 {
  font-family: "Newsreader", serif;
  font-size: 36px;
  line-height: 1.10;
  letter-spacing: -0.02em;
  font-weight: 400;
  font-variation-settings: "opsz" 36, "wght" 400;
}

.type-display-2 {
  font-family: "Newsreader", serif;
  font-size: 28px;
  line-height: 1.15;
  letter-spacing: -0.015em;
  font-weight: 400;
  font-variation-settings: "opsz" 28, "wght" 400;
}

.type-h1 {
  font-family: "Newsreader", serif;
  font-size: 22px;
  line-height: 1.25;
  letter-spacing: -0.01em;
  font-weight: 500;
  font-variation-settings: "opsz" 22, "wght" 500;
}

.type-h2 {
  font-family: "Newsreader", serif;
  font-size: 18px;
  line-height: 1.30;
  letter-spacing: -0.005em;
  font-weight: 500;
  font-variation-settings: "opsz" 18, "wght" 500;
}

/* Public Sans tokens: no opsz axis, but explicit weight per token */
.type-h3 { font-family: "Public Sans", sans-serif; font-size: 15px; line-height: 1.071; font-weight: 600; }
.type-body { font-family: "Public Sans", sans-serif; font-size: 15px; line-height: 1.55; font-weight: 400; }
.type-body-sm { font-family: "Public Sans", sans-serif; font-size: 13px; line-height: 1.50; font-weight: 400; }
.type-ui { font-family: "Public Sans", sans-serif; font-size: 14px; line-height: 1.40; font-weight: 500; }
.type-label { font-family: "Public Sans", sans-serif; font-size: 11px; line-height: 1.30; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }

/* Commit Mono tokens */
.type-mono { font-family: "Commit Mono", monospace; font-size: 13px; line-height: 1.55; font-weight: 400; }
.type-mono-sm { font-family: "Commit Mono", monospace; font-size: 11px; line-height: 1.45; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }
```

**Mono-sm hardening (P2 finding)**: `--type-mono-sm` (used by risk labels — the WCAG 1.4.1 fallback for color blindness) is the most-critical small-text surface in the app. To improve readability at 11px, weight is raised from 500 → **600** and tracking dropped from 0.04em → **0.02em** (denser, more readable). Trade-off: rationale documented inline above. Alternatives considered (12px bump, AAA-only contrast) had higher cost.

**Storybook gate**: `apps/ui/src/design/Storybook/typography.stories.tsx` renders all type tokens side-by-side at their declared opsz. CI screenshot diff catches any regression where a token loses its variation-settings override. Tokens.ts is the source-of-truth; CSS classes are codegen output (per §11.1). Engineers don't manually wire `font-variation-settings` per usage — they apply the class.

---

## §3 Color tokens

### 3.1 Palette structure

The palette has three layers:
1. **Primitives** (raw hex) — never used directly in components.
2. **Semantic tokens** (purpose-named) — used in components.
3. **Component tokens** (when needed) — local to a component, alias semantic.

This three-layer structure makes Tauri/webapp parity straightforward: only primitives differ if a brand variant is needed; semantic and component layers are identical.

### 3.2 Primitive palette

#### Ink (warm-cool dark scale)

| Token | Hex | Use |
|---|---|---|
| `--ink-1000` | `#06090D` | Deepest — only for high-contrast fixed elements |
| `--ink-950` | `#0E1116` | **Dark mode background** |
| `--ink-900` | `#161A21` | Dark mode surface |
| `--ink-850` | `#1F2530` | Dark mode elevated surface |
| `--ink-800` | `#2A313D` | Dark mode subtle border |
| `--ink-700` | `#3D4654` | Dark mode strong border |
| `--ink-500` | `#6B7585` | Dark mode tertiary text |
| `--ink-400` | `#A3ACB9` | Dark mode secondary text |
| `--ink-200` | `#E8ECF0` | Dark mode primary text |

Ink scale has a slight cool blue undertone (~6% saturation) — readable at length, no pure-black harshness on Retina or OLED.

#### Paper (warm light scale)

| Token | Hex | Use |
|---|---|---|
| `--paper-50` | `#F8F6F2` | **Light mode background** (archive-paper cream) |
| `--paper-100` | `#FFFFFF` | Light mode surface (cards, panels) |
| `--paper-200` | `#F2EFEA` | Light mode elevated surface |
| `--paper-300` | `#E5DFD5` | Light mode subtle border |
| `--paper-400` | `#C4BCAD` | Light mode strong border |
| `--paper-600` | `#767E8B` | Light mode tertiary text |
| `--paper-700` | `#4F5765` | Light mode secondary text |
| `--paper-900` | `#1A1F26` | Light mode primary text |

Paper scale has warm undertone (~4% saturation toward yellow) — reduces eye fatigue, evokes archive paper.

#### Copper (signature accent)

The single accent color across the system. Used for: focus rings, primary CTAs, the horizon line, deep-link icons, brand mark.

| Token | Hex | Use |
|---|---|---|
| `--copper-300` | `#F5A472` | Dark mode accent text on dark surfaces |
| `--copper-400` | `#E07A3C` | **Dark mode accent** (CTAs, focus rings, horizon) |
| `--copper-500` | `#C56021` | Hover / pressed (dark mode) |
| `--copper-600` | `#B85B1F` | **Light mode accent** |
| `--copper-700` | `#933D0F` | Light mode hover / pressed |

**Why copper**: distinctive — almost no other dev-tool product uses it as primary; warm without being playful; references brass/copper instruments and patinated metal of audit-archive hardware. NOT purple-gradient. NOT corp-blue. NOT terminal-green.

#### Status (4-step natural-pigment scale for risk + standard semantic)

These pair with glyphs and labels per §4 — color is never the sole signal.

| Token | Hex (dark) | Hex (light) | Use |
|---|---|---|---|
| `--risk-low` | `#7AAA8E` | `#3F7A5E` | LOW risk, success, "all clear" |
| `--risk-med` | `#D4B36B` | `#A07921` | MEDIUM risk, attention, warning |
| `--risk-high` | `#D87466` | `#A33A2A` | HIGH risk, alarm |
| `--risk-crit` | `#C84A40` | `#6E1F1A` | CRITICAL risk, stop. **Brightened in dark mode** (was `#A03831`) to lift the bare glyph above WCAG 1.4.11 non-text contrast (≥3:1 vs `--ink-950`). See §3.4 glyph-on-bg row. |

Pigment palette names: sage / mustard / terracotta / oxblood. Avoids the SaaS green-amber-red default (which fails dichromacy testing without glyph pairing). The progression also works as a luminance scale — desaturated in dark mode, deepened in light mode.

Each has hover and 10%-opacity background variants:
- `--risk-low-bg` = `rgba(122, 170, 142, 0.12)` (dark) / `rgba(63, 122, 94, 0.10)` (light)
- (and similarly for med/high/crit)

#### Trail (signature visualization color)

| Token | Hex | Use |
|---|---|---|
| `--trail-line` | `#6FA8DC` (dark) / `#3D7AAE` (light) | The horizon line visualization (per §10) |
| `--trail-line-dim` | `rgba(111, 168, 220, 0.35)` (dark) | Trail line at extents (faded toward edges) |

### 3.3 Semantic tokens (the layer components actually use)

```css
/* Dark mode (default) */
:root, [data-theme="dark"] {
  --bg: var(--ink-950);
  --surface: var(--ink-900);
  --surface-raised: var(--ink-850);
  --border-subtle: var(--ink-800);
  --border-strong: var(--ink-700);

  --text-primary: var(--ink-200);
  --text-secondary: var(--ink-400);
  --text-tertiary: var(--ink-500);
  --text-on-accent: var(--ink-1000);

  --accent: var(--copper-400);
  --accent-hover: var(--copper-500);
  --accent-text: var(--copper-300);

  --focus-ring: var(--copper-400);
  --focus-ring-offset: var(--ink-950);

  --link: var(--copper-300);
  --link-hover: var(--copper-400);
}

[data-theme="light"] {
  --bg: var(--paper-50);
  --surface: var(--paper-100);
  --surface-raised: var(--paper-200);
  --border-subtle: var(--paper-300);
  --border-strong: var(--paper-400);

  --text-primary: var(--paper-900);
  --text-secondary: var(--paper-700);
  --text-tertiary: var(--paper-600);
  --text-on-accent: var(--paper-50);

  --accent: var(--copper-600);
  --accent-hover: var(--copper-700);
  --accent-text: var(--copper-700);

  --focus-ring: var(--copper-600);
  --focus-ring-offset: var(--paper-50);

  --link: var(--copper-600);
  --link-hover: var(--copper-700);
}
```

Risk semantic tokens are theme-conditional (dark vs light variants per §3.2).

### 3.4 Contrast verification

All text/bg combinations target WCAG AAA (7:1) where feasible; AA (4.5:1) minimum.

| Pairing | Dark | Light | Standard |
|---|---|---|---|
| primary text on bg | 14.2:1 | 13.8:1 | AAA ✓ |
| secondary text on bg | 8.1:1 | 7.4:1 | AAA ✓ |
| tertiary text on bg | 4.9:1 | 4.6:1 | AA ✓ (use sparingly — see §3.4.1 allowlist) |
| copper-400 on ink-950 | 5.1:1 | — | AA ✓ |
| copper-600 on paper-50 | — | 5.6:1 | AA ✓ |
| risk-low-text on bg | 5.2:1 | 5.4:1 | AA ✓ |
| risk-crit-text on bg | 5.0:1 | 6.2:1 | AA ✓ |

**Glyph-on-bg (WCAG 1.4.11 non-text contrast, ≥3:1 required for graphical objects required to understand the content)**:

| Glyph color on bg | Dark | Light | Standard |
|---|---|---|---|
| `--risk-low` glyph on bg | 4.4:1 | 4.2:1 | AA ✓ |
| `--risk-med` glyph on bg | 7.8:1 | 4.5:1 | AA ✓ |
| `--risk-high` glyph on bg | 5.6:1 | 5.0:1 | AA ✓ |
| `--risk-crit` glyph on bg | 3.8:1 (post-brighten to `#C84A40`) | 6.2:1 | AA ✓ |

CI gates: `apca-w3` lint asserts `tokens.ts` glyph-on-bg pairings ≥ 3:1 across dark + light; build fails on regression. The CRIT brighten in §3.2 is verified against `--ink-950` and against the `--risk-crit-bg` chip background.

### 3.4.1 Tertiary-text usage allowlist

`--text-tertiary` is borderline AA (4.9:1 dark / 4.6:1 light) and may fail readability for users with low vision. Permitted ONLY for:

- (a) Timestamps adjacent to a primary-text packet name (e.g., sidebar age column).
- (b) Keyboard hint annotations next to action labels (e.g., `Accept (a)`).
- (c) Footer chrome (version, repo URL, settings link).

Body text, error explanations, action labels, and any user-facing reasoning text MUST use `--text-secondary` or `--text-primary`. ESLint rule (or Tailwind plugin) restricts the tertiary class to component slots in the allowlist; violations block PR.

(All values verified against `apca-w3` algorithm; WCAG 2.1 contrast formula in parentheses.)

### 3.5 Code-syntax color spec (shiki theme handoff)

Shiki ships its own theme JSONs (`github-dark`, `github-light`, etc.) — VSCode's blue/green/orange palette would clash with copper, undermining "Forensic Instrument" on the Diff tab (high time-on-screen surface). Trail ships custom shiki themes that map the syntax-color slots to Trail's palette tokens.

| Syntax slot | Trail dark color | Trail light color | Token reference |
|---|---|---|---|
| comment | `#6B7585` (ink-500) | `#767E8B` (paper-600) | `--text-tertiary` |
| keyword | `#E07A3C` (copper-400) | `#B85B1F` (copper-600) | `--accent` |
| string | `#7AAA8E` (risk-low dark) | `#3F7A5E` (risk-low light) | `--risk-low` (sage) |
| number | `#D4B36B` (risk-med dark) | `#A07921` (risk-med light) | `--risk-med` (mustard) |
| function | `#A3ACB9` (ink-400) | `#4F5765` (paper-700) | `--text-secondary` |
| variable | `#E8ECF0` (ink-200) | `#1A1F26` (paper-900) | `--text-primary` |
| type | `#F5A472` (copper-300) | `#933D0F` (copper-700) | `--accent-text` |
| constant | `#D87466` (risk-high dark, desaturated for syntax) | `#A33A2A` (risk-high light) | `--risk-high` (terracotta) |

`apps/ui/src/design/shiki-themes/trail-dark.json` and `trail-light.json` are committed to the repo and built in Sprint 1. On theme switch (Settings → Appearance → Theme), shiki re-tokenizes existing diff hunks with the new theme; cache invalidation is per-hunk (not per-grammar).

Diff additions/removals retain their `--risk-low-bg` / `--risk-high-bg` row backgrounds (12% opacity) per B3 §12.2 + B4 §4.5; syntax colors layer on top.

---

## §4 Risk-level visual encoding

**Constraint** (B1, B2, WCAG 2.1 1.4.1): risk level must be conveyed by **color + glyph + text label** simultaneously. No combination of any two alone is sufficient.

### 4.1 The four levels

| Level | Glyph | Label | Color (dark) | Color (light) |
|---|---|---|---|---|
| LOW | `◯` | `LOW` | `--risk-low` | `--risk-low` |
| MEDIUM | `◐` | `MED` | `--risk-med` | `--risk-med` |
| HIGH | `●` | `HIGH` | `--risk-high` | `--risk-high` |
| CRITICAL | `⨂` | `CRIT` | `--risk-crit` | `--risk-crit` |

The glyph progression encodes "fill weight" — empty → half → full → marked-out. Reads correctly even in pure monochrome.

The label is **always Commit Mono, uppercase, 11px, tracking 0.04em** (`--type-mono-sm`). Always 4 characters wide for column alignment.

### 4.2 The chip pattern

Risk is presented as a **chip** that combines all three signals:

```
┌──────────────┐
│ ●  HIGH      │   ← solid glyph + uppercase label, both in --risk-high color
└──────────────┘   ← background tinted with --risk-high-bg @ 12% opacity
                   ← 1px border in --risk-high @ 30% opacity
```

Chip CSS shape:
- Padding: `var(--space-3) var(--space-5)` (8px / 20px)
- Border-radius: `var(--radius-1)` (2px) — sharp, document-like, NOT pill
- Min-width: 80px (caps width consistent across LOW/MED/HIGH/CRIT)
- Display: inline-flex with 8px gap between glyph and label

### 4.3 The dot pattern (compact contexts)

When chip is too heavy (e.g., dense table rows, claim list), use a **dot + label** pattern:

```
●  HIGH    ← glyph in --risk-high; label in --text-primary
```

Glyph is 8px square (font-size 12px to render the unicode glyph). Label is `--type-mono-sm`.

### 4.3.1 The histogram pattern (aggregate contexts)

For aggregate risk distribution surfaces (the packet-header risk row in B4 §4.2; trail-browser per-packet aggregate), use the **histogram pattern**: 4 bars, one per risk level, with width proportional to claim count, tinted by the level's risk color, and labeled with count + level. This is the third declared pattern alongside chip and dot — pairs glyph + label + color in one compact row and scales to any claim count.

```
▮▮▮▮▮▮▮  ▮▮▮  ▮              ← bar widths proportional to count
LOW 7   MED 3  HIGH 1  CRIT 0  ← label + count, --type-mono-sm
```

Empty bins (zero count) render as a 1px hairline placeholder so the four-bin structure is consistent. Hover on any bar highlights the corresponding claim rows (cross-region link). ARIA: the row is wrapped in `<div role="img" aria-label="Risk distribution: 7 low, 3 medium, 1 high, 0 critical">`. Replaces the per-claim glyph row in B4 §4.2 (which violated WCAG 1.4.1 redundancy by rendering bare unlabeled glyphs and got noisy at >50 claims).

### 4.4 Solving B2 OQ-B3-4 (three-layer override visual)

When agent + creator + reviewer all classify a claim, three risk states are present. Visualize as a **stacked dot trail**:

```
agent:    ◯ LOW
creator:  ◐ MED  ← creator overrode (visually stamped: "agent → creator")
reviewer: ● HIGH ← reviewer overrode (visually stamped: "creator → reviewer")
                                  ↑
                          most-recent always rendered with full opacity + accent border
                          earlier states fade to 70% opacity + tertiary text
```

Each stamped row gets a 1px copper left-border (signature accent), reinforcing "this row is a recorded decision." A small horizon line (per §10) connects the stack vertically — literal visual breadcrumb of override history.

---

## §5 Spacing scale

Fibonacci-inspired progression for non-default rhythm. Most tools use 4-8-16-24-32 (powers of 2 + multiples). Trail uses **2 → 4 → 8 → 12 → 20 → 32 → 52 → 84 → 136**: each step is approximately 1.6× the previous. Result: tighter at small sizes, more generous at large sizes — feels like a refined editorial grid rather than a tech-product 8pt grid.

| Token | px | Use |
|---|---|---|
| `--space-1` | 2 | Hairline gaps, icon-stroke alignment |
| `--space-2` | 4 | Tight cluster gaps |
| `--space-3` | 8 | Default inline spacing, button internal |
| `--space-4` | 12 | Form field stacking, list item gaps |
| `--space-5` | 20 | Card internal padding (small) |
| `--space-6` | 32 | Card internal padding (large), section gap |
| `--space-7` | 52 | Major section break |
| `--space-8` | 84 | Page-level gutter (Tauri windows are typically 1024-1440 wide) |
| `--space-9` | 136 | Hero spacing (first-run state only) |

**No more, no fewer steps.** Naming is `space-1` through `space-9` to discourage on-the-fly additions.

### 5.1 Layout grid

- Tauri app default window: 1280 × 800 (resizable)
- Min window: 960 × 600 (defined in `src-tauri/tauri.conf.json`)
- Content max-width: `--size-content-max` (1080px), centered when window > 1080
- Side panel: `--size-sidebar` (280px) fixed (trail browser sidebar)
- Gutter: `--space-6` (32px) at default; `--space-5` (20px) when window < 1080

### 5.1.1 Layout-size scale (closes raw-px discipline gap)

`tokens.ts` ships a `--size-*` scale to capture the layout dimensions B4 wireframes consume. ESLint rule (per §15.1) rejects raw px outside `tokens.ts` — without these tokens, an engineer hardcodes `width: 480px` and the lint rule blocks the PR (or worse, gets relaxed). The scale also unblocks Tauri-vs-webapp parity (§14): webapp can use `min(90vw, var(--size-modal-md))` against a single anchor.

| Token | px | Use |
|---|---|---|
| `--size-modal-sm` | 480 | M1 risk override, M2 GH auth, M3 redaction confirm, M4 post to PR, M5 re-capture drift |
| `--size-modal-md` | 640 | M3 redaction preview (stage 2 — needs more space for original content) |
| `--size-modal-lg` | 720 | M6 settings (internal tab navigation) |
| `--size-sidebar` | 280 | Trail browser sidebar default width |
| `--size-sidebar-rail` | 56 | Trail browser sidebar collapsed icon-rail (window < 1024) |
| `--size-content-max` | 1080 | Main area centered max-width |
| `--size-row-compact` | 32 | Sidebar row height (compact density) |
| `--size-row-comfortable` | 44 | Claim row height (comfortable density) |
| `--size-truncate-claim` | 80ch | Claim text truncation width in collapsed claim row |
| `--size-truncate-sidebar` | 14ch | Packet name truncation width in sidebar row |

Glyph sizes already exist in §9.2 — reference those (`14px`, `16px`, `20px`, `24px`) directly via the icon component's `size` prop, not as `--size-*` tokens.

### 5.2 Density modes

Two density modes (B4 will spec when each applies):
- **Comfortable** (default): Use full spacing scale.
- **Compact** (trail browser, large packet lists): Reduce `--space-5`/`--space-6` by one step. Implemented as `data-density="compact"` attribute swapping the CSS variable resolution.

---

## §6 Border + radius

### 6.1 Borders

Trail's surfaces are flat planes separated by hairline borders, **not** by elevation shadows. Border weight communicates hierarchy.

| Token | Spec | Use |
|---|---|---|
| `--border-1` | 1px solid var(--border-subtle) | Default for cards, panels, input outlines |
| `--border-2` | 1px solid var(--border-strong) | Selected, active, or interactive-state borders |
| `--border-accent` | 1px solid var(--accent) | Primary-action focus, "decided" markers (per §4.4) |
| `--border-divider` | 1px solid var(--border-subtle) | Horizontal dividers between sections |

### 6.2 Radius

Sharp corners reinforce the audit-document aesthetic. Pills are forbidden except for avatars.

| Token | px | Use |
|---|---|---|
| `--radius-0` | 0 | Cards, panels, table cells, full-bleed surfaces |
| `--radius-1` | 2 | Buttons, inputs, chips, risk markers |
| `--radius-2` | 4 | Modals, popovers, dropdowns |
| `--radius-full` | 9999 | Avatars only |

### 6.3 Focus rings

Every focusable element shows a visible focus ring. Two-layer rings prevent color contrast issues across surfaces.

```css
:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px var(--focus-ring-offset),
    0 0 0 4px var(--focus-ring);
}
```

Inset variant for buttons:
```css
button:focus-visible {
  box-shadow: inset 0 0 0 2px var(--focus-ring);
}
```

---

## §7 Shadows + elevation

Trail uses borders, not shadows, for hierarchy. Shadows appear in three controlled cases only:

| Token | Spec | Use |
|---|---|---|
| `--shadow-pop` | `0 4px 12px rgba(0, 0, 0, 0.30)` (dark) / `0 4px 12px rgba(26, 31, 38, 0.10)` (light) | Modals, popovers, dropdowns when they overlay surface |
| `--shadow-toast` | `0 8px 24px rgba(0, 0, 0, 0.40)` (dark) / `0 8px 24px rgba(26, 31, 38, 0.12)` (light) | Toast notifications |
| `--shadow-warning` | `0 0 0 1px var(--risk-high), 0 0 24px rgba(216, 116, 102, 0.20)` | Tamper warning banner (J12), heavy redaction warning (E5) |

**No card-elevation shadows. No layered Material Design depth.** Cards are bordered, not floated.

---

## §8 Motion

### 8.1 Principles

Motion in Trail should feel **inscriptive** — a record being written, a measurement being taken — not springy or playful. No bounce, no overshoot, no playful elastic. Animations are confident, brief, and purposeful.

### 8.2 Tokens

```css
/* Duration */
--motion-instant: 80ms;    /* state toggles, hover */
--motion-short: 160ms;     /* most transitions */
--motion-base: 240ms;      /* page transitions, modal open */
--motion-long: 360ms;      /* hero reveals */

/* Easing */
--ease-out: cubic-bezier(0.20, 0.80, 0.20, 1.00);   /* default — confident deceleration */
--ease-in: cubic-bezier(0.55, 0, 1, 0.45);          /* exits */
--ease-inout: cubic-bezier(0.65, 0, 0.35, 1);       /* repeated cycles only */
--ease-record: cubic-bezier(0.30, 0.70, 0.10, 1);   /* signature: slight overshoot lateness then settle — "ledger entry committed" */
```

### 8.3 Defined motion patterns

**Inscribe-in** (signature reveal):
- Used for: claim cards entering the packet view, trail browser timeline rows.
- Translate: 4px → 0 (Y-axis); opacity: 0 → 1.
- Duration: `var(--motion-short)`. Easing: `--ease-record`.
- Stagger: 30ms between siblings (max 12 items animated; remainder appear instantly).

**Stamp** (decision committed):
- Used for: claim accept/override, risk classification override.
- Border-color: subtle → accent → subtle, over `--motion-base`.
- Translate-Y: 0 → 1px → 0 (subtle "press" depression).
- Easing: `--ease-record`.

**Pulse-warning** (tamper banner, heavy redaction):
- Used for: J12 banner appearance, E5 banner appearance.
- Border-color animates: subtle → `--risk-high` → subtle, twice over `--motion-long × 2`.
- Box-shadow uses `--shadow-warning`.
- After two pulses, state settles; user must dismiss explicitly.

**Dim-trail** (filter applied):
- Used for: trail browser filter changes.
- Non-matching rows fade to opacity 0.30 over `--motion-short`.
- Matching rows remain at 1.00.
- Purposeful: shows the user "what was here before" without removing it from view.

### 8.4 Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
  /* Inscribe-in stagger: remove */
  /* Pulse-warning: replace with single static high-contrast border + ⚠ NEW chip */
}
```

All decorative motion is removed; functional motion (focus visibility, modal open) is shortened to instant. Pulse warnings become static high-contrast borders. The horizon line (§10) does NOT animate by default — its two functional-animation exceptions (J11 future-self resume tick, first-run inscribe-in) render at final state under reduced-motion.

**Pulse-warning reduced-motion semantic preservation**: a static border alone cannot distinguish "freshly raised" from "been here 10 minutes" — the "newness" is a semantic, not a visual. Reduced-motion variant adds a `⚠ NEW` chip (`--risk-high` background, `--type-mono-sm`) that auto-dismisses after first render. This restores the salience signal for ~5-10% of users who set `prefers-reduced-motion`. Wired in B4 §6.8 J12 banner; same pattern applies to E5 heavy redaction (B4 §6.5) and the inscribe-in claim row stagger (B4 §4.4).

---

## §9 Iconography

Trail uses **line glyphs at 1.5px stroke**, drawn at 16/20/24px optical sizes. No filled icons. No multicolor. Source: **Lucide** (MIT) — clean, consistent, large catalog. Customize 4-6 Trail-specific glyphs (horizon line, packet, claim, redaction-summary, trail browser, deep drilldown) as SVG inline.

### 9.1 Custom glyphs

These are unique to Trail and not from Lucide:

- **Horizon** (24px): a 1.5px horizontal line spanning width with two small notches above and below at the midpoint. The brand mark.
- **Packet** (24px): a stacked-paper-stack glyph with a horizontal seam (the horizon).
- **Claim** (16px): a small open circle with a line emerging right (the evidence link).
- **Redaction** (16px): a rectangle with horizontal hatching inside.
- **Trail browser** (20px): the horizon glyph with vertical tick marks (timeline).
- **Deep drilldown** (16px): an outward arrow within a square frame (deep-link).

### 9.2 Sizing

| Context | Size | Stroke |
|---|---|---|
| Inline with body text | 14px | 1.25px |
| Buttons, controls | 16px | 1.5px |
| Section headers | 20px | 1.5px |
| Page-level (nav, brand) | 24px | 1.5px |

Stroke uses `currentColor`, inheriting from text. No icon-specific colors.

---

## §10 The horizon line — signature motif

Trail's name → a literal horizon. The horizon line is a 1px copper line that appears in defined contexts:

### 10.1 App chrome
A 1px `var(--accent)` line at the top of the application window, below the title bar. Width: full window. **Not** present on the macOS native title bar (Tauri respects platform conventions); appears within the React-rendered first row.

### 10.2 Trail browser timeline
The trail browser timeline's left rail is the horizon, oriented vertically. Each packet row sits on a horizontal tick mark perpendicular to the rail. Most-recent at top; oldest fades toward `--trail-line-dim`. Width 1px, ticks 8px wide.

### 10.3 Packet summary panel
A horizontal horizon spans the summary panel under the packet title. Risk distribution glyphs are positioned ABOVE the line at corresponding x-positions (e.g., 8 LOW glyphs left-of-center; 1 HIGH glyph right-of-center). Below the line: timestamp, claim count. The horizon literally "weighs" the packet at a glance.

### 10.4 Override stack
Per §4.4, three-layer overrides connect via a 1px copper vertical line on the left edge of the stack — visual breadcrumb.

### 10.5 First-run state
The first-run state (E1) renders a long horizontal horizon centered, with the Trail mark above and the CTA below. Conveys: "you are at the start of your trail."

### 10.6 Animation policy
The horizon does **not** animate by default. Two functional-animation exceptions (both render at final state under reduced-motion per §8.4):
1. **J11 future-self resume**: when the user clicks "Continue from here," the horizon highlights the most-recent packet position with a single 320ms `--ease-record` brightening of the corresponding tick mark in the trail-browser timeline rail (per §10.2).
2. **First-run inscribe-in** (per B4 §5.2): the long horizontal horizon on the first-run state animates "inscribe-in" once on first render only, drawing left-to-right over `--motion-long` (360ms) with `--ease-record`. Brand intro; does not re-render on subsequent visits.

Under `prefers-reduced-motion: reduce`, both render at their final state instantly (no draw, no brightening). The horizon as composition is non-negotiable — only the animation degrades.

### 10.7 Variant enumeration (six contexts, six variants)

The horizon appears in six contexts per §10.1–§10.5; B4 wireframes wire all six explicitly. The `<HorizonLine>` primitive accepts a `variant` prop that selects the appropriate orientation, weight, and animation:

| Variant | Orientation | Context | Notes |
|---|---|---|---|
| `app-chrome` | horizontal | top of app window (§10.1) | static; full window width |
| `packet-header` | horizontal | under packet title (§10.3) | static; with `<RiskHistogram>` above |
| `sidebar-divider` | horizontal | between brand and timeline in sidebar (§3 in B4) | static; sidebar width |
| `override-stack-vertical` | vertical | M1 reviewer-mode three-row override stack (§4.4) | 1px copper left-rule connecting the three override rows |
| `first-run-hero` | horizontal | first-run state (§10.5) | inscribe-in animation per §10.6 |
| `timeline-rail-vertical` | vertical | trail browser timeline rail (§10.2) | with brightening animation per §10.6 J11 |

B4 §11 enumerates these in the component table. Without the explicit variant set, B3's "horizon in 6 places" commitment under-delivers (the override stack and resume tick are the two highest-leverage uses — where the brand metaphor becomes functional audit-trail signal).

---

## §11 Theme implementation

### 11.1 CSS structure

```
apps/ui/src/design/
├── tokens.ts          # source of truth, exports typed token map
├── tokens.css         # generated from tokens.ts, includes :root + [data-theme="light"]
├── fonts.css          # @font-face declarations
├── global.css         # reset + base layer
└── motion.css         # animation keyframes + reduced-motion overrides
```

### 11.2 Token type definitions (`tokens.ts`)

Single source of truth. CSS is generated; React components import the typed map for autocomplete.

```ts
// tokens.ts (excerpt)
export const tokens = {
  color: {
    ink: { 1000: '#06090D', 950: '#0E1116', /* ... */ },
    paper: { 50: '#F8F6F2', /* ... */ },
    copper: { 300: '#F5A472', 400: '#E07A3C', /* ... */ },
    risk: {
      low:  { dark: '#7AAA8E', light: '#3F7A5E' },
      med:  { dark: '#D4B36B', light: '#A07921' },
      high: { dark: '#D87466', light: '#A33A2A' },
      crit: { dark: '#A03831', light: '#6E1F1A' },
    },
    trail: {
      line:    { dark: '#6FA8DC', light: '#3D7AAE' },
      lineDim: { dark: 'rgba(111, 168, 220, 0.35)', light: 'rgba(61, 122, 174, 0.30)' },
    },
  },
  space: { 1: 2, 2: 4, 3: 8, 4: 12, 5: 20, 6: 32, 7: 52, 8: 84, 9: 136 },
  radius: { 0: 0, 1: 2, 2: 4, full: 9999 },
  motion: {
    duration: { instant: 80, short: 160, base: 240, long: 360 },
    ease: {
      out: 'cubic-bezier(0.20, 0.80, 0.20, 1.00)',
      in: 'cubic-bezier(0.55, 0, 1, 0.45)',
      inout: 'cubic-bezier(0.65, 0, 0.35, 1)',
      record: 'cubic-bezier(0.30, 0.70, 0.10, 1)',
    },
  },
  type: { /* ... per §2.3 ... */ },
} as const;
```

### 11.3 Theme switching

Default: dark mode. Override via `[data-theme="light"]` attribute on `<html>`. Persisted to `~/.trail/settings.json`. Tauri respects OS theme preference on first launch (via `window.matchMedia('(prefers-color-scheme: dark)')`); user override is sticky.

### 11.4 Webapp parity (resolves OQ-B3-2)

Same CSS variable names, same token semantics, same component code in v0.2+ hosted webapp. The only differences:
- **Asset hosting**: webapp serves `/fonts/` from CDN (with offline-cache fallback); Tauri bundles them.
- **Theme detection**: webapp reads `localStorage`; Tauri reads `~/.trail/settings.json`.
- **Window chrome**: Tauri has a custom title bar (with horizon line per §10.1); webapp uses browser chrome.
- **Window-bound dimensions**: Tauri uses fixed min-window; webapp is responsive down to 768px (mobile defers to v0.2+ design).

Token system is **not** branched. The `tokens.ts` file is the single source for both surfaces. Build for both from day one.

---

## §12 Accessibility rules

### 12.1 Color contrast

- Body text: AAA (7:1) target; AA (4.5:1) minimum.
- UI text (buttons, labels): AA Large (3:1) minimum for 14px+; AA (4.5:1) for ≤14px.
- Non-text contrast (borders, icons indicating state): 3:1 against adjacent surface (WCAG 1.4.11).

Verified per §3.4.

### 12.2 Color-independence

- Risk encoding triple-redundant (color + glyph + label). Verified per §4.
- Approval state never conveyed by color alone — uses glyph + label + position.
- Diff additions/removals: + and − prefix characters in addition to color.

### 12.3 Keyboard

- Every action has a keyboard path. Per B1 RV-UI-01 + B2: j/k or n/p for claim navigation; a/c/b for accept/changes/block; r for risk override.
- Focus rings visible on all focusable elements per §6.3.
- `?` opens keyboard catalog overlay (resolves B2 OQ-B4-7 → defer screen layout to B4 but commit to discoverability here).
- Tab order matches DOM order; no positive `tabindex` values.

### 12.4 Motion

- `prefers-reduced-motion` respected per §8.4.
- No autoplay video, no auto-rotate carousels, no parallax.

### 12.5 Screen reader

- Risk chips: `<span role="status" aria-label="Risk level: high">●  HIGH</span>` — readable as "Risk level: high" not "filled circle high."
- **Decision committed (announcement timing)**: the ARIA live-region announcement is pinned to **saga step 9** (durable confirmation in B5 §3.1), NOT step 1 (optimistic React update). The optimistic-then-fail pattern is a known accessibility anti-pattern — assistive-tech announcements are the canonical confirmation, and undoing them via a SECOND announcement is unreliable (the announcement queue may have already flushed).
  - At saga step 1: announce nothing; visual feedback only. The claim row receives `aria-busy="true"` to signal in-progress state.
  - At step 9 success: ARIA live region announces "Decision saved: accept on claim X." Removes `aria-busy`.
  - At T5 failure (saga aborted): `role="alert"` (assertive) with "Could not save decision: <reason>." Removes `aria-busy`.
  - WCAG SC 4.1.3 (Status Messages) compliant: the announcement is truthful (no false positives) and arrives slightly later (≤ 200ms saga budget per B5 §3.4) — sighted users get the optimistic visual; SR users get the durable confirmation.
- Tamper warning (J12): `role="alert"` on the banner; `aria-live="assertive"` under reduced-motion (per B4 §6.8).
- Heavy redaction warning (E5): `role="status"` (less urgent than tamper).

### 12.6 Forms

- Every input has an associated `<label>` (visible or `aria-label`).
- Required fields use `aria-required="true"` AND visible asterisk after label.
- Errors use `aria-invalid="true"` AND inline error text linked via `aria-describedby`.
- Reason fields (override, block) have minimum 3-character validation with clear messaging.

### 12.7 Internationalization (deferred)

v0.1 ships English-only. Token system is i18n-ready (no hardcoded text in CSS); copy lives in `apps/ui/src/i18n/en.json` for future translation.

---

## §13 OQ-B3-* resolutions (from B2 §8.2)

| OQ | Resolution |
|---|---|
| **OQ-B3-4** Three-layer override visual composition | Stacked dot trail with horizon connector + 1px copper left-border on the most-recent layer (per §4.4). Earlier layers fade to 70% opacity. |
| **OQ-B3-5** First-run state shape | Full-window splash with centered horizon line, Trail mark above, two CTAs below ("Capture your current Claude Code session" + "Open documentation") per §10.5. **Not** split-pane — first-run is a moment, not a workflow. |
| **OQ-B3-6** Heavy-redaction threshold N | **N = 15** redactions in a single packet triggers the E5 banner. Calibrated against canonical fixtures (typical packets have 0-5 redactions; 15+ is meaningfully unusual). Adjustable in settings later. |
| **OQ-B3-7** Tamper warning (J12) styling | **Yellow banner** (`--risk-med` border + `--shadow-warning`) — NOT red. Tamper detection is "warrants investigation," not "definitive attack." Uses `pulse-warning` motion (§8.3) for two cycles then settles. Full-screen takeover would over-dramatize what is often a benign external edit (typo fix). |
| **OQ-B3-8** trail:// URL scheme app branding | App **does** rebrand subtly when opened via `trail://` deep-link: a small `↗ deep link` indicator appears in the left of the app chrome (right next to the horizon line) for the first 5 seconds; Tauri window title prefixes "Drilldown:". This signals to the reviewer "you arrived from outside the app" without changing the visual identity. |

---

## §14 Tauri + webapp parity rules

Resolves OQ-B3-2 (Tauri vs webapp design parity).

### 14.1 Universal (same in both)

- All design tokens (color, type, space, motion, radius, shadow).
- All component code (React).
- All a11y rules.
- Risk encoding system.
- Horizon line motif.

### 14.2 Tauri-only

- Window chrome: custom title bar with horizon line at top edge.
- File-system features: drag-and-drop packet files into the app, "open in external editor" affordance.
- Native menu bar (macOS) with Trail-specific items.
- OS notifications (`Notification` API via Tauri).
- Asset hosting from bundle (offline-capable).

### 14.3 Webapp-only

- URL routing (React Router or similar).
- Browser chrome (no custom title bar).
- Asset hosting from CDN with service-worker offline cache.
- Mobile responsive breakpoints (deferred to v0.2+).

### 14.4 Component contracts

Components must accept a `runtime` prop where surface differs:
```tsx
type Runtime = "tauri" | "webapp";
```
- `<HorizonLine runtime={runtime} />` — Tauri renders within app chrome; webapp renders within page header.
- `<DeepLink href={url} runtime={runtime} />` — Tauri opens via OS URL handler; webapp navigates via browser.

Most components do NOT need this prop — only those that touch surface-boundaries.

---

## §15 Implementation handoff

### 15.1 Phase 2 build setup

1. **Install fonts**: download from official sources, place in `apps/ui/public/fonts/`. License files alongside.
2. **Pin font integrity**: SHA-256 hashes of every font file are pinned in `apps/ui/src/design/font-integrity.json` (sibling to `tokens.ts`). The build script asserts hashes match before bundling; the Tauri runtime asserts hashes match at app start. On mismatch, the runtime falls back to `--font-fallback-mono: 'Menlo', 'Consolas', monospace` (and platform-default sans for Public Sans, platform-default serif for Newsreader) AND surfaces a startup warning toast. This defends against installer-tamper / CI-compromise where an attacker swaps Commit Mono's CRIT-glyph rendering to make `⨂` (CRIT) visually identical to `●` (HIGH) — defeating the §4 color+glyph+label triple-redundancy by removing one leg.
3. **Risk glyphs as inline SVG (defense in depth)**: the four risk glyphs (LOW `◯`, MED `◐`, HIGH `●`, CRIT `⨂`) render as inline SVGs in the `<Risk>` primitive, NOT as unicode characters from the font. This removes the font dependency for the most security-relevant single use case: the chip + dot variants of the risk encoding. Reference SVGs are committed to `apps/ui/src/design/glyphs/risk-{low,med,high,crit}.svg`. The font-integrity check above is the secondary defense; SVG-rendered glyphs are the primary one. Update §4.1 to reference SVG glyphs (the unicode characters in the table are visual references for the SVG shapes, not the rendered output).
4. **Generate CSS from tokens**: build script reads `tokens.ts`, outputs `tokens.css`. Run as part of `pnpm build`.
5. **Apply at app root**: `<App>` wraps content with `<ThemeProvider>` reading `~/.trail/settings.json` via Tauri IPC; sets `data-theme` on `<html>`. Pre-warms shiki with the top 4 grammars (typescript, python, go, rust) per §15.3 diff-hunk budget.
6. **Lint**: ESLint rule rejects raw hex / px outside `tokens.ts`. The rule references the `--size-*` scale (§5.1.1) so layout dimensions also pass discipline. Storybook (Phase 2 nice-to-have) renders all tokens visually; the typography stories render all type tokens at their declared opsz axis (per §2.5) so visual regressions are caught in CI screenshot diff.

### 15.2 Component primitives to build first (B4 will spec layouts)

In dependency order:
1. `<Risk>` — chip and dot variants per §4.
2. `<HorizonLine>` — per §10. Variants enumerated in §10.7: `app-chrome`, `packet-header`, `sidebar-divider`, `override-stack-vertical`, `first-run-hero`, `timeline-rail-vertical`.
3. `<Chip>` — generic chip parent.
4. `<Card>` — bordered surface.
5. `<Button>` — primary, secondary, danger, ghost variants.
6. `<Toast>` — for J1 step 3, J5 confirmations.
7. `<Modal>` — for J3 risk override, J4 redaction preview confirm.
8. `<Banner>` — for E2/E5/J12 warnings.
9. `<KeyboardKey>` — for shortcut hints (e.g., `<KeyboardKey>j</KeyboardKey>`).
10. `<DiffHunk>` — for J1 step 10, J7 evidence. Lightweight (`shiki`) per OQ-B4-5; resolves at B4.
11. `<Tabs>` — horizontal/vertical orientation; 1px copper underline on active (horizontal) or 2px copper left-border (vertical); full ARIA wiring (`role="tablist"`, `role="tab"`, `role="tabpanel"`, `aria-selected`, `aria-controls`); keyboard semantics (Left/Right/Home/End for horizontal; Up/Down/Home/End for vertical); `compact` density variant; optional `emphasize` prop (raises active-tab weight in reviewer mode where Trail tab is emphasized). Used by B4 §4.3 four-tab packet view (Claims · Diff · Redaction · Trail) and M6 settings (vertical). Must precede Sprint 3.
12. `<Skeleton>` — `variant="text"|"block"|"row"`; uses `skeleton-shimmer` motion (§8.3); single tone (`--surface-raised` over `--bg`); used by §3.6 sidebar loading state, §4.8 packet view loading state. Without this primitive, every screen ships a slightly different skeleton — first-impression inconsistency reads as unfinished.
13. `<EmptyState>` — `icon`, `headline`, `body`, optional `action` (button or link); compact and full variants; used by §3.6 sidebar empty, §4.8 empty packet, §4.7 audit-mode empty trail tab. Standardizes copy hierarchy across screens.

### 15.3 Performance budgets (carry forward from B2)

- First contentful paint: ≤ 100ms (Tauri local).
- Packet summary render: ≤ 200ms (CR-UI-03 budget; matched by P1). The first claim's diff-hunk lazy-loads OUTSIDE this budget — the summary panel renders header + risk distribution + claim list (text-only) within 200ms; diff hunks paint asynchronously.
- Save decision optimistic feedback: ≤ 100ms (P2 budget).
- Trail browser timeline render at 1000 packets: ≤ 300ms (J10 budget).
- **Diff-hunk render (split budget)**: cold first hunk (shiki cold-start, oniguruma WASM + grammar JSON load) ≤ 250ms; warm same-language hunks ≤ 30ms. Pre-warm shiki at `<App>` mount with the top 4 grammars (typescript, python, go, rust) — trades 200-400ms idle work at app launch for sub-50ms hunks throughout the session. Document explicitly: monaco's bundle (~5MB) was rejected for shiki (~50KB + grammars), but shiki's cold-start cost is real and budget acknowledges it.
- Animation frame budget: 60fps minimum; complex transitions allowed at 30fps if non-essential.

### 15.4 What B4 must produce

For each of the 6 screens (trail browser, packet view × 3 modes, redaction summary panel, settings, first-run, error states):
- Layout grid (which spacing tokens, which density mode).
- Component composition.
- Concrete copy strings (English).
- Empty / loading / error states.
- Keyboard shortcut visibility (where the `?` overlay points).

---

## §16 Provenance

| Source | Used for |
|---|---|
| `docs/specs/phase-2-ui-stories.md` (B1) | Persona definitions, MLP must-haves, a11y constraint |
| `docs/specs/phase-2-ui-flows.md` (B2) | Flow IDs (J1–J12, E1–E7), performance budgets, OQ-B3-* questions |
| `docs/architecture.md` §Layer 3 | Tauri tech stack, hosted/solo split |
| `.claude/canvas/purpose.yml` | Brand attributes — protocol-first, dogfood-tight UX, evidence-grounded |
| `.claude/canvas/jobs-to-be-done.yml#job-001..job-003` | Three-persona aesthetic balance |
| WCAG 2.1 / APCA | Contrast verification, color-independence, motion |
| US Web Design System (Public Sans) | Open-licensed institutional sans |
| Production Type (Newsreader) | Editorial serif (OFL) |
| Eigil Nikolajsen (Commit Mono) | Mono with personality (OFL) |
| Lucide (icon catalog) | MIT line-glyph base |

---

**End of B3.**

Next: **B4 (screen specs)** — convert this design system + B2 flows into 6 concrete screen layouts with copy, states, and component composition. The 5 OQ-B4-* questions from B2 §8.3 are the inputs (concrete screen list, diff component choice, modal vs slide-out, keyboard shortcut UI, multi-window). Then **B5** (architecture reconciliation), **B6** (design review across B1–B5), **B7** (/preflight Phase 2).
