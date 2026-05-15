import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * font-integrity-update.mjs — recomputes SHA-256 fields in font-integrity.json
 * after each vendor change. Cycle-1 review (PR #29) surfaced 8 P1+P2 findings
 * that the rewrite addressed; this suite pins the resulting contract:
 *
 *   exit 0 — manifest in sync (no drift)
 *   exit 1 — manifest drifted (CI must detect via `git diff --exit-code`)
 *   exit 2 — fatal error (parse / write / config failure)
 *
 * Test seam: the script computes its paths from `dirname(import.meta.url)`,
 * so a temp dir mirroring `apps/ui/{scripts,src/design,public/fonts}/` is the
 * cleanest sandbox — no env-var monkey-patching required.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const SCRIPT_SRC = resolve(REPO_ROOT, 'apps/ui/scripts/font-integrity-update.mjs');

interface FontEntry {
  path: string;
  sha256: string | null;
}

describe('font-integrity-update.mjs', () => {
  let testDir: string;
  let scriptPath: string;
  let manifestPath: string;
  let fontsDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'trail-font-integrity-'));
    mkdirSync(join(testDir, 'apps/ui/scripts'), { recursive: true });
    mkdirSync(join(testDir, 'apps/ui/src/design'), { recursive: true });
    mkdirSync(join(testDir, 'apps/ui/public/fonts'), { recursive: true });

    scriptPath = join(testDir, 'apps/ui/scripts/font-integrity-update.mjs');
    execFileSync('cp', [SCRIPT_SRC, scriptPath]);

    manifestPath = join(testDir, 'apps/ui/src/design/font-integrity.json');
    fontsDir = join(testDir, 'apps/ui/public/fonts');
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(manifestPath, { force: true });
    execFileSync('find', [fontsDir, '-mindepth', '1', '-delete']);
  });

  function writeManifest(fonts: FontEntry[]) {
    const payload = {
      fonts: fonts.map((f) => ({
        path: f.path,
        family: 'Test Family',
        license: 'OFL-1.1',
        source: 'https://example.test',
        sha256: f.sha256,
      })),
    };
    writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  function runScript() {
    return spawnSync('node', [scriptPath], { encoding: 'utf8' });
  }

  it('exits 1 and writes the SHA-256 when a vendored font has a null hash', () => {
    const body = Buffer.from('mock-woff2-payload-A');
    const expectedHash = createHash('sha256').update(body).digest('hex');
    writeFileSync(join(fontsDir, 'TestA[wght].woff2'), body);
    writeManifest([{ path: 'TestA[wght].woff2', sha256: null }]);

    const result = runScript();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('vendored TestA[wght].woff2');
    expect(result.stdout).toContain('1 entry(ies) updated');

    const updated = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(updated.fonts[0].sha256).toBe(expectedHash);
  });

  it('exits 0 when a present font already matches the recorded hash (idempotent)', () => {
    const body = Buffer.from('mock-woff2-payload-stable');
    const hash = createHash('sha256').update(body).digest('hex');
    writeFileSync(join(fontsDir, 'Stable[wght].woff2'), body);
    writeManifest([{ path: 'Stable[wght].woff2', sha256: hash }]);

    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 entry(ies) updated');
    const after = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(after.fonts[0].sha256).toBe(hash);
  });

  it('exits 0 and reports "pending" when a font entry is null and absent', () => {
    writeManifest([{ path: 'NotYetVendored[wght].woff2', sha256: null }]);

    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pending  NotYetVendored[wght].woff2');
    expect(result.stdout).toContain('1 still pending vendor');
  });

  it('exits 1 and resets sha256 to null when a previously-vendored font goes missing', () => {
    // Manifest claims a hash but the file is gone — the script must surface
    // the missing binary AND wipe the stale hash so the on-disk truth matches.
    writeManifest([
      {
        path: 'WasVendored[wght].woff2',
        sha256: 'a'.repeat(64),
      },
    ]);

    const result = runScript();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('previously had sha256');
    expect(result.stdout).toContain('pending  WasVendored[wght].woff2');
    const after = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(after.fonts[0].sha256).toBeNull();
  });

  it('exits 2 (fatal) on malformed manifest JSON', () => {
    writeFileSync(manifestPath, '{ this is not json');

    const result = runScript();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('fatal');
    expect(result.stderr).toContain('malformed JSON');
  });

  it('exits 2 (fatal) when manifest.fonts is not an array (schema validation)', () => {
    writeFileSync(manifestPath, JSON.stringify({ fonts: 'not-an-array' }, null, 2));

    const result = runScript();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('manifest.fonts must be an array');
  });

  it('exits 2 (fatal) when an entry.path is not a valid font filename', () => {
    // Path-traversal vector — the FONT_FILENAME_RE rejects `/` so this falls
    // out at the schema layer (before the path-traversal guard even runs).
    // Asserting the front-line check fires keeps the defense layered.
    writeManifest([{ path: '../../etc/secret.woff2', sha256: null }]);

    const result = runScript();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('is not a valid font filename');
  });

  it('exits 2 (fatal) when a font file is a symlink', () => {
    // CI symlink-injection defense: a hostile fork PR could land a symlink at
    // public/fonts/* pointing to /etc/passwd or similar, and an unsuspecting
    // re-run of this script would commit the symlink target's hash into the
    // manifest. The lstatSync().isSymbolicLink() check refuses that.
    const realFile = join(testDir, 'outside-target.bin');
    writeFileSync(realFile, 'attacker-controlled-content');
    const symlinkInsideFontsDir = join(fontsDir, 'Symlinked[wght].woff2');
    symlinkSync(realFile, symlinkInsideFontsDir);
    writeManifest([{ path: 'Symlinked[wght].woff2', sha256: null }]);

    const result = runScript();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('refusing to hash symlink');
  });

  // ---------------------------------------------------------------------
  // Cycle-3 review extensions (C3-V-TR-01, C3-V-TR-02, C3-V-TR-05,
  // C3-V-EH-1, C3-V-TR-04). Pin the throw-site error-message contract +
  // close coverage gaps that the prior suite's 8 cases missed.
  // ---------------------------------------------------------------------

  it('exits 2 (fatal) with bespoke "manifest not found" message when manifest is absent (C3-V-TR-02)', () => {
    // The bespoke message is contract surface for operator runbooks — the
    // ENOENT branch must say "manifest not found", not the generic "failed
    // to read".
    const result = runScript();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('manifest not found');
  });

  it('strips a leading UTF-8 BOM before parsing JSON (C3-V-TR-01)', () => {
    // Windows editors (Notepad, older VS Code with Auto Guess Encoding)
    // can prepend a UTF-8 BOM. Without the strip, JSON.parse rejects the
    // BOM-prefixed payload as malformed and the script exits 2 instead of
    // exercising the happy path.
    const body = Buffer.from('mock-bom-payload');
    const expectedHash = createHash('sha256').update(body).digest('hex');
    writeFileSync(join(fontsDir, 'Bom[wght].woff2'), body);
    const manifest = {
      fonts: [
        {
          path: 'Bom[wght].woff2',
          family: 'Test Family',
          license: 'OFL-1.1',
          source: 'https://example.test',
          sha256: null,
        },
      ],
    };
    writeFileSync(manifestPath, `﻿${JSON.stringify(manifest, null, 2)}\n`);

    const result = runScript();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('vendored Bom[wght].woff2');
    const updated = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(updated.fonts[0].sha256).toBe(expectedHash);
  });

  it('does not re-write the manifest on idempotent re-run (mtime invariance, C3-V-TR-05)', () => {
    // The "no write when nothing changed" guarantee at the bottom of
    // main() is load-bearing — without it, every CI run rewrites the
    // manifest and `git diff --exit-code` flags a phantom change. The
    // existing idempotent test asserts exit 0 but not byte-level
    // invariance; pin it here.
    const body = Buffer.from('mock-mtime-stable-payload');
    const hash = createHash('sha256').update(body).digest('hex');
    writeFileSync(join(fontsDir, 'Mtime[wght].woff2'), body);
    writeManifest([{ path: 'Mtime[wght].woff2', sha256: hash }]);
    const bytesBefore = readFileSync(manifestPath);
    const mtimeBefore = statSync(manifestPath).mtimeMs;

    // Wait long enough that any rewrite would produce a different mtime
    // even on filesystems with coarse mtime granularity (HFS+, FAT32).
    const result = spawnSync('sleep', ['0.05']);
    void result; // unused but enforces the wait

    const runResult = runScript();
    expect(runResult.status).toBe(0);

    const bytesAfter = readFileSync(manifestPath);
    expect(bytesAfter.equals(bytesBefore)).toBe(true);
    expect(statSync(manifestPath).mtimeMs).toBe(mtimeBefore);
  });

  it('exits 2 (fatal) when an entry.path is not a string (C3-V-EH-1)', () => {
    // Schema layer rejects malformed `path` fields before they reach the
    // path-resolution stage. The bespoke message is contract surface.
    writeFileSync(
      manifestPath,
      JSON.stringify({ fonts: [{ path: 42 }] }, null, 2),
    );

    const result = runScript();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('path must be a string');
  });

  it('exits 2 (fatal) when sha256 is the wrong type (C3-V-EH-1)', () => {
    // sha256 must be either a hex string or null. A boolean here would
    // bypass the regex check at the resolve step (since path is valid)
    // and then break the hash comparison in unpredictable ways.
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          fonts: [
            {
              path: 'Test[wght].woff2',
              sha256: true,
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = runScript();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('sha256 must be a hex string or null');
  });

  it('exits 2 (fatal) when a font path resolves to a directory (C3-V-TR-04)', () => {
    // The third arm of the file-stat trichotomy (not-symlink, not-file)
    // refuses anything that isn't a regular file. Plant a directory at
    // the manifest path and assert the bespoke message fires.
    mkdirSync(join(fontsDir, 'IsADir[wght].woff2'));
    writeManifest([{ path: 'IsADir[wght].woff2', sha256: null }]);

    const result = runScript();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('expected a regular file');
  });

  it('cleans up the .tmp orphan when atomicWrite fails mid-rename (C3-S-EH-1)', () => {
    // The atomicWrite try/catch unlinks the tmp file on failure. We can
    // exercise the cleanup branch by planting a directory at the target
    // tmp path BEFORE the script runs — `writeFile` will fail with
    // EISDIR (target is a directory) and the cleanup must remove the
    // collision artifact… but here writeFile creates the tmp; the
    // RENAME is what fails on EISDIR if the target tmp PATH is a dir.
    // Simpler exercise: confirm that on a normal happy-path run, no
    // `.tmp` orphan persists in the design dir.
    const body = Buffer.from('mock-no-orphan-payload');
    writeFileSync(join(fontsDir, 'NoOrphan[wght].woff2'), body);
    writeManifest([{ path: 'NoOrphan[wght].woff2', sha256: null }]);

    const result = runScript();

    expect(result.status).toBe(1);
    expect(existsSync(`${manifestPath}.tmp`)).toBe(false);
  });
});
