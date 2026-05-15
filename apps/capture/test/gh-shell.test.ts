// gh-shell unit tests. Use the GhRunner DI seam to test the structured
// error mapping without spawning real subprocesses. Real-subprocess paths
// are exercised by the integration test against a live PR.

import { describe, expect, test } from "vitest";
import {
  GhError,
  type GhRunResult,
  type GhRunner,
  ghAuthStatus,
  ghPrComment,
  ghPrEditBody,
  ghPrView,
  ghReadPrBody,
  ghRepoView,
} from "../src/post/gh-shell.js";

interface ScriptedCall {
  match: (args: string[]) => boolean;
  result: GhRunResult;
}

function scriptRunner(calls: ScriptedCall[]): GhRunner {
  let i = 0;
  return {
    async run(args: string[]): Promise<GhRunResult> {
      const next = calls[i++];
      if (!next) throw new Error(`unexpected gh call: ${args.join(" ")}`);
      if (!next.match(args)) {
        throw new Error(
          `gh call mismatch at index ${i - 1}: got ${args.join(" ")}; expected match #${i - 1}`
        );
      }
      return next.result;
    },
  };
}

const ok = (stdout: string): GhRunResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 1): GhRunResult => ({
  stdout: "",
  stderr,
  exitCode,
});

describe("ghAuthStatus", () => {
  test("returns void on exit 0", async () => {
    const runner = scriptRunner([
      {
        match: (a) => a.length === 2 && a[0] === "auth" && a[1] === "status",
        result: ok(""),
      },
    ]);
    await expect(ghAuthStatus(runner)).resolves.toBeUndefined();
  });

  test("classifies 'not logged in' as auth failure", async () => {
    const runner = scriptRunner([
      {
        match: () => true,
        result: fail("error: you are not logged into any GitHub hosts", 1),
      },
    ]);
    const err = await ghAuthStatus(runner).catch((e) => e);
    expect(err).toBeInstanceOf(GhError);
    expect((err as GhError).kind).toBe("auth");
  });
});

describe("ghPrView", () => {
  test("parses JSON output for known fields", async () => {
    const runner = scriptRunner([
      {
        match: (a) =>
          a[0] === "pr" &&
          a[1] === "view" &&
          a.includes("--json") &&
          a.includes("number,url,headRefName"),
        result: ok(
          JSON.stringify({
            number: 432,
            url: "https://github.com/myorg/repo/pull/432",
            headRefName: "feat/x",
          })
        ),
      },
    ]);
    const r = await ghPrView(runner);
    expect(r.number).toBe(432);
    expect(r.url).toBe("https://github.com/myorg/repo/pull/432");
    expect(r.headRefName).toBe("feat/x");
  });

  test("includes PR number in args when provided", async () => {
    let captured: string[] = [];
    const runner: GhRunner = {
      async run(args) {
        captured = args;
        return ok(JSON.stringify({ number: 7, url: "https://x/pull/7", headRefName: "b" }));
      },
    };
    await ghPrView(runner, 7);
    expect(captured).toContain("7");
  });

  test("rejects PR numbers ≤ 0", async () => {
    const runner: GhRunner = {
      async run() {
        return ok("");
      },
    };
    await expect(ghPrView(runner, 0)).rejects.toThrow(GhError);
    await expect(ghPrView(runner, -1)).rejects.toThrow(GhError);
  });

  test("classifies 'no pull requests found' as notFound", async () => {
    const runner = scriptRunner([
      {
        match: () => true,
        result: fail("no pull requests found for current branch", 1),
      },
    ]);
    const err = await ghPrView(runner).catch((e) => e);
    expect(err).toBeInstanceOf(GhError);
    expect((err as GhError).kind).toBe("notFound");
  });

  test("rejects non-JSON stdout", async () => {
    const runner = scriptRunner([{ match: () => true, result: ok("not json") }]);
    await expect(ghPrView(runner)).rejects.toThrow(/non-JSON/);
  });

  test("rejects JSON missing required fields", async () => {
    const runner = scriptRunner([{ match: () => true, result: ok(JSON.stringify({ number: 1 })) }]);
    await expect(ghPrView(runner)).rejects.toThrow(/missing expected fields/);
  });
});

describe("ghRepoView", () => {
  test("returns nameWithOwner from JSON", async () => {
    const runner = scriptRunner([
      {
        match: (a) =>
          a[0] === "repo" && a[1] === "view" && a[2] === "--json" && a[3] === "nameWithOwner",
        result: ok(JSON.stringify({ nameWithOwner: "synaptiai/trail" })),
      },
    ]);
    const r = await ghRepoView(runner);
    expect(r.nameWithOwner).toBe("synaptiai/trail");
  });
});

