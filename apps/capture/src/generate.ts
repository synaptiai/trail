// Top-level pipeline orchestrator. Implements spec §3 default behavior steps 2–11.

import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type LlmRunner, synthesizeLlm } from "./claims/llm.js";
import { synthesizeMechanical } from "./claims/mechanical.js";
import { extract } from "./extract/extract.js";
import { GitNotARepoError, type GitState, collectGitState } from "./git/state.js";
import { atomicWrite } from "./io/atomic.js";
import { signalCleanupHandle } from "./io/signals.js";
import { buildPacket } from "./packet/build.js";
import { detectRecapture } from "./packet/recapture.js";
import type { Packet } from "./packet/types.js";
import { validateRefs } from "./packet/validate-refs.js";
import {
  SchemaValidatorInternalError,
  type ValidationIssue,
  validateStructural,
} from "./packet/validate-schema.js";
import { dumpYaml } from "./packet/yaml.js";
import { Redactor } from "./redaction/layer1.js";
import { scanLayer2 } from "./redaction/layer2.js";
import { PatternLoadError, type PatternLoadResult, loadPatterns } from "./redaction/patterns.js";
import { renderMarkdown } from "./render/markdown.js";
import { NoopStorageWriter } from "./storage/noop.js";
import type { StorageWriter } from "./storage/types.js";
import { TestRunnerLoadError, loadTestRunnerRegex } from "./test-runners/patterns.js";
import {
  TranscriptNotFoundError,
  findTranscript,
  readTranscriptSync,
} from "./transcript/reader.js";

export interface GenerateOptions {
  sessionId: string;
  cwd: string;
  outputDir?: string | undefined;
  noLlm: boolean;
  llmModel: string;
  llmBudgetUsd: number;
  llmTimeoutSeconds: number;
  perDiff: boolean;
  format: "yaml" | "md" | "both";
  patternsPath?: string | undefined;
  strictRedaction: boolean;
  strictLlm: boolean;
  dryRun: boolean;
  noStorage: boolean;
  quiet: boolean;
  llmRunner?: LlmRunner | undefined;
  storageWriter?: StorageWriter | undefined;
  // Test seams:
  generatedAt?: string | undefined;
  packetId?: string | undefined;
  homeOverride?: string | undefined;
  transcriptPath?: string | undefined;
  schemaPath?: string | undefined;
}

export interface GenerateResult {
  exitCode: number;
  packet?: Packet | undefined;
  yamlPath?: string | undefined;
  mdPath?: string | undefined;
  yamlBytes?: string | undefined;
  mdBytes?: string | undefined;
  validationErrors: { kind: string; message: string }[];
  notices: string[];
  warnings: string[];
}

