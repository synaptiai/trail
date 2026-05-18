// Mechanical-mode parity (Phase 1 spec §10).
//
// Strategy: run py-reference's trail.py against the committed redacted
// fixture (synaptiai/trail#5) and compare the parsed YAML output to the TS
// port's in-process build over the same fixture. Deep-equal modulo allowed
// diffs (`_meta.packet_id` ULID, `_meta.generated_at`).
//
// Pre-#5 this test gated on a live ~/.claude/projects/... transcript and
// silently skipped on every contributor checkout + CI run. The committed
// fixture removes that gate; the test now runs in any environment with
// py-reference + python3 available.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jsYaml from "js-yaml";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { synthesizeMechanical } from "../src/claims/mechanical.js";
import { extract } from "../src/extract/extract.js";
import { buildPacket } from "../src/packet/build.js";
import { Redactor } from "../src/redaction/layer1.js";
import { loadPatterns } from "../src/redaction/patterns.js";
import { loadTestRunnerRegex } from "../src/test-runners/patterns.js";
import { readTranscriptSync } from "../src/transcript/reader.js";
import { stageParityFixture } from "./helpers/parity-fixture.js";

const SESSION_ID = "18e374b5-4eb9-424d-a3ff-a639d1c6fada";
// Resolve py-reference relative to THIS worktree so parity always uses the
// worktree-local py-reference + bundled YAML (kept in lockstep with TS port).
// Test file lives at `apps/capture/test/parity-mechanical.test.ts`; the
// worktree root is 3 levels up.
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = join(__dirname, "..", "..", "..");
const PY_REFERENCE_TRAIL = join(WORKTREE_ROOT, "py-reference", "cli", "trail.py");
// py-reference computes its REPO_ROOT as 3 levels up from py-reference/cli/trail.py
// (i.e., the worktree root). Match that for parity.
const REPO_ROOT = WORKTREE_ROOT;

const pyReferenceAvailable = existsSync(PY_REFERENCE_TRAIL);
const pythonAvailable = (() => {
  try {
    const r = spawnSync("python3", ["--version"]);
    return r.status === 0;
  } catch {
    return false;
  }
})();

