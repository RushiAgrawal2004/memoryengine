import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepoRef {
  repo: string;
  branch: string;
  commit: string;
}

export async function currentRepoRef(cwd = process.cwd()): Promise<RepoRef | undefined> {
  try {
    const [topLevel, branch, commit] = await Promise.all([
      git(["rev-parse", "--show-toplevel"], cwd),
      git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
      git(["rev-parse", "HEAD"], cwd),
    ]);

    return {
      repo: repoNameFromTopLevel(topLevel, cwd),
      branch: branch.trim(),
      commit: commit.trim(),
    };
  } catch {
    return undefined;
  }
}

export async function projectScope(cwd = process.cwd()): Promise<string> {
  const repoRef = await currentRepoRef(cwd);
  return repoRef ? `project:${repoRef.repo}` : `project:${path.basename(path.resolve(cwd))}`;
}

export async function listChangedFiles(
  sinceCommit: string,
  cwd = process.cwd(),
): Promise<string[]> {
  const output = await git(["diff", "--name-only", `${sinceCommit}..HEAD`], cwd);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function latestFileCommit(
  filePath: string,
  cwd = process.cwd(),
): Promise<string | undefined> {
  try {
    const output = await git(["log", "-n", "1", "--format=%H", "--", filePath], cwd);
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });

  return stdout;
}

export function repoNameFromTopLevel(topLevel: string, cwd = process.cwd()): string {
  const normalized = topLevel.trim().replace(/[\\/]+$/, "");
  return path.basename(normalized) || path.basename(path.resolve(cwd));
}
