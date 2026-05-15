# Phase 2 UI — Screen Specs (B4)

**Status**: B4 draft
**Date**: 2026-05-09
**Authoritative**: this document
**Scope**: Phase 2 (Tauri + React + Vite, v0.1 OSS MLP)
**Blocks**: B5 (architecture reconciliation), B6 (design review), Phase 2 build (#22)
**Blocked by**: B1, B2, B3 ✓
**Companion specs**:
- B1 stories: `docs/specs/phase-2-ui-stories.md`
- B2 flows: `docs/specs/phase-2-ui-flows.md`
- B3 design system: `docs/specs/phase-2-design-system.md`

---

## §1 Application architecture

### 1.1 Window structure

```
┌─────────────────────────────────────────────────────────────┐
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │  ← horizon line (1px copper)
│  Trail · trail/                              ⌘ , settings   │  ← top bar
├──────────┬──────────────────────────────────────────────────┤
│          │                                                  │
│  Trail   │                                                  │
│  browser │              MAIN AREA                           │
│          │              (packet view, first-run,            │
│  280px   │               or modal overlay backdrop)         │
│  fixed   │                                                  │
│          │                                                  │
│          │                                                  │
└──────────┴──────────────────────────────────────────────────┘
                      ↑ status bar (toasts dock here, bottom-right)
```

### 1.2 Persistent regions

| Region | Width | Always visible? | Content |
|---|---|---|---|
| **Top bar** | full | yes | App brand · current packet breadcrumb · settings cog · theme toggle |
| **Horizon line** | full | yes | 1px copper rule, integrated into top bar (per B3 §10.1) |
| **Trail sidebar** | 280px (collapses to 56px icon-rail at window < 1024) | yes | Compact timeline, "your recent sessions" pin, filter tray |
| **Main area** | flex (max 1080) | yes | One of: packet view (3 modes), first-run state, error state |
| **Toast layer** | absolute bottom-right | when active | Transient confirmations, errors |
| **Modal layer** | full overlay | when active | Backdrops main area; focuses on a decision |

### 1.3 Navigation model

Single-window per OQ-B4-8 resolution. The app maintains an internal navigation history (back / forward) for the main area. Keyboard shortcuts: `[` back, `]` forward. The trail sidebar is the persistent "home" navigation; clicking any packet replaces the main area content.

**No multi-window v0.1.** Comparing packets side-by-side is v0.2+. The single-window model keeps keyboard shortcut scope unambiguous (focus is always one packet at a time).

### 1.4 Routing (internal, not URL-routed)

| Route key | Main area content |
|---|---|
| `/` | Trail browser empty state OR most-recent-packet overview if available |
| `/packet/<session-id>/<packet-id>` | Packet view (mode determined by `?mode=` param: creator / reviewer / audit) |
| `/first-run` | First-run E1 state |
| `/settings` (modal, not screen) | Settings modal — does not change route |

**Mode resolution rules** (resolves the J6→J7 arrival ambiguity; the YAML carries no current-user role, so the spec must pin where `mode=` comes from):

(a) **Settings stores per-user default**: on first launch, the user's identity is read from `git config user.email`. For each opened packet, the default mode is computed:
- `creator` if `packet._meta.created_by` matches the user's identity.
- `reviewer` if it does not match.
- `audit` is **never auto-entered** — it is a deliberate toggle.

(b) **Phase 3b markdown emits explicit `?mode=reviewer`** in deep-drilldown URLs (`trail://packet/<id>?focus=<claim-id>&mode=reviewer`). When the URL handler is the entry point, `?mode=` overrides the per-user default.

(c) **Trail-browser clicks** (in-app navigation, no URL handler) honor the per-user default in (a). The user can change the mode via the mode-toggle in the packet header (§4 mode-comparison table).

(d) **Audit mode is a deliberate toggle**: opened by `⌥+a` keyboard shortcut (§9) or a Settings → "Audit mode default for this repo" toggle. Never inferred from URL or identity. This protects scn-005 (Daniel resuming his own session — defaults to creator) and scn-007 (Riya intending audit — must toggle explicitly so reviewer-mode primary actions are not surfaced).

The `trail://` URL handler resolves to internal routes; e.g., `trail://packet/01J...?focus=claim-3&mode=reviewer` → `/packet/.../...?mode=reviewer&focus=claim-3`.

### 1.5 Density modes (per-screen matrix)

B3 §5.2 declared comfortable + compact and deferred per-screen specs to B4. Locked here:

| Screen / region | Density | User-toggleable? | CSS scope |
|---|---|---|---|
| Trail sidebar (`<TrailSidebar>`) | compact (32px row) | NO | `[data-density="compact"]` always applied |
| Claim list (`<ClaimRow>`) | comfortable default; compact opt-in | YES (Settings → Density) | `[data-density="<user-pref>"]` applied to `<ClaimList>` only |
| Packet header, redaction table, trail tab | comfortable | NO | inherits `<App>` data-density (default comfortable) |
| Modals (M1–M6) | comfortable | NO | modals never read density |
| Settings modal (M6) | comfortable | NO | (same) |

CSS-variable resolution is unambiguous: `[data-density]` applies on `<TrailSidebar>` always; on `<ClaimList>` only when user setting is "compact"; never on modals or other regions. Defeats the Sprint 2/3/6 retrofit risk where sidebar-only-compact would diverge from claim-list-comfortable on packet view.

---

## §2 Screen catalog (resolves OQ-B4-4)

Six screens, three modes for the packet view, plus modal/toast catalog.

| # | Screen | Section | Variants |
|---|---|---|---|
| 1 | Trail browser sidebar (always visible) | §3 | Compact / icon-rail / loading |
| 2 | Packet view — Creator mode | §4 | (and §4.1 for shared spec) |
| 3 | Packet view — Reviewer mode | §4.6 | |
| 4 | Packet view — Audit mode | §4.7 | |
| 5 | First-run state | §5 | (E1; routes to here when no packets) |
| 6 | Error states | §6 | E2 schema mismatch, E3 gh-auth, E4 malformed, E5/E6 banner-overlays |
| (M) | Modal catalog | §7 | 6 modals |
| (T) | Toast catalog | §8 | 4 toast variants |
| (S) | Settings modal | §7.6 | not a "screen" — modal over current screen |

---

## §3 Screen 1 — Trail browser (sidebar)

**Status**: persistent; always 280px left rail (or 56px icon-rail when window < 1024px wide).
**Stories**: AU-RC-01, AU-UI-01, AU-UI-02, CR-UI-03 navigation (returns user to)
**Flows**: J10 trail browse + filter; J11 future-self resume; navigation hub for J1, J2, J5, J6, J7

### 3.1 Wide layout (≥ 1024px window)

```
┌────────────────────────────────┐ ← --space-3 padding outer
│ ◯ TRAIL                       │ ← brand, --type-label, copper accent
│ trail/                         │ ← repo name, --type-body-sm, secondary
│                                │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│ ← horizon: 1px --trail-line
│                                │
│ ▾ YOUR RECENT SESSIONS         │ ← collapsible header --type-label
│   ◐ token-rotation        2h   │
│   ◯ oauth-refactor        4h   │ ← row format below
│   ◯ rate-limit-fix     2 days  │
│   + 4 more                     │
│                                │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│
│                                │
│ TIMELINE                       │
│ ⌕ filter packets...            │ ← filter input with leading icon
│ [risk] [time] [redaction]      │ ← filter chips
│                                │
│ ─ TODAY ─                      │ ← time-cluster divider
│ ● HIGH oauth-refactor    14:32 │
│ ◯ LOW  doc-fix-typos    11:08 │
│ ─ YESTERDAY ─                  │
│ ◐ MED  api-renames      09:15 │
│ ─ THIS WEEK ─                  │
│ ◯ LOW  changelog-bump   2 days │
│ ⨂ CRIT auth-middleware  3 days │
│ ◐ MED  schema-migrate   3 days │
│                                │
│ [Load more (24)]               │
│                                │
└────────────────────────────────┘
```

### 3.2 Sidebar row format (compact)

Each timeline row:

```
[risk-glyph] [risk-label] [packet-name]      [age]
```

- Risk glyph: per B3 §4.1; 12px
- Risk label: `--type-mono-sm` 11px, color = risk color
- Packet name: `--type-body-sm` 13px, primary text color, truncated with ellipsis at 14ch
- Age: `--type-body-sm` 13px, tertiary, right-aligned, format `2h` / `1 day` / `3 days` / `Apr 12`

Row height: 32px (compact density).
Hover: `--surface-raised` background.
Active (currently-open): `--border-accent` left edge (3px copper bar, inset).
Click: opens packet view in main area.

### 3.3 Icon-rail layout (window < 1024px)

```
┌────┐
│ ◯  │ ← brand
│    │
│ ━ │ ← horizon (mini)
│    │
│ ◑  │ ← most-recent packet (current state)
│ ◯  │
│ ◐  │
│ +  │ ← expand to full sidebar
│    │
└────┘
```

56px wide; tooltips on hover show packet name + age. Click `+` toggles back to wide mode (overlay if window still narrow).

### 3.4 "Your recent sessions" pin (resolves J11 / AU-UI-02)

Top of sidebar, expandable by default. Aggregates packets by `session_id`. Shows up to 5 most-recent sessions; "+ N more" link expands inline. Each row = a session, clicking expands children inline.

When expanded:
```
▾ token-rotation                2h
   ● HIGH packet-3 (latest)   14:32
   ◐ MED  packet-2            13:15
   ◐ MED  packet-1            12:48
   [Continue from here →]          ← copper button, opens latest
```

**On "Continue from here" click**: the corresponding tick mark on the timeline-rail-vertical horizon (per B3 §10.2 + §10.6 J11 exception) brightens for 320ms with `--ease-record`. Under `prefers-reduced-motion`, the tick renders at final state instantly. This is the second functional-animation exception of the horizon (first is first-run inscribe-in, per B3 §10.6).

### 3.5 Filter tray

Three filters in row 2 of timeline section: risk (multi-select chip popover), time-range (today/week/month/quarter/all), redaction (none/some/heavy/any).

Filter chips render with selected state:
```
[risk: HIGH×3]  ← when active; click to clear
[risk]          ← when unset
```

Filter behavior: dim-trail motion (B3 §8.3) — non-matching rows fade to opacity 0.30; matching rows remain at 1.00.

### 3.6 States

| State | Trigger | Render |
|---|---|---|
| **Empty** | no `.trail/` data | Just the brand and repo name; rest of sidebar reads "No packets captured yet." Compact (no timeline section). |
| **Loading** | initial libSQL query in progress | Skeleton rows: 5 dimmed placeholders with shimmer pulse animation (16ms each, dim-low to base-text-tertiary). |
| **Error** | libSQL connection failed | Shows `⚠ Trail database unavailable` with `Retry` button. App still renders main area in degraded mode reading YAML files directly. |
| **Filtered (no results)** | filter matches 0 packets | "No matches. Clear filter to see all packets." |

#### State-combination matrix (orthogonal × orthogonal)

Real-world combinations matter — scn-007 (Riya pinning HIGH+Q2 filter, then opening a fresh `.trail/`) lands on the wrong copy if "no matches" and "no packets yet" are not distinguished. Each cell renders distinct copy + UI:

| Filter active? | Empty | Loading | Error |
|---|---|---|---|
| No filter | "No packets captured yet." (CTA: capture command) | Skeleton (5 rows) | `⚠ Trail database unavailable` + Retry |
| Filter active | "No packets captured yet. Filter active — clear to see results when packets arrive." (with `[Clear filter]` button) | Skeleton (5 rows) with dimmed filter chips visible above (filter persists during load) | Error banner + filter preserved (retry preserves filter) |

**"Your recent sessions" pin** (§3.4) follows the same matrix: empty + filter-active shows "No recent sessions match this filter. [Clear filter]"; loading + filter shows skeleton with filter chips; error preserves filter on retry.

Drives first-impression accuracy for the auditor flow (job-003.emotional: "trust that 'the trail says X' is dispositive") — landing on misleading copy erodes trust on first interaction.

### 3.7 Performance budget

- First paint: 100ms (sidebar is part of initial render).
- Timeline render at 1000 packets: 300ms (B2 J10 budget); virtualization required (`react-virtual` or `react-window`).
- Filter apply: 100ms (B2 J10 budget).
- Smooth scroll: 60fps minimum.

---

## §4 Screen 2 — Packet view (creator mode)

**Status**: primary review surface for the creator persona.
**Stories**: CR-RC-01, CR-RC-02 (via J3 modal), CR-AT-01, CR-AT-02, CR-UI-01, CR-UI-02, CR-UI-03, CR-GH-01, CR-GH-02
**Flows**: J1, J2, J3, J4, J5, P1, P2, P3, P4

### 4.1 Layout

```
┌────────┬──────────────────────────────────────────────────┐
│ trail  │ ┌─ PACKET HEADER ──────────────────────────────┐│
│ side-  │ │ oauth-refactor                              ││
│ bar    │ │ session 18e374b5 · captured 14:32 · 12 claims││
│ (§3)   │ │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━││ ← horizon §10.3
│        │ │ ▮▮▮▮▮▮▮ ▮▮▮ ▮       [<RiskHistogram>]      ││ ← histogram
│        │ │ LOW 7 · MED 3 · HIGH 1 · CRIT 0              ││ ← labeled counts
│        │ │ 12 claims · 0 of 12 decided · 3 redactions   ││ ← below
│        │ │                                             ││
│        │ │ [Post to PR] (g)         [⋯ menu]          ││
│        │ └─────────────────────────────────────────────┘│
│        │                                                 │
│        │ ┌─ TABS ─────────────────────────────────────┐│
│        │ │ Claims (12) · Diff · Redaction (3) · Trail │ │
│        │ └─────────────────────────────────────────────┘│
│        │                                                 │
│        │ ┌─ CLAIM LIST (default tab) ──────────────────┐│
│        │ │ [filter: undecided / risk≥med / changes]    ││
│        │ │                                             ││
│        │ │ ▾ ●  HIGH   updates redirect_uri allowlist… ││ ← claim row, expanded
│        │ │      ┌─ EVIDENCE ─────────────────────────┐ ││
│        │ │      │ apps/auth/redirect.ts:45-67         │ ││
│        │ │      │ [diff hunk renders here, shiki]     │ ││
│        │ │      │ │  + const PATTERN = /^https:...    │ ││
│        │ │      │ │  - const PATTERN = /.+/           │ ││
│        │ │      │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│ ││
│        │ │      │ test:passed (auth.spec.ts)          │ ││
│        │ │      │ command:exec (npm test)             │ ││
│        │ │      └────────────────────────────────────┘ ││
│        │ │      [Accept (a)] [Override risk (r)] [Reject (b)] │
│        │ │                                             ││
│        │ │ ▸ ◐  MED    expands cookie scope to subdom… ││ ← collapsed
│        │ │ ▸ ◯  LOW    renames internal helper        ││
│        │ │ … 9 more …                                  ││
│        │ │                                             ││
│        │ └─────────────────────────────────────────────┘│
│        │                                                 │
└────────┴──────────────────────────────────────────────────┘
                    ↑ Toasts: "Decision saved" lower-right
```

### 4.2 Header

| Element | Component | Tokens |
|---|---|---|
| Packet name | `<PacketHeader>` heading; `--type-display-2` (Newsreader 28/2rem); `font-variation-settings: "opsz" 28, "wght" 400` per §2.5 mapping | text-primary |
| Metadata strip | `--type-body-sm` | text-secondary |
| Horizon | `<HorizonLine variant="packet-header" />` | `--trail-line` |
| Risk distribution | `<RiskHistogram>` — 4 bars (LOW · MED · HIGH · CRIT) with widths proportional to claim count, tinted by risk color, labeled with count | risk colors per bar |
| Decision count | `<span className="tabular-nums">` | text-secondary |
| Primary action | `<Button variant="primary">` | `--accent` |

`<RiskHistogram>` (per B3 §4.3.1) replaces the prior per-claim glyph row, which violated WCAG 1.4.1 redundancy (bare unlabeled glyphs) and degraded at scale (50+ claims became visually noisy; 80+ unreadable). The histogram pairs glyph + label + color in one compact row and scales to any claim count. Hovering a bar highlights the corresponding claim rows below (cross-region link, preserved from the prior design). For the 12-claim scn-001 packet, the histogram shows `▮▮▮▮▮▮▮ ▮▮▮ ▮` with labels `LOW 7 · MED 3 · HIGH 1 · CRIT 0`.

### 4.3 Tabs

Four tabs:
1. **Claims** (default): list of all claims with decision controls
2. **Diff**: full PR diff with claim annotations in margin (read-only)
3. **Redaction (N)**: redaction summary panel (J4 / RV-UI-02)
4. **Trail**: chronological approval-trail history

Tab styling: minimal — text-only labels, 1px copper underline on active, no enclosing pill.

Implemented via the `<Tabs>` primitive (B3 §15.2 #11). Horizontal orientation, `compact` density. Reviewer mode passes `emphasize={true}` so the Trail tab is visually weighted (per §4.6 mode-comparison table). Audit mode passes `defaultTab="trail"` so the Trail tab is the default landing surface (per §4.7). Keyboard navigation: Left / Right cycle tabs; Home / End jump to first / last; ARIA `role="tablist"` wired by the primitive.

### 4.4 Claim list (default tab)

Each claim row collapses/expands. Collapsed shows: risk glyph + label + claim text (truncated 80ch). Expanded shows: claim text full, evidence subsection, decision actions.

#### Decision actions

Bottom of expanded claim:

| Action | Shortcut | Style |
|---|---|---|
| Accept | `a` | `<Button variant="primary">` |
| Override risk | `r` | `<Button variant="ghost">` |
| Changes | `c` | `<Button variant="ghost">` |
| Reject | `b` | `<Button variant="danger-ghost">` |

Each button shows the shortcut letter parenthetically: `Accept (a)`. After action: claim collapses; UI moves focus to next undecided claim.

#### Carry-forward suggestions panel (J2 / scn-002)

If the current packet has `parent_packet_id`, an additional collapsible subsection appears at the top of the claim list:

```
┌─ CARRY FORWARD FROM packet-1 ──────────────────────┐
│ ✓ 3 unchanged · ⊕ 2 new · ⊖ 0 removed             │
│ 4 prior decisions to apply                          │
│ [Accept all 4 (shift+a)]    [Review individually]  │
└────────────────────────────────────────────────────┘
```

3-column inline summary makes "what changed" visible at a glance instead of hidden in a flat aggregate. Collapsed by default after first dismiss.

**Per-claim row prefix** (within the claim list, beside the risk glyph): each claim is annotated with its carry-forward status to defeat the "subtly different claims carry forward wrongly" failure (scn-002.failure_state):

| Prefix | Meaning | Decision |
|---|---|---|
| `↻` | Carryover; prior decision applied | Pre-decided (visually muted; user can re-open to change) |
| `⊕` | New claim (not present in parent) | Undecided; needs explicit review |
| (no prefix) | Carryover with claim-text or evidence drift | Undecided; needs explicit review (text-similarity flag below threshold) |

The `↻` prefix sits in the trailing badge slot next to the risk glyph; layout cost is zero. Hover tooltip on `↻` shows: `"Decision carried from packet-(N-1): <decision> · <reason if any>"`.

### 4.5 Tabs — non-default content

#### Diff tab

Full PR diff renders via `<DiffHunk>` component (resolves OQ-B4-5: shiki for syntax highlighting; not monaco). One file per collapsible section. Each hunk has a left margin showing which claim references it (claim number + risk glyph). Click margin → jumps back to Claims tab focused on that claim.

Diff shows: + and − prefix characters (color-independent diff cue per B3 §12.2). Background tint is `--risk-low-bg` for additions, `--risk-high-bg` for deletions, at low opacity (12%).

#### Redaction tab (resolves CR-UI-02)

```
┌─ REDACTION SUMMARY ─────────────────────────────────┐
│ Pattern set: trail-redaction-patterns v0.1.2         │
│ Total: 3 redactions · 2 caught Layer 1 · 1 Layer 2  │
│                                                     │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│
│                                                     │
│ Pattern              Layer  Count  Locations        │
│ ─────────────────────────────────────────────────  │
│ slack-token         L1     1      1 command output  │
│ generic-32hex       L2     2      2 command outputs │
│                                                     │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│
│                                                     │
│ ⓘ Preview-original is opt-in. Enable in Settings    │
│   → Redaction → "Allow in-memory preview".          │
└─────────────────────────────────────────────────────┘
```

When opt-in is enabled (default off), each row gets a `[preview]` button → opens **M3 Redaction preview modal** (per §7.3).

#### Trail tab

Chronological list of approval-trail events. One row per event:

```
[14:32]  CREATOR (daniel)        accept       claim-3
[14:33]  CREATOR (daniel)        override     claim-7   risk MED → HIGH
                                                          reason: "audit-relevant scope change"
[Pending: reviewer]
```

Read-only display. Used by all three personas; in audit mode (§4.7) this is the primary surface.

### 4.6 Mode comparison table (creator / reviewer / audit)

Three modes × seven surfaces, fully enumerated. Bulleted prose previously hid gaps that this 3×N table now surfaces; "(same)" denotes inheritance from creator mode.

| Surface | Creator | Reviewer | Audit |
|---|---|---|---|
| Header primary action | `[Post to PR] (g)` | `[Sync decisions to PR] (g)` | (none — `[⋯]` menu only) |
| Header secondary controls | `[⋯]` menu, theme toggle, settings cog | (same) + back-to-PR link | `[⋯]` menu (export — deferred — and link sharing); theme toggle; settings cog; **`<Chip variant="read-only">` AUDIT** chip explicit |
| Tabs visible | Claims · Diff · Redaction · Trail (4) | (same) | (same) |
| Tab default | Claims | Claims (with `<Tabs emphasize>` raising Trail tab visual weight per §4.3) | **Trail** (per `<Tabs defaultTab="trail">`) |
| Claim filter default | `undecided` | `risk≥med` (reviewers focus on what matters) | `all` |
| Decision actions | Accept · Override risk · Changes · Reject (a/r/c/b) | (same) + `Override creator risk` becomes prominent option after Accept | **Hidden entirely** (read-only) |
| Modal variant | M1-Creator (two-row: Agent + Your override) | **M1-Reviewer (three-row: Agent + Creator + Your override)** per §7.1 | (modals not invoked; read-only) |
| Read-only affordance | none (interactive) | none (interactive) | `<Chip variant="read-only">` rendered in header right; banner "This is an audit-mode view; decisions are read-only." pinned above header on first open |
| Tamper warning (J12) | banner above header (rare in creator mode) | banner above header | full-width banner above header (most common surface for J12 detection) |
| Carry-forward panel | shown if `parent_packet_id` present | hidden (creator-only concept) | hidden |
| Risk-override visual | two-layer (agent + creator override) | three-layer stacked dot trail per B3 §4.4 | three-layer; read-only |

**Why the explicit table**: bulleted prose hid gaps. Previously: audit-mode header right-side controls were ambiguous; creator-mode default filter was assumed but never stated; reviewer-mode primary-button color was unclear (resolved: still copper `--accent` for "Sync decisions to PR" — it's still a primary commit action); audit-mode read-only affordance was undeclared. Each cell is now filled. Once Sprint 4 wires decisions, an audit user is unambiguously informed buttons are hidden, not disabled.

### 4.7 Audit-mode-specific notes

The mode comparison table in §4.6 covers all three modes' differences at the surface level. Two audit-only edge cases warrant additional spec:

**Trail-tab empty state (audit mode + HIGH-risk packet)**: when audit-mode opens a packet whose Trail tab has 0 approval-trail entries (abandoned mid-flow) AND the packet has risk ≥ HIGH, the empty state IS the audit finding. Render via `<EmptyState>` (B3 §15.2 #13) with elevated copy:

- Headline: `No approval decisions recorded.`
- Body: `Audit-relevant: HIGH-risk packet without recorded approval.` (rendered in `--risk-high` text)

For non-HIGH packets with empty Trail tab: `No approval decisions recorded for this packet.` (neutral copy, secondary text). Without this distinction, "no approvals on a HIGH-risk packet" — which IS the auditor's signal — reads as a blank tab, losing the dispositive moment that drives job-003.emotional ("trust that 'the trail says X' is dispositive").

**Tamper warning (J12)**: full-width banner above header if hash mismatch detected (per §6.4 / §6.8). Reviewer and creator modes also surface J12, but audit mode is its primary natural habitat (the dispositive surface for "did anyone tamper with this trail?").

### 4.8 States

| State | Trigger | Render |
|---|---|---|
| **Loading** | P1 in progress | Header skeleton (gray block) + 5 claim row skeletons |
| **Empty packet** | packet has 0 claims | `No claims captured. Re-run trail packet generate?` with terminal-command hint |
| **Schema mismatch** | E2 | Read-only mode banner above header (§6.2) |
| **Malformed** | E4 | Error card replaces main area (§6.3) |

### 4.9 Performance budgets

- P1 open packet to summary: 200ms (B2 budget).
- Claim list with 50 claims: render 200ms; virtualization at >100 claims.
- Diff render per hunk: 50ms (shiki async; show skeleton during).
- Decision save optimistic feedback: 100ms (P2 budget).

---

## §5 Screen 5 — First-run state

**Status**: shown when no packets exist (§2.1 Branch B/C in B2).
**Stories**: B1 §7.4 indirect; CR onboarding implicit.
**Flows**: E1.

### 5.1 Layout

```
┌────────┬──────────────────────────────────────────────────┐
│ sidebar│                                                  │
│ (empty │                                                  │
│  state)│                                                  │
│        │                                                  │
│        │            ◯  TRAIL                              │ ← brand mark, large
│        │                                                  │
│        │            ━━━━━━━━━━━━━━━━━━━━━━━━━            │ ← horizon, full
│        │                                                  │
│        │            Capture every AI-assisted             │ ← --type-display-1
│        │            change in this repository.            │
│        │                                                  │
│        │            ┌──────────────────────────────┐     │ ← code block
│        │            │ trail packet generate <id>   │     │   --type-mono
│        │            │ [copy ⧉]                     │     │
│        │            └──────────────────────────────┘     │
│        │                                                  │
│        │            [Open documentation →]                │ ← secondary link
│        │                                                  │
│        │                                                  │
│        │ Trail v0.1 · github.com/.../trail · settings ⌘,  │ ← footer, --type-body-sm
└────────┴──────────────────────────────────────────────────┘
```

### 5.2 Composition

| Element | Token | Note |
|---|---|---|
| Brand mark | 64px horizon glyph + 32px label | Kerning tightened |
| Horizon line | full-width minus `--space-8` margin | Animates inscribe-in on first render only (one-shot) |
| Headline | `--type-display-1` Newsreader, 36px | Two lines max |
| Code block | `<CodeBlock copyable />` | New component, derives from `<Card>` |
| Secondary link | text link with arrow glyph | Opens README in default browser |
| Footer | `--type-body-sm`, tertiary text | Simple horizontal strip |

### 5.3 Copy strings

```
Headline: "Capture every AI-assisted change in this repository."
Subhead (NONE in v0.1 — keep it spare)
Code prompt: "trail packet generate <session-id>"
Tooltip on copy: "Copy to clipboard"
Secondary CTA: "Open documentation →"
Footer: "Trail v{VERSION} · {REPO_URL} · settings ⌘,"
```

Localizable via `apps/ui/src/i18n/en.json`.

### 5.4 States

The first-run state has only one visual variant. After first packet captured, watcher (P4) auto-transitions main area to packet view; first-run state is unmounted.

### 5.5 First-packet-open coachmark

When the watcher transitions the user from first-run E1 into a packet view, OR when the user explicitly opens a packet AND the trail has exactly 1 packet AND the packet has 0 decisions recorded, a one-time inline coachmark renders in the packet header strip (NOT a modal — modals interrupt; this is a quiet hint):

```
┌─ COACHMARK STRIP (one-time) ────────────────────────────────┐
│ Tabs: claims, diff, redaction, trail. `j/k` to navigate ·   │
│ `a` to accept · click any claim to expand. [×]              │
└─────────────────────────────────────────────────────────────┘
```

- Style: `--type-body-sm` 13px text on `--surface-raised`; full-width strip below packet header, above tabs.
- Auto-dismisses after first decision saved (P2 success on any claim).
- Manual dismiss via `[×]` button (top-right of strip).
- Persisted in `~/.trail/settings.json` as `first_packet_coachmark_seen: true` after dismiss; never re-shows for this user.
- ARIA: `role="status"`, `aria-live="polite"` (does not interrupt screen-reader flow).

This is a small reduction of discovery cost for scn-001 (Daniel demoing to OSS contributor — first impression matters); not ceremony, just one-time scaffolding.

---

## §6 Screen 6 — Error / edge states

Each error state in B2 §6 has a defined render.

### 6.0 Cross-surface markdown deep-drilldown fallback (J6 P1 finding)

For reviewers WITHOUT Trail desktop installed (J6 v0.1 limitation; scn-003 Maya), the Phase 3b markdown render emits each deep-drilldown link with a graceful-degradation fallback:

```
[deep drilldown ↗](trail://packet/<id>?focus=<claim-id>) — requires [Trail desktop app](https://github.com/.../trail#install) · [view evidence on GitHub](#diff-<file-hash>L<line>)
```

Three explicit pieces:
1. **Primary link** (`trail://...`): opens Trail desktop; works only if app is installed and the URL handler is registered (§2.3).
2. **Install link**: text `requires Trail desktop app` linking to the install README — visible to any reviewer; explains why the primary link may fail silently.
3. **Evidence fallback** (GitHub Files-Changed URL fragment, e.g., `#diff-abc123L45`): always works in any browser without Trail; links the reviewer directly to the hunk in the PR's "Files changed" tab.

Phase 2 owns this contract; Phase 3b's `trail packet post --markdown` emits links in this exact form. Validates against scn-003 (`failure_state: "Tauri not installed at all"`) — the markdown is now self-sufficient when the deep-drilldown is dead, satisfying job-002.firing_criteria ("don't have to leave the review tool to verify a claim").

### 6.1 E1 — covered by §5.

### 6.2 E2 — schema version mismatch

Banner appears above header on packet view (any mode). Read-only mode forced.

```
┌─ BANNER ─────────────────────────────────────────────────┐
│ ⓘ Packet uses schema v0.2.1; this Trail build supports  │
│   v0.1.1. Opened in read-only mode.                      │
│   [Migration guide]   [Upgrade Trail]                    │
└──────────────────────────────────────────────────────────┘
```

Style: `--shadow-warning` border with `--risk-med` tone. Persistent until packet closed.

### 6.3 E3 — `gh` CLI not authenticated

Modal **M2 GH Auth** (per §7.2). Triggered when user clicks "Post to PR."

### 6.4 E4 — malformed packet

Replaces main area with error card.

```
┌─ MAIN AREA ──────────────────────────────────────────────┐
│                                                          │
│           Could not open packet 18e374b5                 │
│                                                          │
│           Schema validation failed:                      │
│           • _meta.schema_version: required               │
│           • claims[2].risk_classification: invalid enum   │
│                                                          │
│           [Open YAML in external editor]                 │
│           [Re-run trail packet generate]                 │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Sidebar remains; user can navigate to a different packet.

### 6.5 E5 — heavy redaction

Banner inside packet view, above tabs. `--risk-med` styling.

```
┌─ BANNER ─────────────────────────────────────────────────┐
│ ⓘ This packet has 22 redactions — heavier than typical. │
│   See [Redaction tab] for details. Ask the author for   │
│   additional context if needed.                          │
└──────────────────────────────────────────────────────────┘
```

Triggered when redaction count ≥ 15 (B3 OQ-B3-6).

### 6.6 E6 — re-capture session-ID drift

Inline banner via `<RecaptureBanner>` (per §7.5; re-modeled from modal to inline per P3 finding). Triggered when J2 detects same session ID + claim divergence; user makes the binary choice after seeing packet content.

### 6.7 E7 — network failure during post

Toast **T3 Post failed** (per §8.3) with retry button. Stateful: tracks attempt count; after 3 failures, escalates to inline error in Post-to-PR modal.

### 6.8 J12 — tamper warning (special-case error)

Audit-mode banner above header.

```
┌─ BANNER ─────────────────────────────────────────────────┐
│ ⚠ NEW  Approval trail content has changed since last     │
│        verified. The libSQL hash and the YAML hash do   │
│        not match. This may indicate the YAML was edited │
│        outside Trail.                                    │
│   [View diff: libSQL vs YAML]   [Re-verify]   [Dismiss] │
└──────────────────────────────────────────────────────────┘
```

**Default style (animated path)**: `--risk-med` border, `--shadow-warning`, `pulse-warning` animation (B3 §8.3) for two cycles, then settle. ARIA `role="alert"`, `aria-live="polite"`.

**Reduced-motion variant (`prefers-reduced-motion: reduce`)**: WCAG SC 2.3.3 (Animation from Interactions) is satisfied by reducing motion, but the alternate must still convey urgency. Without the pulse, a `--risk-med` banner risks reading as informational. Reduced-motion alternate elevates the urgency signal:

- 2px outer border in `--risk-high` (one tone deeper than `--risk-med`).
- `--shadow-warning` static (no pulse).
- ARIA `role="alert"`, `aria-live="assertive"` (vs `polite` in animated path) — screen-reader interrupts.
- Banner remains visible until dismissed; no auto-settle.
- A `⚠ NEW` chip (`--risk-high` background, `--type-mono-sm`) is rendered at the start of the banner copy and auto-dismisses after first render. This restores the "newness" semantic without motion: a static border alone cannot distinguish "just fired" from "been here 10 minutes." The chip is the textual NEW marker.

The same reduced-motion variant pattern applies to:
- E5 heavy redaction banner (§6.5).
- First-run inscribe-in (§5.2; per B3 §10.6 first-run becomes the second functional-animation exception with reduced-motion final-state fallback).
- `inscribe-in` claim row stagger (§4.4) — under reduced-motion, all rows render simultaneously at final state with the `⚠ NEW` chip absent (no security-critical signal at risk).

---

## §7 Modal catalog

Modals are used per OQ-B4-6 resolution: short focused decisions; no slide-out drawers in v0.1. All modals share base structure: backdrop (`bg` at 65% opacity), centered card (max-width 480px or 640px depending on content), title bar with close (X), body, action footer.

### 7.1 M1 — Risk override (J3, J8)

Triggered by `r` shortcut or "Override risk" button on a claim.

```
┌─ MODAL — 480px ────────────────────────────┐
│ Override risk classification          [×]  │
│ ──────────────────────────────────────────  │
│                                             │
│ Claim: updates redirect_uri allowlist…     │
│                                             │
│ Agent's classification:                     │
│   ◯ LOW    ◐ MED   ● HIGH   ⨂ CRIT        │ ← radio-like; agent's pre-checked
│              ●                              │
│                                             │
│ Your override:                              │
│   ◯ LOW    ◐ MED   ● HIGH   ⨂ CRIT        │
│                       ●  ← user's choice    │
│                                             │
│ Reason (required, ≥3 chars):                │
│ ┌─────────────────────────────────────────┐│
│ │ scope change touches all session cookies,││
│ │ audit-relevant.                         ││
│ └─────────────────────────────────────────┘│
│                                             │
│ ──────────────────────────────────────────  │
│                          [Cancel] [Save]    │
└─────────────────────────────────────────────┘
```

Differs slightly between J3 (creator) and J8 (reviewer): in J8, the modal shows `agent → creator → your override` as three sequential rows; reviewer sees the existing creator override before recording their own.

**M1-Reviewer wireframe** (locks the three-row variant; mirrors B3 §4.4 stacked-dot-with-horizon pattern so engineers build from the wireframe, not from prose):

```
┌─ MODAL — 480px (REVIEWER MODE) ────────────┐
│ Override risk classification          [×]  │
│ ──────────────────────────────────────────  │
│                                             │
│ Claim: updates redirect_uri allowlist…     │
│                                             │
│ Agent's classification (read-only):         │
│ │  ◐ MED                                    │
│ │  rationale: "scope unchanged; lint ok"    │
│ │                                            │
│ │  ← copper vertical horizon connects rows  │
│ │                                            │
│ Creator override (read-only):               │
│ │  ● HIGH    by daniel · 14:33              │
│ │  reason: "audit-relevant scope change"    │
│ │                                            │
│ │                                            │
│ Your override (interactive):                │
│    ◯ LOW    ◐ MED   ● HIGH   ⨂ CRIT        │
│                       ●  ← reviewer's choice│
│                                             │
│ Reason (required, ≥3 chars):                │
│ ┌─────────────────────────────────────────┐│
│ │                                         ││
│ └─────────────────────────────────────────┘│
│                                             │
│ ──────────────────────────────────────────  │
│                          [Cancel] [Save]    │
└─────────────────────────────────────────────┘
```

Three rows stacked vertically with a 1px copper left-rule (`<HorizonLine variant="override-stack-vertical" />`) connecting them — the literal visual breadcrumb of override history per B3 §4.4. Agent and Creator rows are read-only; Your override row is interactive. If creator did not override, only two rows render (Agent + Your override) and the Creator row collapses out.

**Why pin the three-row variant in the wireframe**: scn-004 (Aman overriding HIGH after creator Priya's MED override) — if M1 collapses creator's override into "agent classification," Aman writes his reason against the wrong baseline, confusing the trail. The three-row stamp is the audit-trail surface in miniature.

Submit on `Enter` (when reason field is valid). Cancel on `Escape`.

### 7.2 M2 — GitHub auth (E3)

```
┌─ MODAL — 480px ────────────────────────────┐
│ GitHub authentication required         [×] │
│ ──────────────────────────────────────────  │
│                                             │
│ Trail uses the GitHub CLI (`gh`) to post   │
│ to your PR.                                 │
│                                             │
│ Run this in your terminal:                  │
│ ┌─────────────────────────────────────────┐│
│ │ gh auth login                          ⧉││
│ └─────────────────────────────────────────┘│
│                                             │
│ Then click Retry below.                     │
│                                             │
│ ──────────────────────────────────────────  │
│                       [Cancel] [Retry]      │
└─────────────────────────────────────────────┘
```

### 7.3 M3 — Redaction preview confirm (J4 step 5–8)

Two-stage. First stage:

```
┌─ MODAL — 480px ────────────────────────────┐
│ Preview redacted content?              [×] │
│ ──────────────────────────────────────────  │
│                                             │
│ ⚠ This will display the original content   │
│   from the in-memory cache.                 │
│                                             │
│   • Will NOT be saved to disk               │
│   • Will NOT be copied to clipboard         │
│   • Cannot be undone if leaked accidentally │
│                                             │
│ Continue?                                   │
│                                             │
│ ──────────────────────────────────────────  │
│                  [Cancel] [Show for 30s]    │
└─────────────────────────────────────────────┘
```

Second stage (after confirm):

```
┌─ MODAL — 640px ────────────────────────────┐
│ Original content                  [29s] [×]│
│ ──────────────────────────────────────────  │
│                                             │
│ ┌─────────────────────────────────────────┐│
│ │ <ORIGINAL TEXT HERE — non-selectable>   ││
│ │                                         ││
│ └─────────────────────────────────────────┘│
│                                             │
│ Auto-dismisses in 29s. [Extend 30s]        │
│ Click outside to close immediately.         │
└─────────────────────────────────────────────┘
```

The countdown is visible; clicking outside or pressing `Escape` dismisses immediately. After dismiss, content is wiped from React state synchronously.

**Configurable preview duration (P3 finding)**: Settings → Redaction exposes a "Preview duration" select with options `15s` / `30s` (default) / `60s` / `Explicit dismiss only`. The 30s default is calibrated for typical single-line snippets; multi-line snippets (e.g., a redacted command output) get cut mid-read at 30s. Power users (the cohort opting into the preview at all) can self-select.

**Extend-30s inline button**: clicking `[Extend 30s]` resets the timer to 30s. Single-use per modal lifetime (button hides after first click) — preserves the security property that the preview is bounded; only one extension per session.

The setting persists to `~/.trail/settings.json` under `redaction.preview_duration_ms` (validated per B5 §6.6 settings schema).

### 7.4 M4 — Post to PR (CR-GH-01)

```
┌─ MODAL — 480px ────────────────────────────┐
│ Post packet to PR                      [×] │
│ ──────────────────────────────────────────  │
│                                             │
│ Posting to: github.com/myorg/trail          │ ← from `gh repo view --json nameWithOwner`
│                                             │
│ PR detected from current branch:            │
│   #432 — feat: oauth refactor               │
│   github.com/.../trail/pull/432             │
│                                             │
│ Or specify a different PR number:           │
│   PR # [    ]                               │
│                                             │
│ This will replace the Trail-managed section │
│ of the PR body. Other PR body content is    │
│ preserved.                                  │
│                                             │
│ ▸ Preview markdown to be posted             │ ← collapsible, default-collapsed
│   (rendered via `trail packet post --dry-run`)
│                                             │
│ ──────────────────────────────────────────  │
│                       [Cancel] [Post]       │
└─────────────────────────────────────────────┘
```

**Destination header** (security gate per §6.2 hardening): the "Posting to: github.com/{owner}/{name}" line is derived from `gh repo view --json nameWithOwner` and shown above any PR-number input. Defends against malicious-remote attacks (a contributor's PR sets `origin = github.com/attacker/notyou.git`); user must visually confirm destination before posting. If the destination differs from a previously-posted destination for this packet, the line is highlighted in `--risk-med` with a `⚠` glyph.

**Preview section** (CR-GH-01 acceptance, P2 finding): expandable section renders the markdown that will be posted. Triggered by clicking the `▸ Preview` row; the modal expands inline (max 60vh; scrolls internally). Render via Phase 3b `trail packet post --dry-run` — same code path as the post itself, so what-you-see is what-you-post. `g` keyboard shortcut (per §9 global) still posts directly without expanding the preview, preserving the power-user flow. First-time users (per §5.5 first-packet-open coachmark) are nudged to expand the preview at least once.

For re-post (CR-GH-02), the title becomes "Re-post packet to PR" and the body shows a "Diff vs. last post" expandable section (collapsed by default), positioned between the destination header and the Preview section.

### 7.5 M5 — Re-capture drift (inline banner, NOT modal)

**Re-modeled as an inline banner per P3 finding**. M5 was previously a modal forcing a binary choice ("treat as separate" vs "force carry-forward") BEFORE the user has seen the packet content that should inform that choice. The dogfood loop (scn-002) hits this every uncertain re-capture; an upfront-binary modal interrupts. Inline banner lets the user see the packet content first, then choose.

Rendered above the claim list (where E5 also lives — same banner surface), not as a modal:

```
┌─ BANNER (inline, packet view) ──────────────────────────────┐
│ ⓘ Session detected but claims diverged. None of this        │
│   packet's claim IDs match the prior packet (packet-1).     │
│   [Treat as separate]   [Force carry-forward]               │
└──────────────────────────────────────────────────────────────┘
```

Style: `--risk-med` border, `--shadow-warning` static (no pulse — this is informational, not a security event). User clicks one of the two buttons inline; the choice updates the packet view (carry-forward panel appears or not). Dismissible after choice; remembered per packet.

`<RecaptureBanner>` component (added to B4 §11) replaces `<RecaptureDriftModal>`. The modal slot M5 is intentionally vacated — modal count drops from 6 to 5.

### 7.5.1 M6 settings — known compromise

M6 settings is a 720px / 80vh modal with internal vertical-tab navigation — effectively a screen rendered as a modal. P3 found this is not the cleanest model (a settings screen is more conventional), but converting it to a route would touch B4 §1.4 routing semantics and add complexity. **Decision: leave as modal in v0.1; defer route conversion to v0.2+.** Documented as a known compromise; the internal `<Tabs orientation="vertical">` (per B3 §15.2 #11) gives reasonable navigation within the modal.

### 7.6 M6 — Settings

Internal tab navigation for the settings modal. Larger (max-width 720px, 80vh height).

```
┌─ MODAL — 720px ────────────────────────────────────┐
│ Settings                                       [×] │
│ ───────────────────────────────────────────────── │
│                                                    │
│ ⊙ Appearance     │ Theme:          [Dark ▾]       │
│ ◯ Density        │   ◐ Match system               │
│ ◯ Keyboard       │                                │
│ ◯ Redaction      │ Density:        [Comfortable ▾]│
│ ◯ Telemetry      │                                │
│ ◯ About          │ Font size:      [Default ▾]    │
│                  │                                │
│                  │                                │
│                  │ ─────────────────────────────  │
│                  │                                │
│                  │              [Reset to default]│
└────────────────────────────────────────────────────┘
```

Six sub-pages:

| Page | Settings |
|---|---|
| Appearance | Theme (dark / light / match system); font size (small / default / large) |
| Density | Comfortable / Compact for trail browser + claim list |
| Keyboard | View shortcut catalog (read-only in v0.1; edit deferred) |
| Redaction | Enable in-memory preview (default OFF) — opt-in for J4 |
| Telemetry | Anonymous error reporting (default OFF for OSS v0.1; honest about scope) |
| About | Version, license, source link, credits |

Settings persist to `~/.trail/settings.json` (Tauri filesystem).

---

## §8 Toast catalog

Toasts dock at bottom-right, max 3 visible. Auto-dismiss after 4s for info/success, 8s for error/warning. Click anywhere on toast to dismiss; ✕ on hover.

| ID | Variant | Trigger | Copy |
|---|---|---|---|
| **T1 Decision saved** | success | P2 commit | `Decision saved.` |
| **T2 Packet posted** | success | P3 commit | `Packet posted to PR #{N}.` (linked) |
| **T3 Post failed** | error | E7 | `Post failed: {reason}. [Retry]` |
| **T4 New packet captured** | info | P4 watcher fire | `New packet captured: {name} ({claim_count} claims).` (linked) |
| **T5 Decision failed** | error | P2 abort | `Decision could not be saved: {reason}.` |
| **T6 Tamper warning logged** | warning | J12 dismiss/re-verify | `Tamper event recorded to audit log.` |

Toast uses `--shadow-toast`. Stacks vertically; older toasts slide up to make room. ARIA: each toast is a live region with `role="status"` (info/success) or `role="alert"` (error/warning).

---

## §9 Keyboard shortcut catalog (resolves OQ-B4-7)

Discoverability strategy:
1. Inline shortcut hint next to action labels (e.g., `Accept (a)` in claim cards)
2. `?` opens full overlay with all shortcuts; **a "Most-used" section pinned at the top** lists the 5 essentials new users actually read: `j k a c b`.
3. NO permanent mode-line (would clutter)

**Trim rationale (P2 finding)**: the original 19-shortcut catalog exceeded the first-run discoverability budget. GitHub's PR view ships ~8 shortcuts; scn-004 (Aman, junior, unfamiliar code) was cognitively overloaded. Trimmed to **13 shortcuts** by removing redundancies:

- `n` / `p` (next/prev undecided): subsumed by `j`/`k` after applying the `undecided` filter — power-user redundancy. Deferred to v0.2 power-user catalog.
- `[` / `]` (back/forward): one click on the sidebar replaces; deferred to v0.2.
- `Shift+a` (accept all carried-forward): the carry-forward panel button is one click and discoverable; deferred to v0.2.

Categories (post-trim):

| Scope | Shortcut | Action |
|---|---|---|
| Global | `?` | Open shortcut catalog overlay |
| Global | `⌘,` / `Ctrl+,` | Open settings |
| Global | `⌘k` / `Ctrl+k` | Quick-open trail browser filter |
| Global | `g` | Post / sync to PR (when packet view active) |
| Global | `⌥+a` | Toggle audit mode (deliberate, never auto-entered per §1.4) |
| Trail browser | `↑` / `↓` | Navigate timeline |
| Trail browser | `Enter` | Open focused packet |
| Packet view (claims tab) | `j` / `↓` | Next claim |
| Packet view (claims tab) | `k` / `↑` | Previous claim |
| Packet view (claims tab) | `Space` / `Enter` | Expand/collapse focused claim |
| Packet view (claims tab) | `a` | Accept focused claim |
| Packet view (claims tab) | `r` | Override risk on focused claim (opens M1) |
| Packet view (claims tab) | `c` | Mark "changes" on focused claim |
| Packet view (claims tab) | `b` | Block / reject focused claim |
| Modal | `Esc` | Cancel/close |
| Modal | `Enter` | Confirm primary action (when valid) |

**Most-used (pinned at top of `?` overlay)**: `j` next claim · `k` previous claim · `a` accept · `c` changes · `b` block. These five are what new users actually read; surfacing them at the top trims the cognitive cost of the full catalog.

**Scope rules (WCAG 2.1.4 Character Key Shortcuts)**: all single-character shortcuts (`a`, `c`, `b`, `r`, `j`, `k`, `g`) are SUPPRESSED when an editable element has focus — guard against `r` triggering risk-override mid-typing in an M1 reason field. Concretely: a global keydown handler checks `document.activeElement` against `input | textarea | [contenteditable=true]`; if any match, single-character shortcuts are no-ops. The `?` shortcut (catalog) and `Esc` (close modal) fire regardless of focus. Settings → Keyboard exposes a "Disable single-key shortcuts" toggle (default off) for users who require WCAG 2.1.4 conformance — this also satisfies the SC's "active only on focus / remappable / turn-off-able" requirement.

`?` overlay layout: card at center of screen showing all shortcuts grouped by scope, with the Most-used section pinned at top. Searchable (search input at top); auto-focuses on open.

---

## §10 OQ-B4-* resolutions (from B2 §8.3)

| OQ | Resolution |
|---|---|
| **OQ-B4-4** Concrete screen list | 6 screens (§2 catalog) + 6 modals + 6 toast variants. Primary screens: trail browser sidebar (always), packet view (3 modes via `?mode=` param), first-run state, error states. Settings is a modal, not a screen. |
| **OQ-B4-5** Diff view component | **shiki** for syntax highlighting + custom `<DiffHunk>` wrapper. Reasons: lightweight (~50KB + grammars vs monaco's ~5MB), read-only is sufficient for v0.1, accurate VSCode-grade highlighting, async-loadable on demand. Monaco deferred to v0.2+ if interactive editing surfaces (e.g., reviewer leaves inline annotations). |
| **OQ-B4-6** Modal vs slide-out | **Modal everywhere** in v0.1. No slide-out drawers. Modals are simpler, focus better, work consistently across desktop sizes. Inline expand for read-only detail (claim evidence subsection). 6 modal types (§7); no drawers. |
| **OQ-B4-7** Keyboard shortcut UI | Combination: inline hints next to action labels + `?` overlay for full catalog. NO permanent mode-line. Settings → Keyboard tab shows the catalog read-only (edit deferred). |
| **OQ-B4-8** Multi-window support | Single-window v0.1. Per-packet navigation history (`[` and `]` shortcuts). Side-by-side packet comparison deferred to v0.2+. Single-window keeps keyboard shortcut scope unambiguous and simplifies state management. |

---

## §11 New components introduced in B4

In addition to B3's 13 component primitives, B4 introduces these screen-level components. All compose B3 primitives.

| Component | Composes | Used by |
|---|---|---|
| `<TopBar>` | `<HorizonLine>`, `<Button variant="ghost">`, `<KeyboardKey>` | Window chrome (§1.1) |
| `<TrailSidebar>` | `<Card>`, `<Chip>`, `<Risk>`, `<KeyboardKey>`, `<Skeleton>`, `<EmptyState>` | §3 |
| `<PacketHeader>` | `<HorizonLine variant="packet-header">`, `<Risk>`, `<Button>`, `<Tabs>` | §4.2 |
| `<RiskHistogram>` | 4-bin bar visualization with risk-tinted fills + counts | §4.2 (replaces per-claim `<RiskDistribution>` row; see §4.2) |
| `<ClaimRow>` | `<Card>`, `<Risk>`, `<Button>`, `<DiffHunk>` | §4.4 |
| `<DiffHunk>` | shiki syntax highlighter + line-prefix renderer | §4.5 (Diff tab), §4.4 (claim evidence) |
| `<ApprovalTrail>` | `<Card>` rows, `<Risk>` chips inline | §4.5 (Trail tab), §4.7 (audit) |
| `<RedactionTable>` | `<Card>`, `<KeyboardKey>` | §4.5 (Redaction tab) |
| `<CarryForwardPanel>` | `<Card>`, `<Button>` | §4.4 inset |
| `<TamperBanner>` | `<Banner>` + `pulse-warning` animation (with reduced-motion variant per §6.8) | §6.8 |
| `<HeavyRedactionBanner>` | `<Banner>` | §6.5 |
| `<CodeBlock>` (copyable) | `<Card>` + clipboard button | §5 first-run, §7.2 |
| `<KeyboardOverlay>` | `<Modal>` with grouped shortcut list | §9 (`?` shortcut) |
| `<SettingsModal>` | `<Modal>` with internal vertical `<Tabs>` nav | §7.6 |
| `<RiskOverrideModal>` | `<Modal>` + risk radio + reason field; reviewer-mode three-row variant per §7.1 | §7.1 (M1) |
| `<RecaptureBanner>` | `<Banner>` (inline, replaces M5 modal) | §6.6 |

Total components for Phase 2: **B3's 13 primitives + B4's 16 screen-level = 29**.

---

## §12 Per-screen performance budgets

| Screen | Budget | Notes |
|---|---|---|
| Trail browser first paint | 100ms | Part of initial app render |
| Trail browser scroll (1000 packets) | 60fps | Virtualization required |
| Trail browser filter apply | 100ms | Local libSQL query |
| Packet view open (P1) | 200ms | CR-UI-03; full summary panel |
| Packet view 50 claims render | 200ms | Claim list virtualized at >100 |
| Diff hunk render per claim | 50ms | Async shiki; skeleton during |
| P2 decision optimistic feedback | 100ms | UI state only |
| P2 durable confirmation | 500ms | YAML + libSQL atomic write |
| P3 post to PR | 3s | Network-bound |
| Modal open transition | 160ms | `--motion-short` |
| Toast appearance | 240ms | `--motion-base` slide-up |
| Settings open | 160ms | Modal |
| First-run state initial render | 100ms | One-time inscribe-in animation |

Budgets carried forward into B5 architecture reconciliation as concrete constraints.

---

## §13 Implementation handoff

### 13.1 Build order for Phase 2 (#22)

Sprints in dependency order (each sprint deliverable):

**Sprint 1 — Foundation (1 PR)**
1. Tauri 2.x scaffold + Vite + React + TypeScript
2. `apps/ui/src/design/` — tokens.ts, tokens.css codegen, fonts.css, global.css
3. B3 primitives: `<Risk>`, `<HorizonLine>`, `<Chip>`, `<Card>`, `<Button>`, `<Toast>`, `<Modal>`, `<Banner>`, `<KeyboardKey>`
4. Theme provider + settings persistence
5. Storybook (optional but recommended)

**Sprint 2 — Trail browser (1-2 PRs)**
1. `<TopBar>`, `<TrailSidebar>` composition
2. libSQL read path (schema queries; defer write path until packet view interactions)
3. Filter UI + dim-trail motion
4. Empty / loading / error states
5. Wide / icon-rail responsive

**Sprint 3a — Packet view shell (1 PR)**
1. `<PacketHeader>`, `<RiskHistogram>`, `<HorizonLine variant="packet-header">`
2. `<Tabs>` primitive (B3 §15.2 #11) with empty panel scaffolding
3. Mode-routing (`?mode=` parsing per §1.4); creator/reviewer/audit shells return early with placeholder copy

Sprint 4 (decisions + modals) can start against this shell while Sprint 3b lands in parallel — decoupling decisions work from the higher-risk components.

**Sprint 3b — Packet view content (1-2 PRs)**
1. `<ClaimRow>` (with carry-forward `↻` / `⊕` row prefixes per §4.4) + claim list virtualization
2. `<DiffHunk>` shiki integration; cold-start strategy (pre-warm top-4 grammars at `<App>` mount per B3 §15.3)
3. Four tab contents (Claims, Diff, Redaction, Trail) plugged into Sprint 3a shell

The two most novel components (`<DiffHunk>`, risk-aware `<ClaimRow>`) have no shadcn equivalents and gate CR-UI-03 (200ms summary) + the diff-budget. Splitting Sprint 3 (was: 8 contracts in 2 PRs) into 3a shell + 3b content trims compounded risk: optimization under tight perf rubric no longer happens on the same PRs that introduce the components. PR count: 9 → 10.

**Sprint 4 — Decisions + modals (2 PRs)**
1. `<RiskOverrideModal>` (M1)
2. P2 atomic-write contract (YAML + libSQL)
3. Decision actions (a/c/b/r shortcuts)
4. Carry-forward suggestions panel
5. Toast wiring

**Sprint 5 — GitHub posting + edge states (1-2 PRs)**
1. M4 Post to PR + M2 GH auth modals
2. P3 sync (gh CLI subprocess)
3. E1-E7 error states
4. M5 re-capture drift, M6 settings, M3 redaction preview

**Sprint 6 — Polish (1 PR)**
1. `?` keyboard overlay (`<KeyboardOverlay>`)
2. ARIA live regions, screen reader testing
3. Reduced-motion verification
4. Performance budget verification (CI-gated)

Total: ~9 PRs over Phase 2.

### 13.2 Tauri config notes

- `tauri.conf.json`: window default 1280×800; min 960×600; titleBarStyle = "overlay" on macOS for horizon-line integration; resizable
- IPC channels: `read_packet`, `save_decision`, `post_to_pr`, `subscribe_fs_watch`
- Filesystem permissions: `.trail/` directory only; user-explicit grants for posting

### 13.3 What B5 must validate

- libSQL ↔ YAML 2-phase commit contract (P2 OQ-B5-1)
- Filesystem watcher debounce + write-marker contract (P4 OQ-B5-2)
- Re-capture model (parent_packet_id) reconciles with Phase 1 schema (OQ-B5-3 → AB-6)
- Tauri IPC channel surface area (no leaks; clear allowlist)

---

## §14 Provenance

| Source | Used for |
|---|---|
| `docs/specs/phase-2-ui-stories.md` (B1) | Story coverage; persona-mode mapping |
| `docs/specs/phase-2-ui-flows.md` (B2) | Flows informing screen states; OQ-B4-* questions; performance budgets |
| `docs/specs/phase-2-design-system.md` (B3) | Token names; component primitives; risk encoding; horizon motif; keyboard catalog discoverability |
| `docs/architecture.md` §Layer 3 | Tauri config; libSQL boundaries |
| `.claude/canvas/scenarios.yml` scn-001..007 | Concrete user narratives that screens must serve |
| `phase-1-capture.md` v1.2 | Schema field availability; atomic-write contract; redaction-audit format |
| WCAG 2.1 / 1.4.1 / 1.4.11 | Color independence; non-text contrast for risk encoding |

---

**End of B4.**

Next: **B5** — reconcile B1–B4 with `docs/architecture.md`. Three concrete OQ-B5-* contracts to lock: (1) libSQL+YAML 2-phase atomic-write protocol; (2) filesystem watcher debounce + write-marker; (3) re-capture model + parent_packet_id schema dependency (drives AB-6). After B5: B6 design review across B1–B5; then B7 /preflight Phase 2.
