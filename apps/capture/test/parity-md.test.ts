// Markdown render parity (criterion 4 / spec §10).
// We test our render against a packet parsed from py-reference's YAML output,
// and compare the markdown structure (headings, anchor IDs, fence counts) and
// a small sub-fixture for byte parity.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import type { Packet } from "../src/packet/types.js";
// [F24 / 2026-05-09] Use our pyyaml-compatible loadYaml rather than raw
// jsYaml.load. The default js-yaml schema's float resolver matches
// `\d+e\d+` as scientific notation while pyyaml requires a signed
// exponent — so a sha256 prefix like `86583e01` (1/256-ish probability)
// gets coerced to the number 865830 silently, breaking byte-parity tests
// against py-reference output. See packet/yaml.ts for the schema fix.
import { loadYaml } from "../src/packet/yaml.js";
import { renderMarkdown } from "../src/render/markdown.js";

const SESSION_ID = "18e374b5-4eb9-424d-a3ff-a639d1c6fada";
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = join(__dirname, "..", "..", "..");
const PY_REFERENCE_TRAIL = join(WORKTREE_ROOT, "py-reference", "cli", "trail.py");

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
  "markdown render parity vs py-reference (criterion 4 / spec §10)",
  () => {
    let pyMd: string;
    let tsMd: string;
    let packet: Packet;
    let pyOut: string;

    beforeAll(() => {
      const dir = mkdtempSync(join(tmpdir(), "trail-parity-md-"));
      pyOut = join(dir, "py-out.yml");
      const pyMdPath = join(dir, "py-out.md");
      const r = spawnSync(
        "python3",
        [PY_REFERENCE_TRAIL, "packet", "generate", SESSION_ID, "--no-llm", "--out", pyOut],
        { encoding: "utf-8", timeout: 120_000 }
      );
      if (r.status !== 0) {
        throw new Error(`py-reference exited ${r.status}: ${r.stderr}`);
      }
      pyMd = readFileSync(pyMdPath, "utf-8");
      packet = loadYaml(readFileSync(pyOut, "utf-8")) as Packet;
      tsMd = renderMarkdown(packet, { packetPath: pyOut });
    });

    test("title line matches", () => {
      expect(tsMd.split("\n")[0]).toBe(pyMd.split("\n")[0]);
    });

    test("packet_id line matches", () => {
      const tsLine = tsMd.split("\n").find((l) => l.includes("**Packet ID:**"));
      const pyLine = pyMd.split("\n").find((l) => l.includes("**Packet ID:**"));
      expect(tsLine).toBe(pyLine);
    });

    test("redaction summary line matches", () => {
      const tsLine = tsMd.split("\n").find((l) => l.includes("**Redaction:**"));
      const pyLine = pyMd.split("\n").find((l) => l.includes("**Redaction:**"));
      expect(tsLine).toBe(pyLine);
    });

    test("number of ### CLAIM-XXX headings matches", () => {
      const ts = (tsMd.match(/^### CLAIM-/gm) ?? []).length;
      const py = (pyMd.match(/^### CLAIM-/gm) ?? []).length;
      expect(ts).toBe(py);
    });

    test("number of fenced code blocks matches", () => {
      const ts = (tsMd.match(/^```/gm) ?? []).length;
      const py = (pyMd.match(/^```/gm) ?? []).length;
      expect(ts).toBe(py);
    });

    test("orphan-evidence appendix present iff orphans exist", () => {
      const tsHas = tsMd.includes("## Appendix — Orphan Evidence");
      const pyHas = pyMd.includes("## Appendix — Orphan Evidence");
      expect(tsHas).toBe(pyHas);
    });

    test("initial prompt anchor present", () => {
      expect(tsMd).toContain("<a id='prompt-001'></a>");
      expect(pyMd).toContain("<a id='prompt-001'></a>");
    });

    test("footer present and structurally identical", () => {
      const tsLines = tsMd.trimEnd().split("\n");
      const pyLines = pyMd.trimEnd().split("\n");
      expect(tsLines[tsLines.length - 1]).toBe(pyLines[pyLines.length - 1]);
      expect(tsLines[tsLines.length - 2]).toBe(pyLines[pyLines.length - 2]);
    });

    test("byte-identical for the first 200 lines (substantial structural parity)", () => {
      const tsLines = tsMd.split("\n").slice(0, 200);
      const pyLines = pyMd.split("\n").slice(0, 200);
      // Compare line-by-line; first divergence is the most informative.
      const firstDiff = pyLines.findIndex((l, i) => l !== tsLines[i]);
      if (firstDiff !== -1) {
        // Surface the divergence verbatim for debugging.
        expect({ idx: firstDiff, py: pyLines[firstDiff], ts: tsLines[firstDiff] }).toEqual({
          idx: firstDiff,
          py: pyLines[firstDiff],
          ts: pyLines[firstDiff],
        });
      }
    });
  }
);
