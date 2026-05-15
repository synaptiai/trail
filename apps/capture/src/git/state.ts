// Git state collection via shell-out. Mirrors py-reference's collect_git_state.
// Empty-string fallbacks per spec §13 #11; only repo-presence triggers exit 3.

import { spawnSync } from "node:child_process";
import { parseRemoteToOwnerRepo } from "./url.js";

export interface GitState {
  repository: string;
  branch: string;
  base_branch: string;
  author: string;
  base_sha: string;
  head_sha: string;
  lines_added: number;
  lines_deleted: number;
  files_changed_count: number;
}

export class GitNotARepoError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`not a git repository: ${path}`);
    this.name = "GitNotARepoError";
    this.path = path;
  }
}

function git(args: string[], cwd: string): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 10_000 });
  if (res.status !== 0) return "";
  return (res.stdout ?? "").trim();
}

export function collectGitState(cwd: string): GitState {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  if (!top) {
    throw new GitNotARepoError(cwd);
  }

  const remoteUrl = git(["config", "--get", "remote.origin.url"], cwd);
  const repository = parseRemoteToOwnerRepo(remoteUrl);

  let branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branch === "HEAD") branch = "";

  let baseBranch = "";
  for (const cand of ["origin/main", "origin/master", "main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", cand], cwd)) {
      baseBranch = cand;
      break;
    }
  }

  const author = git(["config", "user.email"], cwd);
  const headSha = git(["rev-parse", "HEAD"], cwd);
  const baseSha = baseBranch ? git(["merge-base", baseBranch, "HEAD"], cwd) : "";

  let linesAdded = 0;
  let linesDeleted = 0;
  let filesChangedCount = 0;
  if (baseSha && headSha) {
    const numstat = git(["diff", "--numstat", `${baseSha}..${headSha}`], cwd);
    for (const line of numstat.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      if (/^\d+$/.test(parts[0]!)) linesAdded += Number(parts[0]);
      if (/^\d+$/.test(parts[1]!)) linesDeleted += Number(parts[1]);
      filesChangedCount += 1;
    }
  }

  return {
    repository,
    branch,
    base_branch: baseBranch,
    author,
    base_sha: baseSha,
    head_sha: headSha,
    lines_added: linesAdded,
    lines_deleted: linesDeleted,
    files_changed_count: filesChangedCount,
  };
}
