// `trail audit precommit` orchestrator. Pure-ish (returns an exit code +
// findings) — no process.exit calls, no direct stderr writes. The CLI
// wrapper at cli.ts wires this to process I/O and exit.
//
// Two modes:
//
//   1. --staged-only (pre-commit hook mode): use `git diff --cached` to
//      enumerate staged-for-commit packet files; scan only those.
//
//   2. Default (manual / CI repo-wide mode): walk `<root>/.trail/` recursively
//      and scan every `packet-*.{yml,md}` file under `sessions/<sid>/`.
//      Parity with py-reference's "scan everything in .trail/" semantics,
//      narrowed to the packet boundary (see staged.ts comment for rationale).

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CompiledPattern, PatternLoadError, loadPatterns } from "@synapti/trail-capture";
import { EXIT_GIT_STATE, EXIT_OK, EXIT_PATTERNS, EXIT_VIOLATION } from "./exit-codes.js";
import { type Finding, scanFile } from "./scanner.js";
import { GitStateError, isPacketPath, listStagedPackets } from "./staged.js";

export interface AuditOptions {
  /** Repository root (resolved absolute path). */
  root: string;
  /** Path override for the patterns YAML; default = bundled. */
  patternsPath?: string;
  /** Pre-commit mode: `git diff --cached` instead of `.trail/` walk. */
  stagedOnly: boolean;
  /** Suppress the "OK — scanned N file(s)" stderr line on clean runs. */
  quiet: boolean;
}

export interface AuditResult {
  exitCode: number;
  findings: Finding[];
  /** Number of files actually scanned (0 if .trail/ absent in non-staged mode). */
  filesScanned: number;
  /** Stderr lines for non-violation diagnostics (info, OK summaries). */
  diagnostics: string[];
  /** Set when pattern load failed; CLI uses this to format exit-4 stderr. */
  patternsError?: PatternLoadError;
  /** Set when staged-files detection failed (only in --staged-only mode). */
  gitError?: GitStateError;
}

export async function audit(options: AuditOptions): Promise<AuditResult> {
  const diagnostics: string[] = [];

  // Stage 1 — load patterns. Exit 4 on any failure (parity with capture).
  let patterns: CompiledPattern[];
  try {
    const result = loadPatterns(options.patternsPath, { useCache: false });
    patterns = result.patterns;
  } catch (err) {
    if (err instanceof PatternLoadError) {
      return {
        exitCode: EXIT_PATTERNS,
        findings: [],
        filesScanned: 0,
        diagnostics,
        patternsError: err,
      };
    }
    throw err;
  }

  // Stage 2 — enumerate target files.
  let files: string[];
  if (options.stagedOnly) {
    try {
      files = await listStagedPackets({ cwd: options.root });
    } catch (err) {
      if (err instanceof GitStateError) {
        return {
          exitCode: EXIT_GIT_STATE,
          findings: [],
          filesScanned: 0,
          diagnostics,
          gitError: err,
        };
      }
      throw err;
    }
  } else {
    const trailDir = join(options.root, ".trail");
    if (!safeIsDirectory(trailDir)) {
      if (!options.quiet) {
        diagnostics.push(`[trail-audit] no .trail/ at ${trailDir}; nothing to scan\n`);
      }
      return { exitCode: EXIT_OK, findings: [], filesScanned: 0, diagnostics };
    }
    files = walkPackets(trailDir, options.root);
  }

  // Stage 3 — scan.
  const findings: Finding[] = [];
  for (const fp of files) {
    findings.push(...scanFile(fp, patterns));
  }

  if (findings.length === 0) {
    if (!options.quiet) {
      const where = options.stagedOnly
        ? "staged packet(s)"
        : `under ${join(options.root, ".trail")}`;
      diagnostics.push(`[trail-audit] OK — scanned ${files.length} ${where}\n`);
    }
    return { exitCode: EXIT_OK, findings, filesScanned: files.length, diagnostics };
  }

  return { exitCode: EXIT_VIOLATION, findings, filesScanned: files.length, diagnostics };
}

/**
 * Walk a directory tree collecting packet-shape files. Used in non-staged
 * mode. Skips symlinks, hidden files (other than the .trail anchor itself —
 * which we entered with an explicit path), and any path that doesn't match
 * the packet boundary. The boundary check uses paths relative to repoRoot
 * so isPacketPath() can apply the same `.trail/sessions/...` regex used
 * by the staged-mode code path (single source of boundary truth).
 */
function walkPackets(dir: string, repoRoot: string): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    // `withFileTypes: true` + no `encoding` override returns Dirent<string>
    // in @types/node ≥22; the explicit annotation pins the runtime
    // branch we exercise. The cast unifies the two overload return shapes
    // (utf8 string vs Buffer) — at runtime we always read string names
    // because we never pass a Buffer-encoded directory path.
    entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      out.push(...walkPackets(abs, repoRoot));
    } else if (entry.isFile()) {
      // Convert to forward-slash relative path for the boundary regex.
      const rel = absToRel(abs, repoRoot);
      if (isPacketPath(rel)) out.push(abs);
    }
  }
  return out;
}

function absToRel(abs: string, base: string): string {
  const a = resolve(abs).replace(/\\/g, "/");
  const b = resolve(base).replace(/\\/g, "/");
  if (a === b) return "";
  if (a.startsWith(`${b}/`)) return a.slice(b.length + 1);
  return a;
}

function safeIsDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
