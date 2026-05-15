// Regression guard for the rc.4 bin-entrypoint bug. See the matching test in
// apps/capture/test/bin-entrypoint.test.ts for the full rationale — same
// shape, different package.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const distCli = join(packageRoot, "dist", "cli.js");

let tmpDir: string | null = null;

describe("bin entrypoint (regression: rc.4 silent no-op)", () => {
  beforeAll(() => {
    if (!existsSync(distCli)) {
      execSync("pnpm exec tsc", { cwd: packageRoot, stdio: "inherit" });
    }
    tmpDir = mkdtempSync(join(tmpdir(), "trail-audit-bin-test-"));
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prints --version when invoked through an npm-style symlink", () => {
    if (!tmpDir) throw new Error("tmpDir not initialised");
    const symlink = join(tmpDir, "trail-audit");
    symlinkSync(distCli, symlink);

    const result = spawnSync(process.execPath, [symlink, "--version"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });

  it("prints --version when invoked directly (no symlink)", () => {
    const result = spawnSync(process.execPath, [distCli, "--version"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });
});