function stderr(opts: GenerateOptions, message: string, bypassQuiet = false): void {
  if (opts.quiet && !bypassQuiet) return;
  process.stderr.write(`${message}\n`);
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const notices: string[] = [];
  const warnings: string[] = [];
  const validationErrors: { kind: string; message: string }[] = [];

  // Step 3: git state.
  let gitState: GitState | undefined;
  try {
    gitState = collectGitState(opts.cwd);
  } catch (err) {
    if (err instanceof GitNotARepoError) {
      stderr(opts, `not a git repository: ${err.path}`, true);
      return { exitCode: 3, validationErrors, notices, warnings };
    }
    stderr(opts, `git state corrupt: ${(err as Error).message}`, true);
    return { exitCode: 3, validationErrors, notices, warnings };
  }

  // Step 4: transcript.
  let transcriptPath: string;
  try {
    transcriptPath = opts.transcriptPath ?? (await findTranscript(opts.sessionId));
  } catch (err) {
    if (err instanceof TranscriptNotFoundError) {
      stderr(opts, err.message, true);
      return { exitCode: 2, validationErrors, notices, warnings };
    }
    stderr(opts, `transcript discovery failed: ${(err as Error).message}`, true);
    return { exitCode: 2, validationErrors, notices, warnings };
  }
  const records = readTranscriptSync(transcriptPath);

  // Step 5: redaction patterns.
  let patternResult: PatternLoadResult;
  try {
    patternResult = loadPatterns(opts.patternsPath, { useCache: false });
  } catch (err) {
    if (err instanceof PatternLoadError) {
      stderr(opts, err.message, true);
      return { exitCode: 4, validationErrors, notices, warnings };
    }
    throw err;
  }
  const redactor = new Redactor(patternResult.patterns);

  // Step 6: test runners.
  let testCommandRe: RegExp;
  try {
    testCommandRe = loadTestRunnerRegex();
  } catch (err) {
    if (err instanceof TestRunnerLoadError) {
      stderr(opts, err.message, true);
      return { exitCode: 4, validationErrors, notices, warnings };
    }
    throw err;
  }

  // Step 7: gitignore notice (best-effort; full implementation deferred).
  // We emit a notice when .gitignore does not exclude .trail/, regardless of
  // home-touch-file (Phase 1 OSS can defer the touch-file logic to v0.2 — we
  // only need the symptom-side guarantee that the notice fires when it should
  // and bypasses --quiet).
  const gitignorePath = join(opts.cwd, ".gitignore");
  if (existsSync(gitignorePath)) {
    try {
      const text = (await import("node:fs")).readFileSync(gitignorePath, "utf-8");
      const excludes = text
        .split("\n")
        .map((l) => l.trim())
        .some(
          (l) =>
            l &&
            !l.startsWith("#") &&
            (l === ".trail/" || l === ".trail" || l === "/.trail" || l === "/.trail/")
        );
      if (!excludes) {
        const msg =
          "note: .trail/ is NOT excluded by .gitignore. Trail does not modify .gitignore. Run 'echo .trail/ >> .gitignore' if packets should not be committed.";
        notices.push(msg);
        process.stderr.write(`${msg}\n`); // bypasses --quiet
      }
    } catch {
      // ignore
    }
  }

  if (opts.patternsPath) {
    let msg =
      "note: --patterns replaces the bundled redaction set; on-disk redaction uses user-supplied patterns only. Bundled patterns NOT applied.";
    if (!opts.noLlm) {
      msg += " LLM-prompt redaction (SEC-3 boundary) likewise uses user-supplied patterns only.";
    }
    notices.push(msg);
    process.stderr.write(`${msg}\n`);
  }

  // Step 8: extract.
  const data = extract(records, {
    redactor,
    testCommandRe,
    repoRoot: opts.cwd,
  });

  // Step 9a: re-capture detection.
  const sessionDir = opts.outputDir ?? join(opts.cwd, ".trail", "sessions", opts.sessionId);
  const recapture = detectRecapture(sessionDir);
  if (recapture.parentReadFailed) {
    const msg = `warning: parent packet packet-${recapture.nextN - 1}.yml unreadable; setting parent_packet_id=null and continuing`;
    warnings.push(msg);
    process.stderr.write(`${msg}\n`);
  }

  // Step 8 cont.: claim synthesis.
  let claims = synthesizeMechanical(data, { perDiff: opts.perDiff, sessionId: opts.sessionId });
  let usedLlm = false;
  if (!opts.noLlm && opts.llmRunner) {
    const llmRes = await synthesizeLlm(data, {
      model: opts.llmModel,
      budgetUsd: opts.llmBudgetUsd,
      timeoutSeconds: opts.llmTimeoutSeconds,
      redactor,
      sessionId: opts.sessionId,
      runner: opts.llmRunner,
    });
    if (llmRes.claims) {
      claims = llmRes.claims;
      usedLlm = true;
    } else {
      const msg = `LLM synthesis failed: ${llmRes.detail}; falling back to mechanical`;
      stderr(opts, msg);
      if (opts.strictLlm) {
        stderr(
          opts,
          `LLM synthesis failed and --strict-llm prevents fallback: ${llmRes.detail}`,
          true
        );
        return { exitCode: 7, validationErrors, notices, warnings };
      }
    }
  }

  // Build packet.
  const packet = buildPacket({
    sessionId: opts.sessionId,
    data,
    redactor,
    patternSetVersion: patternResult.version,
    patternSetOrigin: patternResult.origin,
    claims,
    gitState,
    parentPacketId: recapture.parentPacketId,
    generatedAt: opts.generatedAt,
    packetId: opts.packetId,
  });

  // Step 9: schema validation (both passes always run; aggregate).
  let structuralIssues: ValidationIssue[] = [];
  let internalError: SchemaValidatorInternalError | null = null;
  try {
    structuralIssues = validateStructural(packet, opts.schemaPath);
  } catch (err) {
    if (err instanceof SchemaValidatorInternalError) {
      internalError = err;
    } else {
      throw err;
    }
  }
  const refIssues = validateRefs(packet);
  const totalIssues = structuralIssues.length + refIssues.length + (internalError ? 1 : 0);
  if (totalIssues > 0) {
    const lines = [`packet would violate schema: ${totalIssues} error(s)`];
    if (internalError) {
      lines.push(
        `  [internal] schema validator internal error: ${internalError.name}: ${internalError.message}`
      );
    }
    for (const i of structuralIssues) lines.push(`  [structural] ${i.message}`);
    for (const i of refIssues) lines.push(`  [refs] ${i.message}`);
    for (const l of lines) {
      validationErrors.push({ kind: "schema", message: l });
      process.stderr.write(`${l}\n`);
    }
    return { exitCode: 5, validationErrors, packet, notices, warnings };
  }

  // Step 10: atomic write sequence.
  // (a) serialize
  let yamlBytes = dumpYaml(packet, { width: 120 });
  // (b) Layer 2 scan
  const l2 = scanLayer2(yamlBytes, patternResult.patterns);
  // (c) strict-redaction gate
  if (l2.length > 0 && opts.strictRedaction) {
    const summary = l2.map((e) => `${e.pattern}:${e.snippet}`).join(", ");
    const msg = `--strict-redaction: Layer 2 found ${l2.length} pattern(s); refusing to write: ${summary}`;
    process.stderr.write(`${msg}\n`);
    return {
      exitCode: 5,
      validationErrors: [{ kind: "strict-redaction", message: msg }],
      packet,
      notices,
      warnings,
    };
  }
  // (d) write back validation_errors and re-serialize
  packet.agent_session.redaction_metadata.validation_errors = l2;
  yamlBytes = dumpYaml(packet, { width: 120 });
  // (e) Layer 2 stderr warning before any write
  if (l2.length > 0) {
    const msg = `warning: redaction Layer 2 found ${l2.length} pattern(s) escapees: ${l2.map((e) => e.pattern).join(", ")}`;
    warnings.push(msg);
    process.stderr.write(`${msg}\n`);
  }

  if (opts.dryRun) {
    const summary = JSON.stringify({
      claims: claims.length,
      redactions: redactor.total,
      validation_errors: l2.length,
    });
    process.stdout.write(`${summary}\n`);
    return { exitCode: 0, packet, yamlBytes, validationErrors, notices, warnings };
  }

  const yamlPath = join(sessionDir, `packet-${recapture.nextN}.yml`);
  const mdPath = join(sessionDir, `packet-${recapture.nextN}.md`);
  mkdirSync(sessionDir, { recursive: true });

  let mdBytes: string | undefined;

  // (f) write yaml.
  if (opts.format === "yaml" || opts.format === "both") {
    try {
      atomicWrite(yamlPath, yamlBytes, signalCleanupHandle);
    } catch (err) {
      stderr(opts, `cannot create/write ${yamlPath}: ${(err as Error).message}`, true);
      if (l2.length > 0) {
        for (const e of l2) {
          stderr(opts, `  validation_error[${e.pattern}]=${e.snippet}`, true);
        }
      }
      return { exitCode: 6, validationErrors, packet, notices, warnings };
    }
  }
  // (g) write md.
  if (opts.format === "md" || opts.format === "both") {
    mdBytes = renderMarkdown(packet, { packetPath: yamlPath });
    try {
      atomicWrite(mdPath, mdBytes, signalCleanupHandle);
    } catch (err) {
      stderr(opts, `cannot create/write ${mdPath}: ${(err as Error).message}`, true);
      return { exitCode: 6, validationErrors, packet, notices, warnings };
    }
    // (h) sharing notice
    const shareMsg = `note: packet-${recapture.nextN}.md may contain unredacted file excerpts. Review before sharing externally.`;
    notices.push(shareMsg);
    process.stderr.write(`${shareMsg}\n`);
  }

  // (i) storage write — best-effort.
  if (!opts.noStorage) {
    try {
      const writer: StorageWriter = opts.storageWriter ?? new NoopStorageWriter();
      const evidence = [
        ...packet.diff_summary.semantic_changes.map((d) => ({ ...d, kind: "DIFF" as const })),
        ...packet.commands_run.map((c) => ({ ...c, kind: "CMD" as const })),
        ...packet.test_evidence.passed.map((t) => ({ ...t, kind: "TEST" as const })),
      ];
      await writer.writePacket(packet, packet.agent_session.redaction_metadata, claims, evidence);
    } catch (err) {
      stderr(opts, `note: storage write failed (best-effort): ${(err as Error).message}`);
    }
  }

  // Step 11: summary.
  const summary = `packet ${packet._meta.packet_id} (packet-${recapture.nextN}) for session ${opts.sessionId} (${claims.length} claims, ${redactor.total} redactions, ${l2.length} validation_errors) → ${yamlPath}`;
  if (!opts.quiet) process.stderr.write(`${summary}\n`);

  return {
    exitCode: 0,
    packet,
    yamlPath,
    mdPath: opts.format === "yaml" ? undefined : mdPath,
    yamlBytes,
    mdBytes,
    validationErrors,
    notices,
    warnings,
  };
}
