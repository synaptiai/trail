# Trail vendored fonts

Trail self-hosts open-licensed font families for typographic consistency
across macOS / Linux / Windows installer targets and for offline operation
in Tauri desktop builds. License files MUST land alongside redistributed
binaries (OFL §3 requirement).

## v0.1.0 vendor state

| Family | Vendored | License file | Source |
|---|---|---|---|
| Newsreader (variable, opsz + wght) | ✅ `Newsreader[opsz,wght].woff2` | ✅ `Newsreader-OFL.txt` | <https://github.com/productiontype/Newsreader> |
| Public Sans (variable, wght) | ⏳ pending v0.1.x | ⏳ pending v0.1.x | <https://github.com/uswds/public-sans> |
| Commit Mono 400 / 700 | ⏳ pending v0.1.x | ⏳ pending v0.1.x | <https://commitmono.com> |

Two of the three families are deferred because the upstream sources do not
publish pre-built variable WOFF2 files matching the manifest declarations:

- **Public Sans** ships only `.ttf` for the variable axis and per-weight
  `.woff2` for static weights. Vendoring requires either TTF→WOFF2
  conversion (via `fonttools`) or rewriting the `@font-face` declarations
  in `src/design/fonts.css` to the static-weight `.woff2` set.
- **Commit Mono** ships `.otf` source files plus a release `.zip`. Direct
  WOFF2 download is not available without the customizer.

Until those families vendor cleanly, `src/design/fonts.css` declares them
with the existing fallback chain (`Public Sans → system-ui`,
`Commit Mono → JetBrains Mono / Menlo`). The `font-display: swap`
attribute prevents flash-of-invisible-text when the WOFF2 is absent.

## Vendor procedure (when adding a new family)

1. Download the official WOFF2 build (or convert from TTF/OTF) using a
   tool that preserves the variable axis if applicable. Fonttools:
   `python -m fontTools.ttLib.woff2 compress font.ttf` produces
   `font.woff2`.
2. Place the binary in this directory using the filename declared in
   `apps/ui/src/design/font-integrity.json`:
   - `Newsreader[opsz,wght].woff2`
   - `PublicSans[wght].woff2`
   - `CommitMono-400-Regular.woff2`
   - `CommitMono-700-Bold.woff2`
3. Place each upstream license alongside the binary, named
   `<Family>-OFL.txt` — required by OFL §3 when redistributing.
4. Run `node apps/ui/scripts/font-integrity-update.mjs` from the repo
   root to populate the SHA-256 fields in `font-integrity.json`.
5. Commit the binary, the license, and the regenerated manifest.

The runtime SHA-256 verifier (`apps/ui/src/design/font-integrity.ts`,
referenced in design notes B3 §15.1) is **v0.1.x scope**. Until it lands,
the manifest hashes serve as a static integrity reference and audit
trail; the browser's normal `@font-face` cascade handles missing or
corrupt files via the documented fallback chain in `fonts.css`.
