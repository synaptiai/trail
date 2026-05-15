#!/usr/bin/env node
// Trail CLI entry. Spec §3 commands + flags.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError, Option } from "commander";
import { spawnClaudeRunner } from "./claims/llm.js";
import { type Decision, packetDecide } from "./decide/index.js";
import { generate } from "./generate.js";
import { installSignalHandlers } from "./io/signals.js";
import { packetPost } from "./post/index.js";
import { VERSION } from "./version.js";

function parseFloatStrict(name: string): (raw: string) => number {
  return (raw: string) => {
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) {
      throw new InvalidArgumentError(`${name} must be a number`);
    }
    return n;
  };
}

function parseIntStrict(name: string): (raw: string) => number {
  return (raw: string) => {
    if (!/^\d+$/.test(raw)) {
      throw new InvalidArgumentError(`${name} must be a non-negative integer`);
    }
    return Number.parseInt(raw, 10);
  };
}

export async function runCli(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const program = new Command();
  program
    .name("trail")
    .version(VERSION)
    .exitOverride((err) => {
      throw err;
    });

  const packet = program.command("packet").description("Packet operations");

  packet
    .command("generate")
    .argument("[session-id]", "Session id; pass --latest to auto-detect")
    .option("--latest", "Use the latest session for the cwd", false)
    .option("--no-llm", "Force mechanical claim synthesis", false)
    .option("--llm-model <model>", "Model passed to claude -p", "haiku")
    .option(
      "--llm-budget-usd <number>",
      "Max budget passed to claude --max-budget-usd",
      parseFloatStrict("--llm-budget-usd"),
      0.5
    )
    .option(
      "--llm-timeout-seconds <int>",
      "Subprocess timeout",
      parseIntStrict("--llm-timeout-seconds"),
      120
    )
    .option("--per-diff", "Mechanical synthesis: one claim per DIFF", false)
    .option("--output <path>", "Output directory")
    .addOption(
      new Option("--format <format>", "Render format")
        .choices(["yaml", "md", "both"])
        .default("both")
    )
    .option("--patterns <path>", "User-supplied redaction patterns YAML")
    .option("--strict-redaction", "Exit 5 if Layer 2 finds escapees", false)
    .option("--strict-llm", "Exit 7 if LLM synthesis fails", false)
    .option("--dry-run", "Validate-only; no writes", false)
    .option("--no-storage", "Skip Layer 2 storage row write", false)
    .option("--quiet", "Suppress informational stderr", false)
    .action(async (sessionId: string | undefined, raw) => {
      // Conflict gate: --strict-llm and --no-llm set together.
      if (raw.strictLlm && raw.llm === false) {
        process.stderr.write("invalid args: --strict-llm and --no-llm are mutually exclusive\n");
        process.exit(8);
      }

      let resolvedSessionId: string | undefined = sessionId;
      if (!resolvedSessionId && raw.latest) {
        resolvedSessionId = findLatestSessionId(cwd) ?? undefined;
        if (!resolvedSessionId) {
          process.stderr.write("no sessions for this cwd\n");
          process.exit(2);
        }
      }
      if (!resolvedSessionId) {
        process.stderr.write("invalid args: session-id required (or --latest)\n");
        process.exit(8);
      }

      installSignalHandlers();

      const result = await generate({
        sessionId: resolvedSessionId,
        cwd,
        outputDir: raw.output,
        noLlm: raw.llm === false,
        llmModel: raw.llmModel,
        llmBudgetUsd: raw.llmBudgetUsd,
        llmTimeoutSeconds: raw.llmTimeoutSeconds,
        perDiff: !!raw.perDiff,
        format: raw.format,
        patternsPath: raw.patterns,
        strictRedaction: !!raw.strictRedaction,
        strictLlm: !!raw.strictLlm,
        dryRun: !!raw.dryRun,
        noStorage: raw.storage === false,
        quiet: !!raw.quiet,
        llmRunner: raw.llm === false ? undefined : spawnClaudeRunner(),
      });
      process.exit(result.exitCode);
    });

  packet
    .command("list")
    .description("List packets under .trail/sessions/")
    .action(() => {
      const sessionsDir = join(cwd, ".trail", "sessions");
      if (!existsSync(sessionsDir)) {
        process.stdout.write("no packets found\n");
        return;
      }
      for (const entry of readdirSync(sessionsDir)) {
        process.stdout.write(`${entry}\n`);
      }
    });

  // gh#4 — `trail packet post`. Posts the packet markdown to a GitHub PR
  // body inside a `<!-- trail:packet:start -->` ... `<!-- trail:packet:end -->`
  // fenced section. Preserves PR-body content outside the fence.
  packet
    .command("post")
    .description("Post packet markdown to a GitHub PR body via gh CLI (Phase 3b)")
    .requiredOption("--packet <path>", "Path to packet YAML")
    .option(
      "--pr <number>",
      "PR number; if omitted, detected from current branch via gh pr view",
      parseIntStrict("--pr")
    )
    .option(
      "--posted-by <identity>",
      "Identity to record in posted_to_pr[].posted_by (email or handle)"
    )
    .option("--yes", "Skip interactive destination confirmation (non-interactive use)", false)
    .action(async (raw: { packet: string; pr?: number; postedBy?: string; yes: boolean }) => {
      installSignalHandlers();
      const postedBy = raw.postedBy ?? process.env.TRAIL_POSTED_BY ?? process.env.USER ?? "unknown";
      const baseOpts = {
        packetPath: raw.packet,
        yes: !!raw.yes,
        postedBy,
      };
      const result = await packetPost(
        raw.pr !== undefined ? { ...baseOpts, prNumber: raw.pr } : baseOpts
      );
      process.exit(result.exitCode);
    });

  // gh#4 — `trail packet decide`. Reviewer-side per-claim decision capture.
  // Writes to packet.approval_trail[], posts a markdown comment to the PR,
  // and refreshes the body fenced section. AC-6 / J9.
  packet
    .command("decide")
    .description("Record a per-claim review decision and sync to PR (Phase 3b)")
    .requiredOption("--packet <path>", "Path to packet YAML")
    .option(
      "--pr <number>",
      "PR number; if omitted, detected from current branch via gh pr view",
      parseIntStrict("--pr")
    )
    .requiredOption("--claim <id>", "Claim ID (CLAIM-NNN or 16-hex stable_id)")
    .addOption(
      new Option("--decision <value>", "Decision for the claim").choices([
        "accept",
        "changes",
        "block",
        "reject",
      ])
    )
    .option("--reason <text>", "Required for changes|block|reject (≤500 chars after redact)")
    .option(
      "--by <identity>",
      "Decider identity to record in approval_trail[].by (email or handle)"
    )
    .action(
      async (raw: {
        packet: string;
        pr?: number;
        claim: string;
        decision?: Decision;
        reason?: string;
        by?: string;
      }) => {
        if (!raw.decision) {
          process.stderr.write(
            "invalid args: --decision is required (accept|changes|block|reject)\n"
          );
          process.exit(8);
        }
        installSignalHandlers();
        const by = raw.by ?? process.env.TRAIL_DECIDER ?? process.env.USER ?? "";
        const baseOpts = {
          packetPath: raw.packet,
          claim: raw.claim,
          decision: raw.decision,
          reason: raw.reason ?? null,
          by,
        };
        const result = await packetDecide(
          raw.pr !== undefined ? { ...baseOpts, prNumber: raw.pr } : baseOpts
        );
        process.exit(result.exitCode);
      }
    );

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (
      e.code === "commander.help" ||
      e.code === "commander.helpDisplayed" ||
      e.code === "commander.version"
    ) {
      return 0;
    }
    if (
      e.code === "commander.missingArgument" ||
      e.code === "commander.unknownOption" ||
      e.code === "commander.invalidArgument"
    ) {
      process.stderr.write(`invalid args: ${e.message ?? "(unknown)"}\n`);
      return 8;
    }
    process.stderr.write(`${e.message ?? "unknown error"}\n`);
    return 1;
  }
  return 0;
}

