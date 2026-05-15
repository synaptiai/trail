// Performance budget tests — gh#3 acceptance criterion 5.
//
// Budgets:
//   - Single ~100 KB packet ≤ 100 ms.
//   - Full repo scan (~50 packets) ≤ 2 s.
//
// The numbers are taken straight from the issue body. They're calibrated
// for an unloaded developer machine; CI may be slower. We ALLOW a 3x
// generous slack on top of the stated budgets to keep the test from
// flaking under cold-start / first-pattern-compile costs and parallel
// vitest noise. If the slack-multiplied bound trips, that's a real
// regression worth investigating, not a flake.
//
// The test scans synthetic packet content (lorem-ipsum-shape YAML) — no
// planted secrets, so the scanner runs the "no findings" hot path which
// is the realistic steady-state cost for a clean repo.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { audit } from "../src/audit.js";
import { EXIT_OK } from "../src/exit-codes.js";

const SLACK_MULTIPLIER = 3;
const SINGLE_PACKET_BUDGET_MS = 100 * SLACK_MULTIPLIER;
const REPO_SCAN_BUDGET_MS = 2000 * SLACK_MULTIPLIER;

function makePacketYaml(approxKb: number): string {
  // YAML-shape content with claims-array structure mimicking real packets.
  // We build up to approxKb * 1024 bytes of content using filler that
  // resembles a real packet (claim text, refs, ULIDs).
  const lines: string[] = ["claims:"];
  let bytes = "claims:\n".length;
  let i = 0;
  const target = approxKb * 1024;
  while (bytes < target) {
    const claim = `  - id: 01HZZZZZZZZZZZZZZZZZZZZZ${(i % 1000).toString().padStart(3, "0")}\n    text: "${"lorem ipsum dolor sit amet ".repeat(8)}"\n    refs:\n      - "src/foo${i}.ts:42"\n`;
    lines.push(claim);
    bytes += claim.length;
    i++;
  }
  return lines.join("");
}

describe("performance budget — gh#3 AC-5", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "trail-audit-perf-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it(`scans a single ~100 KB packet in ≤ ${SINGLE_PACKET_BUDGET_MS}ms (slack ${SLACK_MULTIPLIER}x)`, async () => {
    mkdirSync(join(tmp, ".trail", "sessions", "abc"), { recursive: true });
    const yaml = makePacketYaml(100);
    writeFileSync(join(tmp, ".trail", "sessions", "abc", "packet-1.yml"), yaml);

    // Warm up the pattern loader (first call has YAML-parse + regex-compile cost).
    await audit({ root: tmp, stagedOnly: false, quiet: true });

    const t0 = process.hrtime.bigint();
    const result = await audit({ root: tmp, stagedOnly: false, quiet: true });
    const t1 = process.hrtime.bigint();
    const elapsedMs = Number(t1 - t0) / 1_000_000;

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.filesScanned).toBe(1);
    expect(elapsedMs).toBeLessThanOrEqual(SINGLE_PACKET_BUDGET_MS);
  });

  it(`scans 50 packets in ≤ ${REPO_SCAN_BUDGET_MS}ms (slack ${SLACK_MULTIPLIER}x)`, async () => {
    // 50 packets × ~50 KB each = ~2.5 MB total. Distribute across 5 sessions
    // (10 packets each) to mimic real repo layout.
    const yaml = makePacketYaml(50);
    for (let s = 0; s < 5; s++) {
      const sessionDir = join(tmp, ".trail", "sessions", `sid-${s}`);
      mkdirSync(sessionDir, { recursive: true });
      for (let p = 1; p <= 10; p++) {
        writeFileSync(join(sessionDir, `packet-${p}.yml`), yaml);
      }
    }

    // Warm up the pattern loader.
    await audit({ root: tmp, stagedOnly: false, quiet: true });

    const t0 = process.hrtime.bigint();
    const result = await audit({ root: tmp, stagedOnly: false, quiet: true });
    const t1 = process.hrtime.bigint();
    const elapsedMs = Number(t1 - t0) / 1_000_000;

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.filesScanned).toBe(50);
    expect(elapsedMs).toBeLessThanOrEqual(REPO_SCAN_BUDGET_MS);
  });
});
