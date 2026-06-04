import { getSqlClient } from "./client.js";
import { currentRepoRef, projectScope, RepoRef } from "../grounding/git.js";

export interface MemorySession {
  id: string;
  scope: string;
  title: string | null;
  task: string | null;
  agent: string | null;
  status: string;
  repoRef: RepoRef | null;
  startedAt: Date;
  endedAt: Date | null;
}

export interface StartSessionInput {
  scope?: string;
  title?: string;
  task?: string;
  agent?: string;
  cwd?: string;
}

const DEFAULT_SCOPE = "global";

export async function startMemorySession(input: StartSessionInput = {}): Promise<MemorySession> {
  const sql = getSqlClient();
  const repoRef = await currentRepoRef(input.cwd);
  const scope = input.scope ?? (repoRef ? await projectScope(input.cwd) : DEFAULT_SCOPE);
  const title = input.title ?? titleFor(input.task);

  const [session] = await sql<MemorySession[]>`
    insert into chat_sessions (scope, title, task, agent, repo_ref)
    values (
      ${scope},
      ${title},
      ${input.task ?? null},
      ${input.agent ?? null},
      ${repoRef ? sql.json(repoRef as never) : null}
    )
    returning
      id,
      scope,
      title,
      task,
      agent,
      status,
      repo_ref as "repoRef",
      started_at as "startedAt",
      ended_at as "endedAt"
  `;

  return session;
}

export async function endMemorySession(sessionId: string): Promise<MemorySession | undefined> {
  const sql = getSqlClient();
  const [session] = await sql<MemorySession[]>`
    update chat_sessions
    set status = 'ended',
        ended_at = now()
    where id = ${sessionId}
    returning
      id,
      scope,
      title,
      task,
      agent,
      status,
      repo_ref as "repoRef",
      started_at as "startedAt",
      ended_at as "endedAt"
  `;

  return session;
}

function titleFor(task: string | undefined): string | null {
  const trimmed = task?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}
