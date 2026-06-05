import { projectScope } from "../grounding/git.js";

export async function resolveMemoryScope(
  scope: string | undefined,
  cwd?: string,
): Promise<string> {
  const trimmed = normalizeScope(scope);
  if (!trimmed || isGenericProjectScope(trimmed)) {
    return projectScope(cwd);
  }

  return trimmed;
}

export function normalizeScope(scope: string | undefined): string | undefined {
  const trimmed = scope?.trim();
  return trimmed ? trimmed : undefined;
}

export function isGenericProjectScope(scope: string): boolean {
  return scope === "project" || scope === "project:";
}
