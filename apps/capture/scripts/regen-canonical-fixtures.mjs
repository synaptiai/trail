#!/usr/bin/env node
// [gh#4 / 2026-05-18] Regenerate the canonical packet fixtures.
//
// Pipeline: redacted-transcript fixture (gh#5) -> production capture
// pipeline -> canonical packet outputs committed under
// `apps/capture/test/fixtures/`. The fixture-vs-current test in
// `apps/capture/test/canonical-session.test.ts` asserts byte-equality
// of the regenerated output against the committed canonical files; any
// regression in Layer 1 redaction, schema serialization, or extraction
// order will fail that test.
//
// Usage (from repo root or apps/capture):
//   pnpm --filter @synapti/trail-capture run build
//   node apps/capture/scripts/regen-canonical-fixtures.mjs
//
// Inputs:
//   apps/capture/test/fixtures/18e374b5-...-redacted.jsonl  (gh#5 frozen redacted source)
//
// Outputs (committed):
//   apps/capture/test/fixtures/canonical-session.yml         (mechanical mode)
//   apps/capture/test/fixtures/canonical-session.md          (markdown render)
//   apps/capture/test/fixtures/canonical-session-perdiff.yml (per-diff mode)
//
// Determinism: packetId and generatedAt are pinned constants. The
// generate() helper accepts them as parameters so the output is
// reproducible from the same fixture + same code.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const fixturesDir = resolve(pkgRoot, "test", "fixtures");

const SESSION_ID = "18e374b5-4eb9-424d-a3ff-a639d1c6fada";
const TRANSCRIPT = resolve(fixturesDir, `${SESSION_ID}.redacted.jsonl`);

// Pinned deterministic values — match generate-integration.test.ts so
// fixtures from regen are byte-identical to fixtures from tests.
const PACKET_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const GENERATED_AT = "2026-05-09T03:05:20.148537+00:00";

if (!existsSync(TRANSCRIPT)) {
  console.error(`canonical source transcript missing at ${TRANSCRIPT}`);
  console.error("did you check out the gh#5 fixture?");
  process.exit(1);
}

const { generate } = await import(resolve(pkgRoot, "dist", "generate.js"));

async function generatePacket(perDiff, format, outYmlName, outMdName) {
  const cwd = mkdtempSync(join(tmpdir(), "trail-canonical-"));
  try {
    execSync("git init -q", { cwd });
    execSync("git config user.email canonical@trail.local", { cwd });
    execSync("git config user.name canonical", { cwd });
    writeFileSync(join(cwd, ".gitignore"), ".trail/\n");

    const sessionDir = join(cwd, ".trail", "sessions", SESSION_ID);
    execSync(`mkdir -p ${sessionDir}`, { cwd });

    const result = await generate({
      sessionId: SESSION_ID,
      cwd,
      noLlm: true,
      llmModel: "haiku",
      llmBudgetUsd: 0.5,
      llmTimeoutSeconds: 120,
      perDiff,
      format,
      strictRedaction: false,
      strictLlm: false,
      dryRun: false,
      noStorage: true,
      quiet: true,
      transcriptPath: TRANSCRIPT,
      packetId: PACKET_ID,
      generatedAt: GENERATED_AT,
    });
    if (result.exitCode !== 0) {
      throw new Error(`generate() exit ${result.exitCode}`);
    }

    if (outYmlName) {
      const yml = readFileSync(result.yamlPath, "utf-8");
      writeFileSync(join(fixturesDir, outYmlName), yml);
      console.log(`wrote ${outYmlName} (${yml.length} bytes)`);
    }
    if (outMdName && result.mdPath) {
      const md = readFileSync(result.mdPath, "utf-8");
      writeFileSync(join(fixturesDir, outMdName), md);
      console.log(`wrote ${outMdName} (${md.length} bytes)`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

console.log("Regenerating canonical fixtures...");
console.log(`  source:    ${TRANSCRIPT}`);
console.log(`  packetId:  ${PACKET_ID}`);
console.log(`  generated: ${GENERATED_AT}`);
console.log();

await generatePacket(false, "both", "canonical-session.yml", "canonical-session.md");
await generatePacket(true, "yaml", "canonical-session-perdiff.yml", null);

console.log();
console.log("Done. To update the canonical test pin:");
console.log("  cd apps/capture && ./node_modules/.bin/vitest run test/canonical-session.test.ts");
