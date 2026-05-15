#!/usr/bin/env node
// [F19 / 2026-05-09] Two-stage bundled-YAML copy.
//
// Stage 1 (canonical → package): copy YAML pattern files from the repo
//   root `bin/` (the canonical source — also consumed by py-reference)
//   into `apps/capture/bin/`. This makes the repo-root copy the single
//   source of truth: a contributor edits the canonical file and the
//   package copy regenerates on every build, eliminating the drift
//   class where py-reference and TS see different patterns despite
//   advertising the same `pattern_set_version`.
//
// Stage 2 (package → dist): copy the freshly synced `apps/capture/bin/`
//   into `dist/bin/` so the published npm artefact ships with the
//   YAML colocated with compiled JS.
//
// Run via `pnpm --filter @synapti/trail-capture build` (script: "tsc && node
// ./scripts/copy-bin.mjs") AND via the `prebuild` hook so a `tsc`-only
// invocation also re-syncs the package copy. The hash-pin test in
// `apps/capture/test/patterns-load.test.ts` (F8) additionally asserts
// byte-equality between the two copies — if drift is introduced manually
// in the package copy without a corresponding canonical change, the
// build will silently overwrite it; if drift is introduced ONLY in
// canonical, the hash-pin test fails until the test pin is rotated.

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");

const canonicalBin = resolve(repoRoot, "bin");
const packageBin = resolve(pkgRoot, "bin");
const distBin = resolve(pkgRoot, "dist", "bin");

// Stage 1 — canonical → package. Only `.yml` files are synced; other
// content in the package's bin/ (e.g., README.md noting the auto-sync)
// is preserved.
//
// [F26 / 2026-05-09] Stale-cleanup: package `.yml` files that no longer
// have a canonical sibling are unlinked so a decommissioned pattern set
// can't ship as a stale package artefact. The byte-equality test
// (patterns-load.test.ts F19) only covers files with explicit pins, so
// without this cleanup an orphaned package YAML would pass CI silently.
if (existsSync(canonicalBin)) {
  mkdirSync(packageBin, { recursive: true });
  const canonicalYmls = new Set(
    readdirSync(canonicalBin, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".yml"))
      .map((e) => e.name)
  );
  // Stage 1a — unlink stale package YAMLs.
  const removed = [];
  if (existsSync(packageBin)) {
    for (const entry of readdirSync(packageBin, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".yml") && !canonicalYmls.has(entry.name)) {
        unlinkSync(join(packageBin, entry.name));
        removed.push(entry.name);
      }
    }
  }
  if (removed.length > 0) {
    console.log(`removed stale package YAML (no canonical sibling): ${packageBin} (${removed.join(", ")})`);
  }
  // Stage 1b — copy canonical → package.
  const synced = [];
  for (const name of canonicalYmls) {
    const srcFile = join(canonicalBin, name);
    const dstFile = join(packageBin, name);
    copyFileSync(srcFile, dstFile);
    synced.push(name);
  }
  if (synced.length > 0) {
    console.log(`synced canonical YAML → package: ${canonicalBin} -> ${packageBin} (${synced.join(", ")})`);
  }
} else {
  console.warn(`canonical bin/ not found at ${canonicalBin}; skipping stage 1`);
}

// Stage 2 — package → dist (preserves prior behaviour).
if (!existsSync(packageBin)) {
  process.exit(0);
}
mkdirSync(dirname(distBin), { recursive: true });
cpSync(packageBin, distBin, { recursive: true });
console.log(`copied ${packageBin} -> ${distBin}`);
