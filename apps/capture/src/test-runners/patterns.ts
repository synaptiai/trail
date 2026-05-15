// Test-runner detection — externalised per spec §10.1 backport #4.

import { type Stats, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jsYaml from "js-yaml";

const MAX_BYTES = 64 * 1024;

const LEGACY_RE =
  /\b(pytest|jest|mocha|vitest|cargo\s+test|npm\s+(?:test|run\s+test)|yarn\s+(?:test|run\s+test)|go\s+test|rspec|phpunit|validate_canvas\.py|validate-template\.sh)\b/i;

export function defaultBundledTestRunnersPath(): string {
  return resolve(fileURLToPath(new URL("../../bin/trail-test-runners.yml", import.meta.url)));
}

export class TestRunnerLoadError extends Error {
  readonly subShape: string;
  constructor(subShape: string, message: string) {
    super(message);
    this.name = "TestRunnerLoadError";
    this.subShape = subShape;
  }
}

export function loadTestRunnerRegex(pathOverride?: string): RegExp {
  const sourcePath = pathOverride ?? defaultBundledTestRunnersPath();
  let stat: Stats;
  try {
    stat = statSync(sourcePath);
  } catch {
    return LEGACY_RE;
  }
  if (stat.size > MAX_BYTES) {
    throw new TestRunnerLoadError(
      "f",
      `failed to load ${sourcePath}: file size ${stat.size} bytes exceeds 64KB cap`
    );
  }
  let parsed: unknown;
  try {
    parsed = jsYaml.load(readFileSync(sourcePath, "utf-8"), {
      schema: jsYaml.FAILSAFE_SCHEMA,
    });
  } catch {
    return LEGACY_RE;
  }
  if (!parsed || typeof parsed !== "object") return LEGACY_RE;
  const runners = (parsed as Record<string, unknown>).runners;
  if (!Array.isArray(runners) || runners.length === 0) return LEGACY_RE;
  const parts: string[] = [];
  for (const runner of runners) {
    if (!runner || typeof runner !== "object") continue;
    const cmdPattern = (runner as Record<string, unknown>).command_pattern;
    if (typeof cmdPattern === "string" && cmdPattern.length > 0) parts.push(cmdPattern);
  }
  if (parts.length === 0) return LEGACY_RE;
  return new RegExp(`(?:${parts.join("|")})`, "i");
}
