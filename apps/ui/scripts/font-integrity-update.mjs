#!/usr/bin/env node
/**
 * Populate SHA-256 fields in apps/ui/src/design/font-integrity.json from the
 * actual binaries in apps/ui/public/fonts/. Run after vendoring (or rotating)
 * any of the four declared font binaries. Files that are absent get sha256
 * set to null — runtime treats null as "pending vendor" and short-circuits
 * to the CSS fallback chain (Georgia / system-ui / JetBrains Mono / Menlo).
 *
 * Defenses:
 *   - Manifest schema validation (rejects non-array `fonts`, missing/typed
 *     fields).
 *   - Path-traversal guard (clamps `entry.path` inside `public/fonts/`).
 *   - Symlink rejection (defends against CI symlink injection writing
 *     arbitrary file hashes into the committed manifest).
 *   - Atomic write (writeFile-to-tmp + rename; POSIX-atomic on same volume).
 *   - Idempotent (no write when nothing changed).
 *
 * Exit codes (matches lint-css-tokens.mjs convention):
 *   0 — manifest in sync (no drift)
 *   1 — manifest drifted (entries updated; CI must detect uncommitted drift)
 *   2 — fatal error (parse / write / config failure)
 *
 * Per gh#5 Phase 4 / fonts/README.md vendor procedure step 4.
 */

import { createHash } from 'node:crypto';
import { lstatSync, renameSync, unlinkSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cycle-3 C3-S-SEC-5: reject leading `.` (or sequence thereof) to defend
// against `..woff2`-style entries that would slip through the character
// class. The downstream path-traversal guard (resolveFontPath) already
// catches the resolved-path escape, but defense-in-depth says the regex
// should refuse the malformed name at the front line.
const FONT_FILENAME_RE = /^(?!\.)[A-Za-z0-9._\[\],-]+\.woff2$/;

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, '..');
const manifestPath = join(uiRoot, 'src/design/font-integrity.json');
const fontsDir = resolve(uiRoot, 'public/fonts');

async function loadManifest() {
  let raw;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`manifest not found at ${manifestPath} — has the file been deleted?`);
    }
    throw new Error(`failed to read manifest at ${manifestPath}: ${err.message}`);
  }

  // Strip UTF-8 BOM if a Windows editor added one.
  const text = raw.replace(/^﻿/, '');

  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    throw new Error(`manifest is malformed JSON: ${err.message}`);
  }

  if (!Array.isArray(manifest.fonts)) {
    throw new Error("manifest.fonts must be an array — schema mismatch?");
  }

  for (const [i, entry] of manifest.fonts.entries()) {
    if (typeof entry?.path !== 'string') {
      throw new Error(`manifest.fonts[${i}].path must be a string`);
    }
    if (!FONT_FILENAME_RE.test(entry.path)) {
      throw new Error(`manifest.fonts[${i}].path '${entry.path}' is not a valid font filename`);
    }
    if (entry.sha256 !== null && typeof entry.sha256 !== 'string') {
      throw new Error(`manifest.fonts[${i}].sha256 must be a hex string or null`);
    }
  }

  return manifest;
}

function resolveFontPath(entryPath) {
  // Anchor inside fontsDir; reject any traversal even if the regex passed.
  const filePath = resolve(fontsDir, entryPath);
  const rel = relative(fontsDir, filePath);
  if (rel.startsWith('..') || resolve(fontsDir, rel) !== filePath) {
    throw new Error(`entry.path '${entryPath}' escapes fonts directory`);
  }
  return filePath;
}

// INVARIANT: hashFile() never traverses symlinks. lstat-only, fail-loud on
// stat errors. Cycle-3 C3-V-SEC-1 — surfaced this invariant explicitly so a
// future refactor (e.g., dropping lstatSync for fs.promises.stat which
// follows symlinks) is visibly wrong rather than silently widening trust.
async function hashFile(entry, filePath) {
  // Reject symlinks: a CI symlink-injection could write arbitrary file hashes
  // into the committed manifest.
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing to hash symlink: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`expected a regular file at ${filePath}, got something else`);
  }

  const buf = await readFile(filePath);
  const digest = createHash('sha256').update(buf).digest('hex');
  return { digest, size: buf.byteLength };
}

async function atomicWrite(path, body) {
  const tmp = `${path}.tmp`;
  // Cycle-3 C3-S-EH-1 + C3-V-EH-2 (consensus): if `writeFile` or
  // `renameSync` throws, the `.tmp` orphan persists on disk and pollutes
  // `git status`. The file is not gitignored (manifests live in
  // `apps/ui/src/design/` which has no `*.tmp` rule) so an interrupted
  // run could surface as an accidental commit. Wrap both calls in a
  // try/catch that unlinks the orphan on the failure path; swallow ENOENT
  // since `writeFile` may have failed before creating it.
  try {
    await writeFile(tmp, body, 'utf8');
    // renameSync is atomic on POSIX (same volume) and atomic-enough on Windows.
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch (cleanupErr) {
      if (cleanupErr?.code !== 'ENOENT') {
        // Cleanup failure is interesting but secondary to the original
        // write failure. Surface to stderr so an operator can manually
        // sweep, then re-throw the original error.
        console.error(
          `font-integrity-update: tmp cleanup also failed: ${cleanupErr.message}`,
        );
      }
    }
    throw err;
  }
}

async function main() {
  const manifest = await loadManifest();
  const originalText = JSON.stringify(manifest, null, 2);

  let updated = 0;
  let pending = 0;

  for (const entry of manifest.fonts) {
    const filePath = resolveFontPath(entry.path);
    const result = await hashFile(entry, filePath);

    if (result === null) {
      // Cycle-3 C3-S-EH-4: distinguish regressed-to-pending (was
      // vendored, now gone) from first-time-pending. A regression is a
      // stronger operator signal — surface it at warn-level. Either
      // way, emit exactly ONE `pending  <path>` stdout line so log
      // greps and existing test fixtures (cycle-1.5 batch 1) stay
      // grep-stable.
      const wasRegression = entry.sha256 !== null;
      if (wasRegression) {
        console.warn(
          `WARNING: ${entry.path} REGRESSED to pending — previously had sha256 ` +
            `${entry.sha256.slice(0, 12)}… but file is now absent. ` +
            `Setting sha256 to null.`,
        );
        entry.sha256 = null;
        updated++;
      }
      pending++;
      const reason = wasRegression
        ? `regressed; file not found at ${filePath}`
        : `file not found at ${filePath}`;
      console.log(`pending  ${entry.path} (${reason})`);
      continue;
    }

    if (entry.sha256 !== result.digest) {
      entry.sha256 = result.digest;
      updated++;
    }
    console.log(`vendored ${entry.path} (${result.size} bytes, sha256=${result.digest.slice(0, 12)}…)`);
  }

  const nextText = JSON.stringify(manifest, null, 2) + '\n';
  if (nextText !== originalText + '\n') {
    await atomicWrite(manifestPath, nextText);
  }

  console.log(`\n${updated} entry(ies) updated; ${pending} still pending vendor.`);

  // Exit 0 when no drift, 1 when manifest changed (CI can detect
  // uncommitted-drift via `git diff --exit-code` after running this).
  process.exit(updated > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`font-integrity-update: fatal: ${err.message}`);
  process.exit(2);
});