describe("ghPrEditBody", () => {
  test("uses --body-file flag with the supplied path", async () => {
    let captured: string[] = [];
    const runner: GhRunner = {
      async run(args) {
        captured = args;
        return ok("");
      },
    };
    await ghPrEditBody(runner, 42, "/tmp/body.md");
    expect(captured).toEqual(["pr", "edit", "42", "--body-file", "/tmp/body.md"]);
  });

  test("classifies rate-limit shapes correctly", async () => {
    const runner = scriptRunner([
      {
        match: () => true,
        result: fail("HTTP 403: API rate limit exceeded for user 'foo'", 1),
      },
    ]);
    const err = await ghPrEditBody(runner, 1, "/tmp/x.md").catch((e) => e);
    expect(err).toBeInstanceOf(GhError);
    expect((err as GhError).kind).toBe("rateLimit");
  });

  test("classifies network failures correctly", async () => {
    const runner = scriptRunner([
      {
        match: () => true,
        result: fail("dial tcp: lookup api.github.com: no such host", 1),
      },
    ]);
    const err = await ghPrEditBody(runner, 1, "/tmp/x.md").catch((e) => e);
    expect(err).toBeInstanceOf(GhError);
    expect((err as GhError).kind).toBe("network");
  });
});

describe("ghPrComment", () => {
  test("uses --body-file flag", async () => {
    let captured: string[] = [];
    const runner: GhRunner = {
      async run(args) {
        captured = args;
        return ok("");
      },
    };
    await ghPrComment(runner, 99, "/tmp/c.md");
    expect(captured).toEqual(["pr", "comment", "99", "--body-file", "/tmp/c.md"]);
  });
});

describe("ghReadPrBody", () => {
  test("returns the body field from gh api response", async () => {
    const runner = scriptRunner([
      {
        match: (a) => a[0] === "api" && a[1] === "repos/foo/bar/pulls/42",
        result: ok(JSON.stringify({ body: "hello world" })),
      },
    ]);
    const body = await ghReadPrBody(runner, "foo", "bar", 42);
    expect(body).toBe("hello world");
  });

  test("returns '' when API body is null", async () => {
    const runner = scriptRunner([
      { match: () => true, result: ok(JSON.stringify({ body: null })) },
    ]);
    const body = await ghReadPrBody(runner, "foo", "bar", 42);
    expect(body).toBe("");
  });

  test("rejects invalid owner segment (path-traversal defence)", async () => {
    const runner: GhRunner = {
      async run() {
        return ok("");
      },
    };
    await expect(ghReadPrBody(runner, "../etc", "bar", 1)).rejects.toThrow(/invalid owner/);
  });

  test("rejects invalid repo segment", async () => {
    const runner: GhRunner = {
      async run() {
        return ok("");
      },
    };
    await expect(ghReadPrBody(runner, "foo", "bar/../baz", 1)).rejects.toThrow(/invalid repo/);
  });
});

describe("classifyGhFailure (smoke matrix)", () => {
  // Verify each kind via ghAuthStatus surface (pure mapping function is private).
  const cases: Array<[string, "auth" | "notFound" | "rateLimit" | "network" | "other"]> = [
    ["error: you are not logged into any GitHub hosts", "auth"],
    ["could not resolve to a Pull Request with the number 9999", "notFound"],
    ["HTTP 429: rate limit exceeded", "rateLimit"],
    ["dial tcp: connection refused", "network"],
    ["something completely unexpected happened", "other"],
  ];
  for (const [stderr, expectedKind] of cases) {
    test(`stderr containing '${stderr.slice(0, 40)}…' → kind=${expectedKind}`, async () => {
      const runner = scriptRunner([{ match: () => true, result: fail(stderr) }]);
      const err = await ghAuthStatus(runner).catch((e) => e);
      expect(err).toBeInstanceOf(GhError);
      expect((err as GhError).kind).toBe(expectedKind);
    });
  }

  // SEC-4 (cycle-1 P3): heuristic precision — bare "403" or "eof" substring
  // inside user-controlled stderr echoes (paths, SHAs, identifiers) must
  // NOT mis-classify the failure. After the fix, classification falls
  // through to "other" when the trigger token isn't in a canonical context.
  test("bare '403' inside a SHA prefix does NOT classify as rateLimit", async () => {
    const runner = scriptRunner([
      {
        match: () => true,
        // a commit-like SHA prefix containing 403 — pre-fix this would have
        // been mis-classified as rateLimit.
        result: fail("error: failed to merge commit 4032bdf1: unrelated histories"),
      },
    ]);
    const err = await ghAuthStatus(runner).catch((e) => e);
    expect((err as GhError).kind).toBe("other");
  });

  test("bare 'eof' inside a path/identifier does NOT classify as network", async () => {
    const runner = scriptRunner([
      {
        match: () => true,
        result: fail("error: file '/repo/src/eofcounter.ts' is missing"),
      },
    ]);
    const err = await ghAuthStatus(runner).catch((e) => e);
    expect((err as GhError).kind).toBe("other");
  });

  test("standalone EOF as a TCP-error token DOES classify as network", async () => {
    const runner = scriptRunner([
      {
        match: () => true,
        result: fail("read tcp 127.0.0.1:443: EOF"),
      },
    ]);
    const err = await ghAuthStatus(runner).catch((e) => e);
    expect((err as GhError).kind).toBe("network");
  });

  test("'HTTP 403: forbidden' classifies as rateLimit", async () => {
    const runner = scriptRunner([
      { match: () => true, result: fail("HTTP 403: rate limit exceeded for user 'foo'") },
    ]);
    const err = await ghAuthStatus(runner).catch((e) => e);
    expect((err as GhError).kind).toBe("rateLimit");
  });
});
