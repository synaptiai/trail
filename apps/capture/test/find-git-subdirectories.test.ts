// v0.1.3 bug-3 regression test: when `trail packet generate` is run
// from a directory that contains git repos in subdirectories but is
// not itself a git repo, the error must point the user at the
// candidate subdirectories rather than just saying "not a git
// repository".

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findGitSubdirectories } from "../src/generate.js";

describe("findGitSubdirectories", () => {
  test("returns subdirectories whose '.git' is a directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "trail-git-scan-"));
    mkdirSync(join(parent, "repo-a", ".git"), { recursive: true });
    mkdirSync(join(parent, "repo-b", ".git"), { recursive: true });
    mkdirSync(join(parent, "not-a-repo"));
    const found = findGitSubdirectories(parent);
    expect(found).toEqual([join(parent, "repo-a"), join(parent, "repo-b")]);
  });

  test("returns subdirectories whose '.git' is a file (worktree/submodule)", () => {
    // Git worktrees and submodules use a `.git` *file* containing
    // `gitdir: <path>`. The scanner must accept those too.
    const parent = mkdtempSync(join(tmpdir(), "trail-git-scan-"));
    mkdirSync(join(parent, "worktree-clone"), { recursive: true });
    writeFileSync(join(parent, "worktree-clone", ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    const found = findGitSubdirectories(parent);
    expect(found).toEqual([join(parent, "worktree-clone")]);
  });

  test("ignores dotfile directories and non-directory entries", () => {
    const parent = mkdtempSync(join(tmpdir(), "trail-git-scan-"));
    mkdirSync(join(parent, ".hidden", ".git"), { recursive: true });
    writeFileSync(join(parent, "plain.txt"), "not a dir");
    const found = findGitSubdirectories(parent);
    expect(found).toEqual([]);
  });

  test("returns empty array when no candidates exist", () => {
    const parent = mkdtempSync(join(tmpdir(), "trail-git-scan-"));
    mkdirSync(join(parent, "boring"));
    expect(findGitSubdirectories(parent)).toEqual([]);
  });

  test("returns empty array when parent is unreadable / does not exist", () => {
    // Best-effort UX — must not throw on EACCES / ENOENT.
    expect(findGitSubdirectories("/nonexistent/path/that/should/never/exist")).toEqual([]);
  });

  test("caps results at 10 entries to bound output for many-clone parents", () => {
    const parent = mkdtempSync(join(tmpdir(), "trail-git-scan-"));
    for (let i = 0; i < 15; i += 1) {
      mkdirSync(join(parent, `repo-${String(i).padStart(2, "0")}`, ".git"), {
        recursive: true,
      });
    }
    const found = findGitSubdirectories(parent);
    expect(found).toHaveLength(10);
  });
});
