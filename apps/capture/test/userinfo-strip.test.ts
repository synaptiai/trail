import { describe, expect, test } from "vitest";
import { parseRemoteToOwnerRepo, stripUserinfo } from "../src/git/url.js";

describe("stripUserinfo (A4.5 SEC-2 / SEC-4)", () => {
  test("strips x-access-token userinfo from GitHub HTTPS remote", () => {
    const url = "https://x-access-token:ghp_xxx@github.com/foo/bar.git";
    const stripped = stripUserinfo(url);
    expect(stripped).not.toContain("ghp_xxx");
    expect(stripped).not.toContain("x-access-token");
    expect(stripped).toContain("github.com");
  });

  test("does not modify URLs without userinfo", () => {
    const url = "https://github.com/foo/bar.git";
    expect(stripUserinfo(url)).toBe(url);
  });

  test("handles oauth2 userinfo", () => {
    const url = "https://oauth2:abc@gitlab.com/owner/repo.git";
    const stripped = stripUserinfo(url);
    expect(stripped).not.toContain("abc");
    expect(stripped).not.toContain("oauth2");
  });

  test("returns original on invalid URL", () => {
    expect(stripUserinfo("not-a-url")).toBe("not-a-url");
  });
});

describe("parseRemoteToOwnerRepo", () => {
  test("HTTPS form yields owner/repo", () => {
    expect(parseRemoteToOwnerRepo("https://github.com/foo/bar.git")).toBe("foo/bar");
  });

  test("HTTPS form with token yields owner/repo (token discarded)", () => {
    expect(parseRemoteToOwnerRepo("https://x-access-token:ghp_xxx@github.com/foo/bar.git")).toBe(
      "foo/bar"
    );
  });

  test("SSH form yields owner/repo", () => {
    expect(parseRemoteToOwnerRepo("git@github.com:foo/bar.git")).toBe("foo/bar");
  });

  test("empty string returns empty", () => {
    expect(parseRemoteToOwnerRepo("")).toBe("");
  });
});
