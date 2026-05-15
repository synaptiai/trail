// Regression guard for the rc.4 bin-entrypoint bug.
//
// rc.4 shipped `if (import.meta.url === \`file://${process.argv[1]}\`)` as the
// "am I main?" check at the bottom of cli.ts. Node resolves import.meta.url
// through symlinks but leaves process.argv[1] symlinked under default flags,
// so when npm/pnpm/Yarn install the package globally and invoke the bin via
// symlink, the two paths NEVER match and runCli is silently skipped. Every
// `trail` invocation exited 0 with no output until rc.5.
//
// This test spawns the built dist/cli.js through a synthetic symlink (the
// exact shape `npm install -g` produces) and asserts --version produces real
// output. It is intentionally NOT a unit test of the helper — the unit-test
// loophole is what let rc.1-rc.4 ship: every existing test imports runCli
// directly from src/cli.ts, never exercising the entrypoint guard.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const distCli = join(packageRoot, "dist", "cli.js");

let tmpDir: string | null = null;

describe("bin entrypoint (regression: rc.4 silent no-op)", () => {
  beforeAll(() => {
    // Ensure dist/cli.js exists before we try to spawn it. CI typically runs
    // `pnpm build` before tests; local `pnpm test` does not, so build here if
    // missing. tsc is the same compiler that produces the published artifact.
    if (!existsSync(distCli)) {
      execSync("pnpm exec tsc", { cwd: packageRoot, stdio: "inherit" });
    }
    tmpDir = mkdtempSync(join(tmpdir(), "trail-bin-test-"));
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prints --version when invoked through an npm-style symlink", () => {
    if (!tmpDir) throw new Error("tmpDir not initialised");
    const symlink = join(tmpDir, "trail");
    symlinkSync(distCli, symlink);

    const result = spawnSync(process.execPath, [symlink, "--version"], {
      encoding: "utf8",
    });

    // The bug shape: exit 0 with empty stdout/stderr. Assert a real version
    // string lands on stdout. Don't tolerate empty output even if exit is 0.
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });

  it("prints --version when invoked directly (no symlink)", () => {
    // Sanity sibling check — if THIS fails, runCli itself is broken.
    const result = spawnSync(process.execPath, [distCli, "--version"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });
});
