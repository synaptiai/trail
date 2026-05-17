#!/usr/bin/env node
// `trail audit precommit` CLI. Argv parsing + I/O wiring around audit().
//
// Surface (per gh#3 issue body + orchestrator spec):
//
//   trail audit precommit [--staged-only] [--root <path>] [--patterns <path>]
//                         [--json] [--quiet]
//
// Exit codes (apps/audit/src/exit-codes.ts):
//   0 = clean
//   2 = git-state failure (--staged-only and not a repo, or diff failed)
//   4 = patterns YAML load failure
//   8 = policy violation (one or more findings)
//
// CLI-arg validation failures (unknown flag, bad path) exit 2 with a usage
// hint — these are infrastructural, not policy violations, and should not
// share the violation exit code.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { audit } from "./audit.js";
import { EXIT_GIT_STATE, EXIT_OK, EXIT_PATTERNS, EXIT_VIOLATION } from "./exit-codes.js";
import { reportViolations } from "./violations.js";

export const VERSION = "0.1.1";

export interface RunCliDeps {
  /** Sink for stderr writes. Test seam. */
  writeErr: (line: string) => void;
  /** Sink for stdout writes. Test seam (currently unused but reserved
   *  for a future --list-only flag). */
  writeOut: (line: string) => void;
}

const defaultDeps: RunCliDeps = {
  writeErr: (line) => process.stderr.write(line),
  writeOut: (line) => process.stdout.write(line),
};

export async function runCli(
  argv: string[],
  cwd: string = process.cwd(),
  deps: RunCliDeps = defaultDeps
): Promise<number> {
  const program = new Command();
  program
    .name("trail-audit")
    .description("Trail Layer 3 — pre-commit audit for unredacted secrets in .trail/ packets")
    .version(VERSION)
    .exitOverride((err) => {
      throw err;
    })
    // Suppress commander's auto-stderr error write — our catch handler
    // below is canonical. Without this, the error prints twice (rc.5 DF-S3).
    .configureOutput({ outputError: (str, _write) => void str });

  let pendingResult: number | null = null;

  program
    .command("precommit")
    .description("Scan staged or on-disk packets for unredacted secret-like patterns")
    .option("--staged-only", "Scan only files staged for commit (git diff --cached)", false)
    .option("--root <path>", "Repository root containing .trail/", cwd)
    .option("--patterns <path>", "User-supplied patterns YAML (overrides bundled)")
    .option("--json", "Emit one JSON object per finding to stderr (NDJSON)", false)
    .option("--quiet", "Suppress informational stderr on clean runs", false)
    .action(async (raw) => {
      const root = resolve(raw.root);
      const result = await audit({
        root,
        ...(typeof raw.patterns === "string" ? { patternsPath: raw.patterns } : {}),
        stagedOnly: !!raw.stagedOnly,
        quiet: !!raw.quiet,
      });

      // Exit 4 — patterns load.
      if (result.exitCode === EXIT_PATTERNS && result.patternsError) {
        deps.writeErr(`${result.patternsError.message}\n`);
        pendingResult = EXIT_PATTERNS;
        return;
      }
      // Exit 2 — git state.
      if (result.exitCode === EXIT_GIT_STATE && result.gitError) {
        deps.writeErr(`${result.gitError.message}\n`);
        pendingResult = EXIT_GIT_STATE;
        return;
      }

      // Diagnostics (OK / "no .trail/") — emit before any violation report.
      for (const line of result.diagnostics) deps.writeErr(line);

      if (result.exitCode === EXIT_VIOLATION) {
        reportViolations(result.findings, {
          baseDir: root,
          mode: raw.json ? "json" : "text",
          write: deps.writeErr,
        });
        pendingResult = EXIT_VIOLATION;
        return;
      }

      pendingResult = EXIT_OK;
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (
      e.code === "commander.help" ||
      e.code === "commander.helpDisplayed" ||
      e.code === "commander.version"
    ) {
      return EXIT_OK;
    }
    if (
      e.code === "commander.missingArgument" ||
      e.code === "commander.missingMandatoryOptionValue" ||
      e.code === "commander.unknownOption" ||
      e.code === "commander.invalidArgument" ||
      e.code === "commander.invalidOptionArgument" ||
      e.code === "commander.optionMissingArgument" ||
      e.code === "commander.unknownCommand"
    ) {
      deps.writeErr(`invalid args: ${e.message ?? "(unknown)"}\n`);
      // Use git-state exit (2) for arg parsing failures: from a pre-commit
      // hook's perspective, "I cannot determine what to scan" is the same
      // class of "infrastructure didn't work" outcome. Reserves the
      // violation code (8) for actual unredacted-content findings.
      return EXIT_GIT_STATE;
    }
    deps.writeErr(`${e.message ?? "unknown error"}\n`);
    return EXIT_GIT_STATE;
  }

  return pendingResult ?? EXIT_OK;
}

// Bin invocation goes through npm's symlink (see capture/src/cli.ts for the
// detailed rationale). Resolve both sides through `realpathSync` so the
// comparison survives npm-bin/pnpm/Yarn symlinks.
function isMainEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainEntrypoint()) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(EXIT_GIT_STATE);
    }
  );
}
