// Per-DIFF parity (criterion 3 / spec §10).
// Same approach as parity-mechanical: TS port vs py-reference (--per-diff).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jsYaml from "js-yaml";
import { beforeAll, describe, expect, test } from "vitest";
import { synthesizeMechanical } from "../src/claims/mechanical.js";
import { extract } from "../src/extract/extract.js";
import { buildPacket } from "../src/packet/build.js";
import { Redactor } from "../src/redaction/layer1.js";
import { loadPatterns } from "../src/redaction/patterns.js";
import { loadTestRunnerRegex } from "../src/test-runners/patterns.js";
import { readTranscriptSync } from "../src/transcript/reader.js";

const SESSION_ID = "18e374b5-4eb9-424d-a3ff-a639d1c6fada";
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = join(__dirname, "..", "..", "..");
const PY_REFERENCE_TRAIL = join(WORKTREE_ROOT, "py-reference", "cli", "trail.py");
const REPO_ROOT = WORKTREE_ROOT;
const TRANSCRIPT_PATH = join(
  homedir(),
  ".claude",
  "projects",
  "-Users-danielbentes-trail",
  `${SESSION_ID}.jsonl`
);

const transcriptAvailable = existsSync(TRANSCRIPT_PATH);
const pyReferenceAvailable = existsSync(PY_REFERENCE_TRAIL);
const pythonAvailable = (() => {
  try {
    const r = spawnSync("python3", ["--version"]);
    return r.status === 0;
  } catch {
    return false;
  }
})();

describe.runIf(transcriptAvailable && pyReferenceAvailable && pythonAvailable)(
  "per-DIFF parity vs py-reference (criterion 3 / spec §10)",
  () => {
    let pyPacket: Record<string, unknown>;
    let tsPacket: Record<string, unknown>;

    beforeAll(() => {
      const dir = mkdtempSync(join(tmpdir(), "trail-parity-perdiff-"));
      const pyOut = join(dir, "py-out.yml");
      const r = spawnSync(
        "python3",
        [
          PY_REFERENCE_TRAIL,
          "packet",
          "generate",
          SESSION_ID,
          "--no-llm",
          "--per-diff",
          "--out",
          pyOut,
          "--no-render-md",
        ],
        { encoding: "utf-8", timeout: 120_000 }
      );
      if (r.status !== 0) {
        throw new Error(`py-reference exited ${r.status}: ${r.stderr}`);
      }
      pyPacket = jsYaml.load(readFileSync(pyOut, "utf-8")) as Record<string, unknown>;

      const records = readTranscriptSync(TRANSCRIPT_PATH);
      const { version, patterns, origin } = loadPatterns(undefined, { useCache: false });
      const redactor = new Redactor(patterns);
      const data = extract(records, {
        redactor,
        testCommandRe: loadTestRunnerRegex(),
        repoRoot: REPO_ROOT,
      });
      const claims = synthesizeMechanical(data, { perDiff: true, sessionId: SESSION_ID });
      const tsPacketObj = buildPacket({
        sessionId: SESSION_ID,
        data,
        redactor,
        patternSetVersion: version,
        patternSetOrigin: origin,
        claims,
        gitState: undefined,
        parentPacketId: null,
        packetId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        generatedAt: "2026-05-09T03:05:20.148537+00:00",
      });
      tsPacket = jsYaml.load(jsYaml.dump(tsPacketObj)) as Record<string, unknown>;
    });

    test("claim count matches per-DIFF py-reference", () => {
      const tsClaims = (tsPacket.summary as Record<string, unknown>).claims as unknown[];
      const pyClaims = (pyPacket.summary as Record<string, unknown>).claims as unknown[];
      expect(tsClaims.length).toBe(pyClaims.length);
    });

    test("each per-DIFF claim text + stable_id + evidence_refs match", () => {
      const tsClaims = (tsPacket.summary as Record<string, unknown>).claims as Record<
        string,
        unknown
      >[];
      const pyClaims = (pyPacket.summary as Record<string, unknown>).claims as Record<
        string,
        unknown
      >[];
      for (let i = 0; i < tsClaims.length; i++) {
        expect(tsClaims[i]!.text).toBe(pyClaims[i]!.text);
        expect(tsClaims[i]!.stable_id).toBe(pyClaims[i]!.stable_id);
        expect(tsClaims[i]!.evidence_refs).toEqual(pyClaims[i]!.evidence_refs);
      }
    });
  }
);
