import { projectScope } from "../grounding/git.js";

export async function resolveMemoryScope(
  scope: string | undefined,
  cwd?: string,
): Promise<string> {
  const trimmed = scope?.trim();
  if (!trimmed || isGenericProjectScope(trimmed)) {
    return projectScope(cwd);
  }

  return trimmed;
}

export function isGenericProjectScope(scope: string): boolean {
  return scope === "project" || scope === "project:";
}
