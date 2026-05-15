/**
 * Trail Forensic Instrument design tokens — source of truth.
 *
 * `tokens.css` is generated from this file by `scripts/codegen-tokens.mjs`.
 * Components import the typed `tokens` object for autocomplete; CSS variables
 * are emitted from the same data so semantics stay in sync.
 *
 * Spec references:
 *   - docs/specs/phase-2-design-system.md (B3)
 *   - docs/specs/phase-2-design-review-b6.md (B6 amendments)
 */

export const tokens = {
  color: {
    ink: {
      1000: '#06090D',
      950: '#0E1116',
      900: '#161A21',
      850: '#1F2530',
      800: '#2A313D',
      700: '#3D4654',
      500: '#6B7585',
      400: '#A3ACB9',
      200: '#E8ECF0',
    },
    paper: {
      50: '#F8F6F2',
      100: '#FFFFFF',
      200: '#F2EFEA',
      300: '#E5DFD5',
      400: '#C4BCAD',
      600: '#767E8B',
      700: '#4F5765',
      900: '#1A1F26',
    },
    copper: {
      300: '#F5A472',
      400: '#E07A3C',
      500: '#C56021',
      600: '#B85B1F',
      700: '#933D0F',
    },
    /**
     * Risk pigments (sage / mustard / terracotta / oxblood).
     * `crit.dark` was brightened from #A03831 → #C84A40 per B6 P1 to lift
     * the bare CRIT glyph above WCAG 1.4.11 non-text contrast (≥3:1 vs
     * --ink-950).
     */
    risk: {
      low: { dark: '#7AAA8E', light: '#3F7A5E' },
      med: { dark: '#D4B36B', light: '#A07921' },
      high: { dark: '#D87466', light: '#A33A2A' },
      crit: { dark: '#C84A40', light: '#6E1F1A' },
    },
    riskBg: {
      low: { dark: 'rgba(122, 170, 142, 0.12)', light: 'rgba(63, 122, 94, 0.10)' },
      med: { dark: 'rgba(212, 179, 107, 0.12)', light: 'rgba(160, 121, 33, 0.10)' },
      high: { dark: 'rgba(216, 116, 102, 0.12)', light: 'rgba(163, 58, 42, 0.10)' },
      crit: { dark: 'rgba(200, 74, 64, 0.14)', light: 'rgba(110, 31, 26, 0.10)' },
    },
    trail: {
      line: { dark: '#6FA8DC', light: '#3D7AAE' },
      lineDim: { dark: 'rgba(111, 168, 220, 0.35)', light: 'rgba(61, 122, 174, 0.30)' },
    },
  },
  /** Fibonacci-inspired spacing scale (B3 §5). */
  space: {
    1: 2,
    2: 4,
    3: 8,
    4: 12,
    5: 20,
    6: 32,
    7: 52,
    8: 84,
    9: 136,
  },
  radius: {
    0: 0,
    1: 2,
    2: 4,
    full: 9999,
  },
  /** Layout scale captured to keep raw px out of components (B3 §5.1.1). */
  size: {
    modalSm: 480,
    modalMd: 640,
    modalLg: 720,
    sidebar: 280,
    sidebarRail: 56,
    contentMax: 1080,
    rowCompact: 32,
    rowComfortable: 44,
    /** B3 §5.1.1 component sizes — pinned in tokens to keep CSS literal-free. */
    glyph: 14,
    glyphIcon: 20,
    glyphLg: 24,
    chipMin: 80,
    tabRail: 160,
    toastMax: 360,
    horizonHeroMax: 360,
    skeletonBlock: 120,
    iconKey: 10,
  },
  /**
   * Border widths (B3 §5.1.1 hairline + focus-ring scale). Pinned in tokens
   * so component CSS can reference `var(--border-width-*)` instead of raw px.
   * focusRing matches the outer ring offset declared in
   * codegen-tokens.mjs `:focus-visible` block (4px).
   */
  border: {
    hairline: 1,
    thick: 2,
    focusRing: 4,
  },
  /**
   * Layout breakpoints (B3 §5 responsive grid). Used by component @media
   * rules; emitted as CSS variables referenced via `media()` at codegen time
   * is overkill for v0.1 — we emit numeric tokens and the codegen-tokens.mjs
   * passes them through to `--breakpoint-*` so the lint rule can authorize
   * arithmetic on token vars instead of raw `1024px`.
   */
  breakpoint: {
    md: 1024,
  },
  motion: {
    duration: {
      instant: 80,
      short: 160,
      base: 240,
      long: 360,
    },
    ease: {
      out: 'cubic-bezier(0.20, 0.80, 0.20, 1.00)',
      in: 'cubic-bezier(0.55, 0, 1, 0.45)',
      inout: 'cubic-bezier(0.65, 0, 0.35, 1)',
      record: 'cubic-bezier(0.30, 0.70, 0.10, 1)',
    },
  },
  type: {
    /**
     * Type scale @ ratio 1.200 (minor third). Values mirror B3 §2.3 exactly;
     * Newsreader rows declare `opsz` so the optical-size variable axis is
     * pinned per token.
     */
    'display-1': {
      family: 'Newsreader',
      size: 36,
      lineHeight: 1.10,
      weight: 400,
      tracking: '-0.02em',
      opsz: 36,
    },
    'display-2': {
      family: 'Newsreader',
      size: 28,
      lineHeight: 1.15,
      weight: 400,
      tracking: '-0.015em',
      opsz: 28,
    },
    h1: {
      family: 'Newsreader',
      size: 22,
      lineHeight: 1.25,
      weight: 500,
      tracking: '-0.01em',
      opsz: 22,
    },
    h2: {
      family: 'Newsreader',
      size: 18,
      lineHeight: 1.30,
      weight: 500,
      tracking: '-0.005em',
      opsz: 18,
    },
    h3: {
      family: 'Public Sans',
      size: 15,
      lineHeight: 1.35,
      weight: 600,
      tracking: '0',
    },
    body: {
      family: 'Public Sans',
      size: 15,
      lineHeight: 1.55,
      weight: 400,
      tracking: '0',
    },
    'body-sm': {
      family: 'Public Sans',
      size: 13,
      lineHeight: 1.50,
      weight: 400,
      tracking: '0',
    },
    ui: {
      family: 'Public Sans',
      size: 14,
      lineHeight: 1.40,
      weight: 500,
      tracking: '0',
    },
    label: {
      family: 'Public Sans',
      size: 11,
      lineHeight: 1.30,
      weight: 600,
      tracking: '0.08em',
      uppercase: true,
    },
    mono: {
      family: 'Commit Mono',
      size: 13,
      lineHeight: 1.55,
      weight: 400,
      tracking: '0',
    },
    /** Hardened per B3 §2.5 — weight 600, tracking 0.02em for risk-label legibility. */
    'mono-sm': {
      family: 'Commit Mono',
      size: 11,
      lineHeight: 1.45,
      weight: 600,
      tracking: '0.02em',
      uppercase: true,
    },
  },
  shadow: {
    pop: {
      dark: '0 4px 12px rgba(0, 0, 0, 0.30)',
      light: '0 4px 12px rgba(26, 31, 38, 0.10)',
    },
    toast: {
      dark: '0 8px 24px rgba(0, 0, 0, 0.40)',
      light: '0 8px 24px rgba(26, 31, 38, 0.12)',
    },
    warning: '0 0 0 1px var(--risk-high), 0 0 24px rgba(216, 116, 102, 0.20)',
  },
} as const;

export type Tokens = typeof tokens;
export type RiskLevel = 'low' | 'med' | 'high' | 'crit';
export type Theme = 'dark' | 'light';
export type TypeToken = keyof Tokens['type'];