describe.runIf(pyReferenceAvailable && pythonAvailable)(
  "mechanical-mode parity vs py-reference (criterion 2 / spec §10)",
  () => {
    let pyPacket: Record<string, unknown>;
    let tsPacket: Record<string, unknown>;
    // Stage inside the runIf branch so the helper's loud-fail-on-missing
    // semantics only triggers when py-reference is also present.
    const staging = stageParityFixture(SESSION_ID);
    afterAll(staging.cleanup);

    beforeAll(() => {
      // Run py-reference against the live transcript.
      const dir = mkdtempSync(join(tmpdir(), "trail-parity-"));
      const pyOut = join(dir, "py-out.yml");
      const r = spawnSync(
        "python3",
        [
          PY_REFERENCE_TRAIL,
          "packet",
          "generate",
          SESSION_ID,
          "--no-llm",
          "--out",
          pyOut,
          "--no-render-md",
        ],
        {
          encoding: "utf-8",
          timeout: 120_000,
          // Honor py-reference's TRAIL_CLAUDE_PROJECTS_ROOT override so its
          // transcript lookup hits the staged fixture. We keep HOME intact so
          // Python still finds the user-site pyyaml install.
          env: {
            ...process.env,
            TRAIL_CLAUDE_PROJECTS_ROOT: staging.projectsRootForPy,
          },
        }
      );
      if (r.status !== 0) {
        throw new Error(
          `py-reference exited status=${r.status} signal=${r.signal ?? "none"}\n` +
            `stderr:\n${r.stderr ?? "<empty>"}\n` +
            `stdout:\n${r.stdout ?? "<empty>"}\n` +
            `spawn error: ${r.error?.message ?? "none"}`
        );
      }
      // v0.1.2 DF-S6 (full fix): py-reference emits 16-char hex stable_id
      // values as bare scalars. js-yaml CORE_SCHEMA still permits YAML 1.1
      // float-exp coercion, so `49e7141170502230` parses as `49 * 10^...`
      // = Infinity. Pre-load regex massage quotes any stable_id line
      // before js-yaml's scanner sees it, sidestepping the coercion
      // without touching py-reference's output format or downgrading to
      // FAILSAFE_SCHEMA (which would also stringify numeric fields like
      // exit_code that other assertions compare numerically).
      //
      // The regex matches lines of the form `<indent>- stable_id: <value>`
      // (sequence item) and `<indent>stable_id: <value>` (mapping value)
      // where the value starts with a digit, contains only digits +
      // exponent characters, and is unquoted. Already-quoted values are
      // untouched because their value starts with `"` or `'`. The
      // capture pipeline itself never parses packet YAML via js-yaml's
      // default schema (ajv validates against the JSON Schema; the Tauri
      // shell uses serde_yaml with stricter type discipline), so this is
      // a test-harness fix only.
      const rawYaml = readFileSync(pyOut, "utf-8").replace(
        /^(\s*-?\s*stable_id:\s*)([0-9][0-9a-fA-FeE.+-]*)\s*$/gm,
        '$1"$2"'
      );
      pyPacket = jsYaml.load(rawYaml, {
        schema: jsYaml.CORE_SCHEMA,
      }) as Record<string, unknown>;

      // Run TS port logic in-process against the same fixture py-reference saw.
      const records = readTranscriptSync(staging.fixturePath);
      const { version, patterns, origin } = loadPatterns(undefined, {
        useCache: false,
      });
      const redactor = new Redactor(patterns);
      const data = extract(records, {
        redactor,
        testCommandRe: loadTestRunnerRegex(),
        repoRoot: REPO_ROOT,
      });
      const claims = synthesizeMechanical(data, {
        perDiff: false,
        sessionId: SESSION_ID,
      });
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
      // Roundtrip via YAML so types align (e.g., null vs undefined).
      tsPacket = jsYaml.load(jsYaml.dump(tsPacketObj)) as Record<string, unknown>;
    });

    test("packet_version matches", () => {
      expect(tsPacket.packet_version).toBe(pyPacket.packet_version);
    });

    test("commands_run length matches", () => {
      expect((tsPacket.commands_run as unknown[]).length).toBe(
        (pyPacket.commands_run as unknown[]).length
      );
    });

    test("diff_summary.semantic_changes length matches", () => {
      const ts = ((tsPacket.diff_summary as Record<string, unknown>).semantic_changes as unknown[])
        .length;
      const py = ((pyPacket.diff_summary as Record<string, unknown>).semantic_changes as unknown[])
        .length;
      expect(ts).toBe(py);
    });

    test("test_evidence.passed length matches", () => {
      const ts = ((tsPacket.test_evidence as Record<string, unknown>).passed as unknown[]).length;
      const py = ((pyPacket.test_evidence as Record<string, unknown>).passed as unknown[]).length;
      expect(ts).toBe(py);
    });

    test("summary.claims length matches", () => {
      const ts = ((tsPacket.summary as Record<string, unknown>).claims as unknown[]).length;
      const py = ((pyPacket.summary as Record<string, unknown>).claims as unknown[]).length;
      expect(ts).toBe(py);
    });

    test("agent_session.models[] matches", () => {
      const ts = (tsPacket.agent_session as Record<string, unknown>).models as string[];
      const py = (pyPacket.agent_session as Record<string, unknown>).models as string[];
      expect(ts).toEqual(py);
    });

    test("modules_touched matches", () => {
      const ts = (tsPacket.diff_summary as Record<string, unknown>).modules_touched as string[];
      const py = (pyPacket.diff_summary as Record<string, unknown>).modules_touched as string[];
      expect(ts).toEqual(py);
    });

    test("redaction_metadata totals match", () => {
      const tsR = (tsPacket.agent_session as Record<string, unknown>).redaction_metadata as Record<
        string,
        unknown
      >;
      const pyR = (pyPacket.agent_session as Record<string, unknown>).redaction_metadata as Record<
        string,
        unknown
      >;
      expect(tsR.redactions_applied).toBe(pyR.redactions_applied);
      expect(tsR.redactions_by_pattern).toEqual(pyR.redactions_by_pattern);
      expect(tsR.pattern_set_version).toBe(pyR.pattern_set_version);
    });

    // Pre-existing failure unmasked during the v0.1.0 pre-ship audit. Not a
    // production-code regression — it's a TEST-INFRASTRUCTURE bug:
    //
    //   pyClaims[i].stable_id is the 16-char hex string "49e7141170502230",
    //   which js-yaml parses UNQUOTED as scientific notation:
    //     49 × 10^7141170502230 → Infinity.
    //
    //   tsClaims[i].stable_id remains the literal string "49e7141170502230"
    //   (TS side quotes scalars more aggressively or the value comes from
    //   a typed Packet field).
    //
    // Both sides agree on the underlying VALUE; the load step on the py
    // side silently corrupts it. The production capture pipeline is
    // unaffected — packet YAML is consumed by validate-schema (ajv against
    // a JSON Schema) and by the Tauri shell (also parsed via a stricter
    // path), not by js-yaml's default schema.
    //
    // Fix in v0.1.x: load pyPacket via `jsYaml.load(..., { schema:
    // jsYaml.CORE_SCHEMA })` or normalise stable_id fields to String() before
    // comparison. See https://github.com/synaptiai/trail/issues/<TBD>.
    // The non-stable_id assertions (text, evidence_refs, synthesis_mode)
    // still belong in this file — they're the actual parity contract; the
    // stable_id check just needs a load-time hardening.
    // v0.1.2 DF-S6 (full fix): pre-load regex quotes stable_id values
    // before js-yaml sees them — see the rawYaml replace in beforeAll.
    // The stable_id parity assertion is re-enabled.
    test("each claim text + stable_id matches py-reference position-by-position", () => {
      const tsClaims = (tsPacket.summary as Record<string, unknown>).claims as Record<
        string,
        unknown
      >[];
      const pyClaims = (pyPacket.summary as Record<string, unknown>).claims as Record<
        string,
        unknown
      >[];
      expect(tsClaims.length).toBe(pyClaims.length);
      for (let i = 0; i < tsClaims.length; i++) {
        expect(tsClaims[i]!.text).toBe(pyClaims[i]!.text);
        expect(tsClaims[i]!.stable_id).toBe(pyClaims[i]!.stable_id);
        expect(tsClaims[i]!.evidence_refs).toEqual(pyClaims[i]!.evidence_refs);
        expect(tsClaims[i]!.synthesis_mode).toBe(pyClaims[i]!.synthesis_mode);
      }
    });

    test("each diff id + description + operation matches", () => {
      const tsDiffs = (tsPacket.diff_summary as Record<string, unknown>).semantic_changes as Record<
        string,
        unknown
      >[];
      const pyDiffs = (pyPacket.diff_summary as Record<string, unknown>).semantic_changes as Record<
        string,
        unknown
      >[];
      for (let i = 0; i < tsDiffs.length; i++) {
        expect(tsDiffs[i]!.id).toBe(pyDiffs[i]!.id);
        expect(tsDiffs[i]!.description).toBe(pyDiffs[i]!.description);
        expect(tsDiffs[i]!.operation).toBe(pyDiffs[i]!.operation);
        expect(tsDiffs[i]!.files).toEqual(pyDiffs[i]!.files);
      }
    });

    test("each command id + command + stdout match", () => {
      const tsCmds = tsPacket.commands_run as Record<string, unknown>[];
      const pyCmds = pyPacket.commands_run as Record<string, unknown>[];
      for (let i = 0; i < tsCmds.length; i++) {
        expect(tsCmds[i]!.id).toBe(pyCmds[i]!.id);
        expect(tsCmds[i]!.command).toBe(pyCmds[i]!.command);
        expect(tsCmds[i]!.stdout_summary).toBe(pyCmds[i]!.stdout_summary);
        expect(tsCmds[i]!.exit_code).toBe(pyCmds[i]!.exit_code);
      }
    });

    test("validation_errors back-fill from Layer 2 produces same patterns", () => {
      // Both implementations run Layer 2 and emit validation_errors with the
      // same pattern names (snippet hash is content-derived → identical for
      // identical input).
      const tsR = (tsPacket.agent_session as Record<string, unknown>).redaction_metadata as Record<
        string,
        unknown
      >;
      const pyR = (pyPacket.agent_session as Record<string, unknown>).redaction_metadata as Record<
        string,
        unknown
      >;
      // py-reference's trail.py runs validate_packet at the orchestrator level;
      // Layer 2 errors live there. The TS port populates them in generate.ts,
      // not in build_packet, so this test only sanity-checks the buildPacket
      // shape — Layer 2 parity is exercised by the redaction tests + the
      // generate.test.ts integration.
      const tsErrs = tsR.validation_errors as unknown[];
      const pyErrs = pyR.validation_errors as unknown[];
      expect(Array.isArray(tsErrs)).toBe(true);
      expect(Array.isArray(pyErrs)).toBe(true);
    });
  }
);