export function findLatestSessionId(cwd: string): string | null {
  // Best-effort: scan ~/.claude/projects/<sanitized>/ for the newest .jsonl.
  // Sanitization: same as Claude Code's project dir naming (slashes → -).
  //
  // [F10 / 2026-05-09] Use the imported `statSync` directly (was a CommonJS
  // `require("node:fs")` bridge inside an ESM file). Also: defensively reject
  // a relative cwd — sanitized form for a relative path produces a directory
  // name that does not match Claude Code's actual `~/.claude/projects/<dir>`
  // naming (which always derives from an absolute path). On Windows, the
  // sanitization rule differs from POSIX in any case; this v0.1 helper only
  // supports POSIX and silently returns null on a relative input.
  try {
    if (!isAbsolute(cwd)) return null;
    const homeDir = process.env.HOME ?? "";
    const sanitized = cwd.replace(/\//g, "-");
    const root = join(homeDir, ".claude", "projects", sanitized);
    if (!existsSync(root)) return null;
    let latest: { name: string; mtime: number } | null = null;
    for (const entry of readdirSync(root)) {
      if (!entry.endsWith(".jsonl")) continue;
      const stat = statSync(join(root, entry));
      const t = stat.mtimeMs;
      if (!latest || t > latest.mtime) {
        latest = { name: entry.replace(/\.jsonl$/, ""), mtime: t };
      }
    }
    return latest?.name ?? null;
  } catch {
    return null;
  }
}

// Bin invocation goes through npm's symlink (e.g. `/opt/homebrew/bin/trail`
// -> `…/lib/node_modules/@synapti/trail-capture/dist/cli.js`). Node resolves
// `import.meta.url` to the symlink target, while `process.argv[1]` stays the
// unresolved symlink path. Resolve both sides through `realpathSync` so the
// comparison works under npm-bin, pnpm, Yarn, and direct `node dist/cli.js`
// invocations. rc.4 shipped a guard that compared the resolved URL against
// the unresolved argv[1] and silently no-op'd every `trail …` command.
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
      process.exit(1);
    }
  );
}
