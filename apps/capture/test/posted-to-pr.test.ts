// posted-to-pr atomic-append helper tests. Verify schema-conformant entries,
// idempotent append (multiple posts append; do not replace), and
// reads-claim-id cross-reference helper.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dumpYaml, loadYaml } from "../src/packet/yaml.js";
import {
  appendApprovalTrail,
  appendPostedToPr,
  computeBodyHash,
  nowIso,
  readPacketClaimIds,
} from "../src/post/posted-to-pr.js";

function minimalPacket(): Record<string, unknown> {
  return {
    packet_version: "0.1.1",
    _meta: { packet_id: "01ABC", generated_at: "2026-05-09T00:00:00.000+00:00" },
    summary: {
      claims: [
        { id: "CLAIM-001", text: "x", evidence_refs: [], confidence: "supported" },
        {
          id: "CLAIM-002",
          stable_id: "0123456789abcdef",
          text: "y",
          evidence_refs: [],
          confidence: "supported",
        },
      ],
      ungrounded_claim_count: 0,
    },
  };
}

function writePacket(): string {
  const dir = mkdtempSync(join(tmpdir(), "trail-post-test-"));
  const path = join(dir, "packet-1.yml");
  writeFileSync(path, dumpYaml(minimalPacket()), "utf-8");
  return path;
}

describe("computeBodyHash", () => {
  test("deterministic, 64 lowercase hex chars (sha256 full)", () => {
    const a = computeBodyHash("hello");
    const b = computeBodyHash("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  test("different input → different hash", () => {
    expect(computeBodyHash("a")).not.toBe(computeBodyHash("b"));
  });
});

describe("nowIso", () => {
  test("ISO 8601 with +00:00 suffix (NOT Z)", () => {
    const s = nowIso(new Date("2026-05-09T03:05:20.148Z"));
    expect(s).toBe("2026-05-09T03:05:20.148+00:00");
    expect(s.endsWith("Z")).toBe(false);
  });
});

describe("appendPostedToPr", () => {
  test("creates posted_to_pr[] when missing; entry shape matches schema", () => {
    const path = writePacket();
    appendPostedToPr(path, {
      pr_url: "https://github.com/owner/repo/pull/42",
      pr_number: 42,
      body_hash: "a".repeat(64),
      posted_at: "2026-05-09T00:00:00.000+00:00",
      posted_by: "alice@example.com",
    });
    const parsed = loadYaml(readFileSync(path, "utf-8")) as {
      posted_to_pr: unknown[];
    };
    expect(Array.isArray(parsed.posted_to_pr)).toBe(true);
    expect(parsed.posted_to_pr.length).toBe(1);
    const entry = parsed.posted_to_pr[0] as Record<string, unknown>;
    expect(entry.pr_url).toBe("https://github.com/owner/repo/pull/42");
    expect(entry.pr_number).toBe(42);
    expect(entry.body_hash).toBe("a".repeat(64));
    expect(entry.posted_at).toBe("2026-05-09T00:00:00.000+00:00");
    expect(entry.posted_by).toBe("alice@example.com");
  });

  test("subsequent appends accumulate (do NOT replace)", () => {
    const path = writePacket();
    for (let i = 0; i < 3; i++) {
      appendPostedToPr(path, {
        pr_url: `https://github.com/owner/repo/pull/${42 + i}`,
        pr_number: 42 + i,
        body_hash: String(i).padEnd(64, "0").slice(0, 64),
        posted_at: `2026-05-09T00:00:0${i}.000+00:00`,
        posted_by: "alice",
      });
    }
    const parsed = loadYaml(readFileSync(path, "utf-8")) as {
      posted_to_pr: { pr_number: number }[];
    };
    expect(parsed.posted_to_pr.length).toBe(3);
    expect(parsed.posted_to_pr.map((e) => e.pr_number)).toEqual([42, 43, 44]);
  });

  test("rejects packets where posted_to_pr is non-array", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-post-test-"));
    const path = join(dir, "packet-broken.yml");
    const broken = { ...minimalPacket(), posted_to_pr: "not an array" };
    writeFileSync(path, dumpYaml(broken), "utf-8");
    expect(() =>
      appendPostedToPr(path, {
        pr_url: "https://x",
        pr_number: 1,
        body_hash: "a".repeat(64),
        posted_at: "2026-05-09T00:00:00.000+00:00",
        posted_by: "x",
      })
    ).toThrow(/not an array/);
  });
});

describe("appendApprovalTrail", () => {
  test("creates approval_trail[] when missing; entry shape matches schema", () => {
    const path = writePacket();
    appendApprovalTrail(path, {
      claim_id: "CLAIM-001",
      decision: "block",
      reason: "needs more eyes",
      by: "alice@example.com",
      at: "2026-05-09T00:00:00.000+00:00",
    });
    const parsed = loadYaml(readFileSync(path, "utf-8")) as {
      approval_trail: { claim_id: string; decision: string }[];
    };
    expect(parsed.approval_trail.length).toBe(1);
    expect(parsed.approval_trail[0].claim_id).toBe("CLAIM-001");
    expect(parsed.approval_trail[0].decision).toBe("block");
  });

  test("appends preserve chronological order", () => {
    const path = writePacket();
    const entries = [
      {
        claim_id: "CLAIM-001",
        decision: "accept" as const,
        reason: null,
        by: "x",
        at: "2026-05-09T00:00:00.000+00:00",
      },
      {
        claim_id: "CLAIM-002",
        decision: "changes" as const,
        reason: "fix",
        by: "y",
        at: "2026-05-09T00:01:00.000+00:00",
      },
    ];
    for (const e of entries) appendApprovalTrail(path, e);
    const parsed = loadYaml(readFileSync(path, "utf-8")) as {
      approval_trail: { claim_id: string }[];
    };
    expect(parsed.approval_trail.map((e) => e.claim_id)).toEqual(["CLAIM-001", "CLAIM-002"]);
  });
});

describe("readPacketClaimIds", () => {
  test("returns claim ids and stable ids when present", () => {
    const path = writePacket();
    const r = readPacketClaimIds(path);
    expect(r.ids).toEqual(["CLAIM-001", "CLAIM-002"]);
    expect(r.stableIds).toEqual(["0123456789abcdef"]);
  });

  test("returns empty arrays when summary missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-post-test-"));
    const path = join(dir, "minimal.yml");
    writeFileSync(path, dumpYaml({ packet_version: "0.1.1" }), "utf-8");
    const r = readPacketClaimIds(path);
    expect(r.ids).toEqual([]);
    expect(r.stableIds).toEqual([]);
  });
});
