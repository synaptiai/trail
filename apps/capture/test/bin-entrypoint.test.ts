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
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const distCli = join(packageRoot, "dist", "cli.js");
const distSchema = join(packageRoot, "dist", "schema", "pr-change-packet.v0.1.1.schema.json");

let tmpDir: string | null = null;

describe("bin entrypoint (regression: rc.4 silent no-op)", () => {
  beforeAll(() => {
    // Ensure dist/cli.js exists before we try to spawn it. CI typically runs
    // `pnpm build` before tests; local `pnpm test` does not, so build here if
    // missing. tsc + copy-bin is the same pipeline that produces the
    // published artifact. copy-bin.mjs ALSO populates dist/schema/ — required
    // by the rc.6 packaging regression test below (DF-S1).
    if (!existsSync(distCli) || !existsSync(distSchema)) {
      execSync("pnpm exec tsc", { cwd: packageRoot, stdio: "inherit" });
      execSync("node ./scripts/copy-bin.mjs", { cwd: packageRoot, stdio: "inherit" });
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

  // rc.6 packaging regression (DF-S1): the JSON Schema must be bundled
  // into dist/schema/ so the installed package can locate it at runtime.
  //
  // rc.1-rc.5 published without the schema (apps/capture/package.json#files
  // didn't list it, and defaultSchemaPath() resolved upward from src/ to a
  // path that didn't exist in the installed layout). Every npm-installed
  // `trail packet generate` exited 5 with SchemaValidatorInternalError.
  // copy-bin.mjs now syncs canonical schema/ → dist/schema/ at build, and
  // defaultSchemaPath() probes both layouts.
  it("bundles the JSON schema at dist/schema/ (DF-S1 packaging)", () => {
    expect(existsSync(distSchema)).toBe(true);
    const raw = readFileSync(distSchema, "utf8");
    const parsed = JSON.parse(raw) as { $id?: string; $schema?: string };
    expect(typeof parsed.$schema).toBe("string");
  });

  it("validator resolves schema to a real path from the dist tree", () => {
    // Exercise the EXACT path computation that runs in production. Importing
    // validate-schema from the src tree (as every other unit test does)
    // hits the src-fallback candidate; spawning Node against the compiled
    // dist file forces import.meta.url to dist/packet/validate-schema.js.
    const distValidator = join(packageRoot, "dist", "packet", "validate-schema.js");
    const distValidatorUrl = `file://${distValidator}`;
    const probe = [
      `import('${distValidatorUrl}')`,
      "  .then(m => { process.stdout.write(m.defaultSchemaPath()); })",
      "  .catch(e => { process.stderr.write(e.message); process.exit(1); });",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(distSchema);
  });
});
