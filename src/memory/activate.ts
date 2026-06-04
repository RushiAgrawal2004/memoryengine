import { searchMemories, MemorySearchResult } from "../db/memories.js";
import { startMemorySession, MemorySession } from "../db/sessions.js";
import { currentRepoRef, projectScope, RepoRef } from "../grounding/git.js";
import { config } from "../lib/config.js";

export interface ActivateMemoryInput {
  task?: string;
  scope?: string;
  cwd?: string;
  limit?: number;
  agent?: string;
}

export interface ActivateMemoryResult {
  activated: true;
  scope: string;
  session: MemorySession;
  repo?: RepoRef;
  query: string;
  memories: MemorySearchResult[];
  dashboardUrl: string;
  instructions: string[];
}

const DEFAULT_QUERY = [
  "current project architecture decisions conventions package manager auth database tests",
  "repo grounding stale code memories coding agent preferences",
].join(" ");

export async function activateMemory(
  input: ActivateMemoryInput = {},
): Promise<ActivateMemoryResult> {
  const repo = await currentRepoRef(input.cwd);
  const scope = input.scope ?? await projectScope(input.cwd);
  const query = input.task?.trim() || DEFAULT_QUERY;
  const session = await startMemorySession({
    scope,
    task: input.task,
    agent: input.agent,
    cwd: input.cwd,
  });
  const memories = await searchMemories({
    query,
    scope,
    limit: input.limit ?? 8,
  });

  return {
    activated: true,
    scope,
    session,
    repo,
    query,
    memories,
    dashboardUrl: `http://localhost:${config.port}/viewer`,
    instructions: [
      `Memory is active for scope ${scope}.`,
      `Attach future memory.remember calls to sessionId ${session.id}.`,
      "Use the returned memories as project context before answering or editing.",
      "Call memory.search again when the task shifts or more context is needed.",
      "Call memory.remember after durable decisions, conventions, architecture facts, or code changes.",
      "Call memory.audit when relying on code-grounded memories that may be stale.",
    ],
  };
}
