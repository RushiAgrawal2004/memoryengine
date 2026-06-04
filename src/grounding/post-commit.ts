import { revalidatePass } from "../consolidate/loop.js";
import { flagStaleMemories, MemoryAudit } from "./staleness.js";
import { projectScope } from "./git.js";

export interface GitPostCommitInput {
  cwd?: string;
  scope?: string;
  changedFiles: string[];
}

export interface GitPostCommitResult {
  scope: string;
  changedFiles: string[];
  audit: MemoryAudit;
  revalidate: {
    checked: number;
    changed: number;
  };
}

export async function handleGitPostCommit(
  input: GitPostCommitInput,
): Promise<GitPostCommitResult> {
  const cwd = input.cwd ?? process.cwd();
  const scope = input.scope ?? await projectScope(cwd);
  const changedFiles = [...new Set(input.changedFiles.map(normalizeFile).filter(Boolean))];
  const audit = await flagStaleMemories(scope, cwd, changedFiles);
  const revalidate = await revalidatePass({ scope, cwd, changedFiles });

  return {
    scope,
    changedFiles,
    audit,
    revalidate: {
      checked: revalidate.checked,
      changed: revalidate.changed,
    },
  };
}

function normalizeFile(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\/+/, "").trim();
}
