import { getSqlClient } from "./client.js";

export interface ViewerMemory {
  id: string;
  type: string;
  scope: string;
  content: string;
  status: string;
  sourceSession: string | null;
  confidence: number;
  tValid: Date | null;
  tInvalid: Date | null;
  tCreated: Date;
  tExpired: Date | null;
  createdAt: Date;
}

export interface ViewerEntity {
  id: string;
  scope: string;
  kind: string;
  name: string;
  attrs: Record<string, unknown> | null;
  createdAt: Date;
}

export interface ViewerEdge {
  id: string;
  scope: string;
  source: string | null;
  target: string | null;
  relation: string;
  fact: string | null;
  tValid: Date | null;
  tInvalid: Date | null;
  tCreated: Date;
  tExpired: Date | null;
  createdAt: Date;
}

export interface ViewerEpisode {
  id: string;
  sessionId: string | null;
  scope: string;
  kind: string;
  source: string;
  content: string;
  occurredAt: Date;
  createdAt: Date;
}

export interface ViewerSession {
  id: string;
  scope: string;
  title: string | null;
  task: string | null;
  agent: string | null;
  status: string;
  memoryCount: number;
  episodeCount: number;
  startedAt: Date;
  endedAt: Date | null;
  createdAt: Date;
}

export interface ViewerListInput {
  q?: string;
  scope?: string;
  limit?: number;
  includeInternal?: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function listViewerMemories(
  input: ViewerListInput = {},
): Promise<ViewerMemory[]> {
  const sql = getSqlClient();
  const query = searchPattern(input.q);
  const scope = normalized(input.scope);
  const includeInternal = Boolean(input.includeInternal);

  return sql<ViewerMemory[]>`
    select
      id,
      type,
      scope,
      content,
      status,
      source_session as "sourceSession",
      confidence,
      t_valid as "tValid",
      t_invalid as "tInvalid",
      t_created as "tCreated",
      t_expired as "tExpired",
      created_at as "createdAt"
    from memories
    where (${scope}::text is null or scope = ${scope})
      and (
        ${includeInternal}::boolean
        or ${scope}::text is not null
        or (
          scope not like 'test%'
          and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')
        )
      )
      and (${query}::text is null or content ilike ${query})
    order by created_at desc
    limit ${limitFor(input.limit)}
  `;
}

export async function listViewerSessions(
  input: ViewerListInput = {},
): Promise<ViewerSession[]> {
  const sql = getSqlClient();
  const query = searchPattern(input.q);
  const scope = normalized(input.scope);
  const includeInternal = Boolean(input.includeInternal);

  return sql<ViewerSession[]>`
    select
      chat_sessions.id,
      chat_sessions.scope,
      chat_sessions.title,
      chat_sessions.task,
      chat_sessions.agent,
      chat_sessions.status,
      count(distinct memories.id)::int as "memoryCount",
      count(distinct episodes.id)::int as "episodeCount",
      chat_sessions.started_at as "startedAt",
      chat_sessions.ended_at as "endedAt",
      chat_sessions.created_at as "createdAt"
    from chat_sessions
    left join memories on memories.source_session = chat_sessions.id
    left join episodes on episodes.session_id = chat_sessions.id
    where (${scope}::text is null or chat_sessions.scope = ${scope})
      and (
        ${includeInternal}::boolean
        or ${scope}::text is not null
        or (
          chat_sessions.scope not like 'test%'
          and chat_sessions.scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')
        )
      )
      and (
        ${query}::text is null
        or chat_sessions.title ilike ${query}
        or chat_sessions.task ilike ${query}
        or chat_sessions.agent ilike ${query}
      )
    group by chat_sessions.id
    order by chat_sessions.started_at desc
    limit ${limitFor(input.limit)}
  `;
}

export async function listViewerEntities(
  input: ViewerListInput = {},
): Promise<ViewerEntity[]> {
  const sql = getSqlClient();
  const query = searchPattern(input.q);
  const scope = normalized(input.scope);
  const includeInternal = Boolean(input.includeInternal);

  return sql<ViewerEntity[]>`
    select
      id,
      scope,
      kind,
      name,
      attrs,
      created_at as "createdAt"
    from entities
    where (${scope}::text is null or scope = ${scope})
      and (
        ${includeInternal}::boolean
        or ${scope}::text is not null
        or (
          scope not like 'test%'
          and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')
        )
      )
      and (${query}::text is null or name ilike ${query} or kind ilike ${query})
    order by created_at desc
    limit ${limitFor(input.limit)}
  `;
}

export async function listViewerEdges(input: ViewerListInput = {}): Promise<ViewerEdge[]> {
  const sql = getSqlClient();
  const query = searchPattern(input.q);
  const scope = normalized(input.scope);
  const includeInternal = Boolean(input.includeInternal);

  return sql<ViewerEdge[]>`
    select
      edges.id,
      edges.scope,
      src.name as source,
      dst.name as target,
      edges.relation,
      edges.fact,
      edges.t_valid as "tValid",
      edges.t_invalid as "tInvalid",
      edges.t_created as "tCreated",
      edges.t_expired as "tExpired",
      edges.created_at as "createdAt"
    from edges
    left join entities src on src.id = edges.src
    left join entities dst on dst.id = edges.dst
    where (${scope}::text is null or edges.scope = ${scope})
      and (
        ${includeInternal}::boolean
        or ${scope}::text is not null
        or (
          edges.scope not like 'test%'
          and edges.scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')
        )
      )
      and (
        ${query}::text is null
        or edges.fact ilike ${query}
        or edges.relation ilike ${query}
        or src.name ilike ${query}
        or dst.name ilike ${query}
      )
    order by edges.created_at desc
    limit ${limitFor(input.limit)}
  `;
}

export async function listViewerEpisodes(
  input: ViewerListInput = {},
): Promise<ViewerEpisode[]> {
  const sql = getSqlClient();
  const query = searchPattern(input.q);
  const scope = normalized(input.scope);
  const includeInternal = Boolean(input.includeInternal);

  return sql<ViewerEpisode[]>`
    select
      id,
      session_id as "sessionId",
      scope,
      kind,
      source,
      content,
      occurred_at as "occurredAt",
      created_at as "createdAt"
    from episodes
    where (${scope}::text is null or scope = ${scope})
      and (
        ${includeInternal}::boolean
        or ${scope}::text is not null
        or (
          scope not like 'test%'
          and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')
        )
      )
      and (
        ${query}::text is null
        or content ilike ${query}
        or kind ilike ${query}
        or source ilike ${query}
      )
    order by created_at desc
    limit ${limitFor(input.limit)}
  `;
}

function normalized(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function searchPattern(value: string | undefined): string | null {
  const trimmed = normalized(value);
  return trimmed ? `%${trimmed}%` : null;
}

function limitFor(value: number | undefined): number {
  if (!value || Number.isNaN(value)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}
