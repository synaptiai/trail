import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Secrets scanner — bin/secrets-scan.mjs (B5 §6.2 secrets-scan).
 *
 * Per PR #6 cycle-2 review N15 (P1 ci-correctness consensus HIGH):
 *
 *   The prior CI step used `grep -E` (POSIX ERE), which does NOT support
 *   `\b` word-boundary anchors. Most catalog patterns use `\b`, so the job
 *   ran green but matched nothing. The scanner is now a Node script using
 *   Node's RegExp engine (PCRE-compatible). These tests prove the scanner
 *   actually catches secrets — not just appears to.
 *
 * Coverage:
 *   1. The scanner's --self-test mode passes (every catalog pattern matches
 *      its planted fixture).
 *   2. End-to-end: a fresh git repo with a real `ghp_*` token in a non-
 *      allowlisted file causes the scanner to exit non-zero.
 *   3. Negative case: a clean diff exits 0.
 *   4. Allowlist honored: a planted secret in an allowlisted path (e.g.,
 *      .test.ts file) does NOT trigger a hit.
 *   5. Lockfile regression (PR #6 cycle-3.5 C3-N1): integrity hashes inside
 *      pnpm-lock.yaml / Cargo.lock / package-lock.json / yarn.lock are
 *      structurally identical to the `high-entropy-string` pattern but are
 *      not human-authored secrets — they must be allowlisted, AND a real
 *      planted secret in a non-lockfile path must still fire. Both
 *      directions are asserted to prevent the cycle-2-style "illusory safety
 *      net" failure mode.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const SCANNER = resolve(REPO_ROOT, 'bin/secrets-scan.mjs');

describe('secrets-scan.mjs', () => {
  it('passes its own self-test (planted secrets matched per pattern)', () => {
    const result = spawnSync('node', [SCANNER, '--self-test'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(
        `self-test exited ${result.status}\n` +
          `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }
    expect(result.stdout).toContain('SELF-TEST PASSED');
  });

  describe('end-to-end diff scan', () => {
    let testRepo: string;

    beforeAll(() => {
      testRepo = mkdtempSync(join(tmpdir(), 'trail-secrets-e2e-'));
      mkdirSync(join(testRepo, 'bin'), { recursive: true });
      // Stage a copy of the scanner + catalog so the test repo can run it.
      execFileSync('cp', [SCANNER, join(testRepo, 'bin/secrets-scan.mjs')]);
      execFileSync('cp', [
        resolve(REPO_ROOT, 'bin/trail-redaction-patterns.yml'),
        join(testRepo, 'bin/trail-redaction-patterns.yml'),
      ]);

      execFileSync('git', ['init', '-q'], { cwd: testRepo });
      execFileSync('git', ['config', 'user.email', 'test@trail.local'], { cwd: testRepo });
      execFileSync('git', ['config', 'user.name', 'trail-test'], { cwd: testRepo });
      writeFileSync(join(testRepo, 'harmless.txt'), '// harmless content\n');
      execFileSync('git', ['add', '.'], { cwd: testRepo });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: testRepo });
    });

    afterAll(() => {
      rmSync(testRepo, { recursive: true, force: true });
    });

    // Cycle-2 C19 (PR #21): per-test reset runs in afterEach so it executes
    // even if a prior assertion threw — previously inline `git reset --hard
    // HEAD~1` at the end of each test was skipped on failure, leaving the
    // shared mutable testRepo in a polluted state and cascading failures
    // into subsequent tests. Now: each test commits at most one new top
    // commit, and afterEach resets to the init commit (HEAD that existed
    // before any test ran).
    afterEach(() => {
      // The init commit is the only commit before any test runs; reset to
      // its sha so we always return to a known-clean baseline regardless of
      // how many commits the failed test created.
      const initSha = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
        cwd: testRepo,
        encoding: 'utf8',
      }).trim();
      execFileSync('git', ['reset', '-q', '--hard', initSha], { cwd: testRepo });
      execFileSync('git', ['clean', '-qfd'], { cwd: testRepo });
    });

    it('exits non-zero when a planted ghp_* token lands in a non-allowlisted file', () => {
      // Plant a known-shape GitHub token in harmless.txt (not allowlisted).
      const planted = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      writeFileSync(join(testRepo, 'harmless.txt'), `// content\n${planted}\n`);
      execFileSync('git', ['add', '.'], { cwd: testRepo });
      execFileSync('git', ['commit', '-q', '-m', 'planted-leak'], { cwd: testRepo });

      const result = spawnSync(
        'node',
        ['bin/secrets-scan.mjs', '--diff', 'HEAD~1...HEAD'],
        { cwd: testRepo, encoding: 'utf8' },
      );
      // Scanner MUST exit non-zero on a real planted secret. If it exits 0,
      // the safety net is illusory — the cycle-2 N15 finding would re-emerge.
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('github-token');
      expect(result.stderr).toContain(planted);
    });

    it('exits zero when the diff has no secrets', () => {
      writeFileSync(join(testRepo, 'harmless.txt'), '// just adding a comment\n');
      execFileSync('git', ['add', '.'], { cwd: testRepo });
      execFileSync('git', ['commit', '-q', '-m', 'clean-change'], { cwd: testRepo });

      const result = spawnSync(
        'node',
        ['bin/secrets-scan.mjs', '--diff', 'HEAD~1...HEAD'],
        { cwd: testRepo, encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('no redaction-pattern matches');
    });

    it('honors the allowlist (planted secret inside apps/*/tests/*.test.ts is tolerated)', () => {
      // Files matching ALLOWLIST_PATHS (apps/*/tests/**/*.test.ts, .claude/,
      // docs/specs/, lockfiles, etc.) are excluded from diff scanning. A
      // planted secret inside such a file must NOT cause a violation.
      //
      // Cycle-1.5 F7 (PR #21): the path-shape was tightened from a
      // suffix-match (any .test.ts anywhere) to a directory-scoped match
      // (apps/*/tests/**/*.test.ts) so test-fixture noise stays silenced
      // where tests actually live, but stray .test.ts files outside test
      // directories no longer get blanket-allowlisted.
      const planted = 'ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      mkdirSync(join(testRepo, 'apps/ui/tests/unit'), { recursive: true });
      writeFileSync(
        join(testRepo, 'apps/ui/tests/unit/fixture.test.ts'),
        `// allowlisted: ${planted}\n`,
      );
      execFileSync('git', ['add', '.'], { cwd: testRepo });
      execFileSync('git', ['commit', '-q', '-m', 'allowlisted-fixture'], {
        cwd: testRepo,
      });

      const result = spawnSync(
        'node',
        ['bin/secrets-scan.mjs', '--diff', 'HEAD~1...HEAD'],
        { cwd: testRepo, encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
    });

    // Cycle-1.5 F7 regression — assert the tightened allowlist DOES NOT
    // silently silence stray .test.ts files outside the apps/*/tests
    // directory. Before F7 a planted secret in `random/dir/x.test.ts`
    // would have been allowlisted by the unscoped suffix match; after F7
    // it must fire.
    it('fires on planted secret in non-test-dir .test.ts (F7 regression)', () => {
      const planted = 'ghp_cccccccccccccccccccccccccccccccccccc';
      mkdirSync(join(testRepo, 'random/dir'), { recursive: true });
      writeFileSync(
        join(testRepo, 'random/dir/stray.test.ts'),
        `// stray test file in non-test-dir: ${planted}\n`,
      );
      execFileSync('git', ['add', '.'], { cwd: testRepo });
      execFileSync('git', ['commit', '-q', '-m', 'stray-test-fixture'], {
        cwd: testRepo,
      });

      const result = spawnSync(
        'node',
        ['bin/secrets-scan.mjs', '--diff', 'HEAD~1...HEAD'],
        { cwd: testRepo, encoding: 'utf8' },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('github-token');
    });

    // PR #6 cycle-3.5 regression test for C3-N1.
    //
    // Pre-fix evidence (HEAD 6acc23d, before this commit):
    //   `node bin/secrets-scan.mjs --diff origin/main...HEAD` produced
    //   1,409 false positives — every SHA-512 integrity hash in
    //   pnpm-lock.yaml and most SHA-256 checksums in Cargo.lock matched
    //   the `high-entropy-string` pattern (\b[A-Za-z0-9+]{40,}={0,2}\b).
    //   The CI `secrets-scan` job was RED. Cycle-1 missed this because
    //   `grep -E` (POSIX ERE) silently no-op'd on \b anchors; cycle-3's
    //   PCRE engine surfaced the latent FPs.
    //
    // The fix: add lockfile basenames to ALLOWLIST_PATHS. This test
    // proves both directions:
    //   (a) lockfile integrity hashes are tolerated (no FPs), AND
    //   (b) a real planted secret in a non-lockfile path STILL fires —
    //       we did not blunt the scanner; we narrowed it.
    it(
      'allowlists lockfile integrity hashes but still fires on secrets ' +
        'in non-lockfile paths (C3-N1 regression)',
      () => {
        // (a) Plant a realistic SHA-512 base64 integrity hash inside
        //     pnpm-lock.yaml — the exact shape that produced 1,409 FPs
        //     pre-fix. The string is 88 chars of base64, matching the
        //     output of `sha512` on registry tarballs.
        const integrityHash =
          'krKnYRV7JKKPUXMEh61soaHKg9mrWEhzFWhFnxPxGl+69cD1Ou63C13NUPCnmIcrvqCuM6w';
        const lockfileBody =
          "lockfileVersion: '9.0'\n" +
          'packages:\n' +
          "  '/example-pkg@1.0.0':\n" +
          `    resolution: {integrity: sha512-${integrityHash}==}\n`;
        writeFileSync(join(testRepo, 'pnpm-lock.yaml'), lockfileBody);

        // (b) Plant a real GitHub token in a non-allowlisted path. The
        //     scanner MUST still catch this — narrowing the allowlist to
        //     lockfiles must not blunt detection elsewhere.
        const realSecret = 'ghp_cccccccccccccccccccccccccccccccccccc';
        writeFileSync(
          join(testRepo, 'src.txt'),
          `// inadvertently committed\n${realSecret}\n`,
        );

        execFileSync('git', ['add', '.'], { cwd: testRepo });
        execFileSync('git', ['commit', '-q', '-m', 'lockfile+secret'], {
          cwd: testRepo,
        });

        const result = spawnSync(
          'node',
          ['bin/secrets-scan.mjs', '--diff', 'HEAD~1...HEAD'],
          { cwd: testRepo, encoding: 'utf8' },
        );

        // Must fire — the planted ghp_* token is in a non-lockfile path.
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('github-token');
        expect(result.stderr).toContain(realSecret);
        // Must NOT cite the lockfile — the FP class this commit fixed.
        expect(result.stderr).not.toContain('pnpm-lock.yaml');
        // And specifically must not flag the integrity hash itself.
        expect(result.stderr).not.toContain(integrityHash);
      },
    );

    it(
      'allowlists Cargo.lock at any depth (nested workspace coverage)',
      () => {
        // Cargo.lock can live at the repo root or inside nested workspaces
        // (e.g., apps/ui/src-tauri/Cargo.lock). The allowlist regex must
        // cover both. Plant a realistic SHA-256 hex checksum entry.
        const checksum =
          '320119579fcad9c21884f5c4861d16174d0e06250625266f50fe6898340abefa';
        const cargoLockBody =
          '# This file is automatically @generated by Cargo.\n' +
          '[[package]]\n' +
          'name = "example"\n' +
          'version = "1.0.0"\n' +
          'source = "registry+https://github.com/rust-lang/crates.io-index"\n' +
          `checksum = "${checksum}"\n`;
        const nestedDir = join(testRepo, 'crates', 'inner');
        mkdirSync(nestedDir, { recursive: true });
        writeFileSync(join(nestedDir, 'Cargo.lock'), cargoLockBody);

        execFileSync('git', ['add', '.'], { cwd: testRepo });
        execFileSync('git', ['commit', '-q', '-m', 'nested-cargo-lock'], {
          cwd: testRepo,
        });

        const result = spawnSync(
          'node',
          ['bin/secrets-scan.mjs', '--diff', 'HEAD~1...HEAD'],
          { cwd: testRepo, encoding: 'utf8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('no redaction-pattern matches');
      },
    );

    // Cycle-2 C1 regression (PR #21): the Phase 1 singular `test/` directory
    // convention used by apps/capture and apps/audit was not in the
    // cycle-1.5 F7 allowlist, which only covered plural `tests/`. A real
    // synthetic ghp_* token planted in a path matching
    // `apps/<x>/test/<y>.test.ts` would have caused secrets-scan to fire
    // (false positive). C1 reopens those paths; this regression test pins
    // the allowlist behaviour for both `test/` and `test/fixtures/`.
    it('honors the singular apps/*/test/ allowlist (C1 regression)', () => {
      const planted = 'ghp_dddddddddddddddddddddddddddddddddddd';
      mkdirSync(join(testRepo, 'apps/capture/test'), { recursive: true });
      writeFileSync(
        join(testRepo, 'apps/capture/test/synthetic.test.ts'),
        `// allowlisted phase-1 test fixture: ${planted}\n`,
      );
      execFileSync('git', ['add', '.'], { cwd: testRepo });
      execFileSync('git', ['commit', '-q', '-m', 'phase1-test-fixture'], {
        cwd: testRepo,
      });

      const result = spawnSync(
        'node',
        ['bin/secrets-scan.mjs', '--diff', 'HEAD~1...HEAD'],
        { cwd: testRepo, encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
    });

    it('honors the apps/*/test/fixtures/ allowlist (C1 regression)', () => {
      // Audit redaction-matrix fixtures contain intentionally-shaped
      // synthetic secrets. They must not trigger secrets-scan.
      const planted = 'ghp_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      mkdirSync(join(testRepo, 'apps/audit/test/fixtures'), { recursive: true });
      writeFileSync(
        join(testRepo, 'apps/audit/test/fixtures/secrets.txt'),
        `# allowlisted fixture: ${planted}\n`,
      );
      execFileSync('git', ['add', '.'], { cwd: testRepo });
      execFileSync('git', ['commit', '-q', '-m', 'audit-fixture'], {
        cwd: testRepo,
      });

      const result = spawnSync(
        'node',
        ['bin/secrets-scan.mjs', '--diff', 'HEAD~1...HEAD'],
        { cwd: testRepo, encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
    });

    // Phase 4 cycle-1 review F2-24 regression. The font-integrity manifest
    // pins SHA-256 hex digests of vendored OFL fonts:
    //
    //   { "sha256": "1faa3380ac0e87e057b180e03fd94bd708a612afb67d…" }
    //
    // 64-char hex strings collide with the `high-entropy-string` pattern
    // exactly the way lockfile integrity hashes do (C3-N1). The allowlist
    // entry must:
    //   (a) silence hashes in `apps/ui/src/design/font-integrity.json`
    //   (b) NOT silence the same hash shape elsewhere (path-anchored)
    //   (c) be exactly anchored — `…/font-integrity.json.bak` must still fire
    //
    // All three directions are asserted so a future refactor that
    // accidentally widens the regex (e.g., dropping `^` or `$`) reddens.
    it('allowlists SHA-256 hex digests inside font-integrity.json', () => {
      const sha256Hex =
        '1faa3380ac0e87e057b180e03fd94bd708a612afb67d2590677be4508909fae9';
      const manifestBody = JSON.stringify(
        {
          fonts: [
            {
              path: 'Newsreader[opsz,wght].woff2',
              sha256: sha256Hex,
            },
          ],
        },
        null,
        2,
      );
      mkdirSync(join(testRepo, 'apps/ui/src/design'), { recursive: true });
      writeFileSync(
        join(testRepo, 'apps/ui/src/design/font-integrity.json'),
        `${manifestBody}\n`,
      );
      execFileSync('git', ['add', '.'], { cwd: testRepo });
      execFileSync('git', ['commit', '-q', '-m', 'font-integrity-manifest'], {
        cwd: testRepo,
      });

      const result = spawnSync(
        'node',
        ['bin/secrets-scan.mjs', '--diff', 'HEAD~1...HEAD'],
        { cwd: testRepo, encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('no redaction-pattern matches');
    });

    it('still fires on a 64-char hex digest in a non-allowlisted JSON path', () => {
      // Same 64-char hex shape, different path — the allowlist must be
      // anchored to the exact font-integrity.json location, not to the
      // hash shape. If this assertion ever fails, the allowlist regex
      // has been widened too far.
      const sha256Hex =
        '1faa3380ac0e87e057b180e03fd94bd708a612afb67d2590677be4508909fae9';
      mkdirSync(join(testRepo, 'apps/ui/src/design'), { recursive: true });
      writeFileSync(
        join(testRepo, 'apps/ui/src/design/other-manifest.json'),
        `{"sha256":"${sha256Hex}"}\n`,
      );
      execFileSync('git', ['add', '.'], { cwd: testRepo });
      execFileSync('git', ['commit', '-q', '-m', 'unrelated-manifest'], {
        cwd: testRepo,
      });

      const result = spawnSync(
        'node',
        ['bin/secrets-scan.mjs', '--diff', 'HEAD~1...HEAD'],
        { cwd: testRepo, encoding: 'utf8' },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('high-entropy-string');
      expect(result.stderr).toContain(sha256Hex);
    });

    it('does not allowlist look-alikes (font-integrity.json.bak, suffix attacks)', () => {
      // `^…/font-integrity\.json$` is exactly anchored: a backup or copy
      // with any trailing characters must still be scanned.
      const sha256Hex =
        '1faa3380ac0e87e057b180e03fd94bd708a612afb67d2590677be4508909fae9';
      mkdirSync(join(testRepo, 'apps/ui/src/design'), { recursive: true });
      writeFileSync(
        join(testRepo, 'apps/ui/src/design/font-integrity.json.bak'),
        `{"sha256":"${sha256Hex}"}\n`,
      );
      execFileSync('git', ['add', '.'], { cwd: testRepo });
      execFileSync('git', ['commit', '-q', '-m', 'backup-manifest'], {
        cwd: testRepo,
      });

      const result = spawnSync(
        'node',
        ['bin/secrets-scan.mjs', '--diff', 'HEAD~1...HEAD'],
        { cwd: testRepo, encoding: 'utf8' },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('high-entropy-string');
    });
  });

  describe('--files path traversal guard (C11)', () => {
    // Cycle-2 C11 (PR #21): `runFiles` previously did `readFileSync(resolve(
    // REPO_ROOT, path), ...)` without verifying the resolved path stays
    // within REPO_ROOT, so an invocation like
    //   node bin/secrets-scan.mjs --files ../../../etc/passwd
    // would happily read and scan a file outside the repo. Exit code 2
    // signals "tool error" (vs. 1 = "secrets found"); pre-commit hooks
    // gate on != 0 today, so semantics tighten without regressing existing
    // CI usage.
    it('rejects paths that escape the repo root (exit 2)', () => {
      const result = spawnSync(
        'node',
        [SCANNER, '--files', '../../../etc/passwd'],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('tool error');
      expect(result.stderr).toContain('escapes repo root');
    });

    it('returns exit 2 (not 1) when a passed path does not exist', () => {
      const result = spawnSync(
        'node',
        [SCANNER, '--files', 'nonexistent-file-xyz.txt'],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('tool error');
    });
  });
});
