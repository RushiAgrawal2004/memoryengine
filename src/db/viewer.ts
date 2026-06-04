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

export interface ViewerOverview {
  counts: {
    sessions: number;
    activeSessions: number;
    episodes: number;
    memories: number;
    activeMemories: number;
    invalidMemories: number;
    archivedMemories: number;
    needsRevalidation: number;
    entities: number;
    edges: number;
  };
  scopes: Array<{ scope: string; sessions: number; memories: number; episodes: number }>;
  recentSessions: ViewerSession[];
  recentMemories: ViewerMemory[];
}

export interface ViewerActivityItem {
  id: string;
  scope: string;
  kind: string;
  title: string;
  detail: string | null;
  sessionId: string | null;
  occurredAt: Date;
}

export interface ViewerAuditItem {
  id: string;
  scope: string;
  kind: string;
  status: string;
  detail: string;
  createdAt: Date;
}

export interface ViewerProfile {
  scope: string;
  sessions: number;
  memories: number;
  episodes: number;
  entities: number;
  edges: number;
  latestSession: ViewerSession | null;
  topEntities: ViewerEntity[];
  recentMemories: ViewerMemory[];
}

export interface ViewerGraphData {
  nodes: Array<{ id: string; label: string; kind: string; scope: string }>;
  edges: Array<{
    id: string;
    source: string | null;
    target: string | null;
    relation: string;
    fact: string | null;
    scope: string;
  }>;
}

export interface ViewerListInput {
  q?: string;
  scope?: string;
  limit?: number;
  includeInternal?: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function getViewerOverview(
  input: ViewerListInput = {},
): Promise<ViewerOverview> {
  const sql = getSqlClient();
  const scope = normalized(input.scope);
  const includeInternal = Boolean(input.includeInternal);
  const [counts] = await sql<Array<ViewerOverview["counts"]>>`
    select
      (select count(*)::int from chat_sessions where (${scope}::text is null or scope = ${scope}) and (${includeInternal}::boolean or ${scope}::text is not null or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')))) as "sessions",
      (select count(*)::int from chat_sessions where status = 'active' and (${scope}::text is null or scope = ${scope}) and (${includeInternal}::boolean or ${scope}::text is not null or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')))) as "activeSessions",
      (select count(*)::int from episodes where (${scope}::text is null or scope = ${scope}) and (${includeInternal}::boolean or ${scope}::text is not null or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')))) as "episodes",
      (select count(*)::int from memories where (${scope}::text is null or scope = ${scope}) and (${includeInternal}::boolean or ${scope}::text is not null or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')))) as "memories",
      (select count(*)::int from memories where status = 'active' and (${scope}::text is null or scope = ${scope}) and (${includeInternal}::boolean or ${scope}::text is not null or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')))) as "activeMemories",
      (select count(*)::int from memories where status = 'invalid' and (${scope}::text is null or scope = ${scope}) and (${includeInternal}::boolean or ${scope}::text is not null or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')))) as "invalidMemories",
      (select count(*)::int from memories where status = 'archived' and (${scope}::text is null or scope = ${scope}) and (${includeInternal}::boolean or ${scope}::text is not null or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')))) as "archivedMemories",
      (select count(*)::int from memories where coalesce((attrs->>'needs_revalidation')::boolean, false) and (${scope}::text is null or scope = ${scope}) and (${includeInternal}::boolean or ${scope}::text is not null or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')))) as "needsRevalidation",
      (select count(*)::int from entities where (${scope}::text is null or scope = ${scope}) and (${includeInternal}::boolean or ${scope}::text is not null or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')))) as "entities",
      (select count(*)::int from edges where (${scope}::text is null or scope = ${scope}) and (${includeInternal}::boolean or ${scope}::text is not null or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')))) as "edges"
  `;
  const scopes = await sql<Array<{
    scope: string;
    sessions: number;
    memories: number;
    episodes: number;
  }>>`
    select
      scope,
      sum(sessions)::int as sessions,
      sum(memories)::int as memories,
      sum(episodes)::int as episodes
    from (
      select scope, count(*)::int as sessions, 0 as memories, 0 as episodes
      from chat_sessions
      where (${scope}::text is null or scope = ${scope})
        and (${includeInternal}::boolean or ${scope}::text is not null or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')))
      group by scope
      union all
      select scope, 0 as sessions, count(*)::int as memories, 0 as episodes
      from memories
      where (${scope}::text is null or scope = ${scope})
        and (${includeInternal}::boolean or ${scope}::text is not null or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')))
      group by scope
      union all
      select scope, 0 as sessions, 0 as memories, count(*)::int as episodes
      from episodes
      where (${scope}::text is null or scope = ${scope})
        and (${includeInternal}::boolean or ${scope}::text is not null or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')))
      group by scope
    ) scope_counts
    group by scope
    order by (sum(sessions) + sum(memories) + sum(episodes)) desc, scope asc
    limit 10
  `;

  return {
    counts: counts ?? {
      sessions: 0,
      activeSessions: 0,
      episodes: 0,
      memories: 0,
      activeMemories: 0,
      invalidMemories: 0,
      archivedMemories: 0,
      needsRevalidation: 0,
      entities: 0,
      edges: 0,
    },
    scopes,
    recentSessions: await listViewerSessions({ ...input, limit: 5 }),
    recentMemories: await listViewerMemories({ ...input, limit: 5 }),
  };
}

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

export async function listViewerActivity(
  input: ViewerListInput = {},
): Promise<ViewerActivityItem[]> {
  const [episodes, memories, sessions] = await Promise.all([
    listViewerEpisodes({ ...input, limit: 30 }),
    listViewerMemories({ ...input, limit: 30 }),
    listViewerSessions({ ...input, limit: 30 }),
  ]);
  const items: ViewerActivityItem[] = [
    ...episodes.map((episode) => ({
      id: episode.id,
      scope: episode.scope,
      kind: `episode:${episode.kind}`,
      title: episode.source,
      detail: episode.content,
      sessionId: episode.sessionId,
      occurredAt: episode.occurredAt,
    })),
    ...memories.map((memory) => ({
      id: memory.id,
      scope: memory.scope,
      kind: `memory:${memory.status}`,
      title: memory.type,
      detail: memory.content,
      sessionId: memory.sourceSession,
      occurredAt: memory.createdAt,
    })),
    ...sessions.map((session) => ({
      id: session.id,
      scope: session.scope,
      kind: `session:${session.status}`,
      title: session.title ?? session.task ?? "Untitled session",
      detail: session.agent,
      sessionId: session.id,
      occurredAt: session.startedAt,
    })),
  ];

  return items
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, limitFor(input.limit));
}

export async function listViewerAudit(
  input: ViewerListInput = {},
): Promise<ViewerAuditItem[]> {
  const sql = getSqlClient();
  const query = searchPattern(input.q);
  const scope = normalized(input.scope);
  const includeInternal = Boolean(input.includeInternal);

  return sql<ViewerAuditItem[]>`
    select
      id,
      scope,
      case
        when coalesce((attrs->>'needs_revalidation')::boolean, false) then 'needs_revalidation'
        when status = 'invalid' then 'invalidated'
        when status = 'archived' then 'archived'
        when supersedes is not null then 'supersedes'
        else 'memory'
      end as kind,
      status,
      content as detail,
      created_at as "createdAt"
    from memories
    where (${scope}::text is null or scope = ${scope})
      and (${includeInternal}::boolean or ${scope}::text is not null or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo')))
      and (
        status <> 'active'
        or supersedes is not null
        or coalesce((attrs->>'needs_revalidation')::boolean, false)
      )
      and (${query}::text is null or content ilike ${query} or status ilike ${query})
    order by created_at desc
    limit ${limitFor(input.limit)}
  `;
}

export async function getViewerProfile(
  input: ViewerListInput = {},
): Promise<ViewerProfile[]> {
  const sql = getSqlClient();
  const scope = normalized(input.scope);
  const includeInternal = Boolean(input.includeInternal);
  const scopes = scope
    ? [{ scope }]
    : await sql<Array<{ scope: string }>>`
        select scope
        from (
          select scope, created_at from chat_sessions where ${includeInternal}::boolean or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo'))
          union all
          select scope, created_at from memories where ${includeInternal}::boolean or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo'))
          union all
          select scope, created_at from episodes where ${includeInternal}::boolean or (scope not like 'test%' and scope not in ('project:memoryengine-demo', 'project:todo-codex-demo'))
        ) activity
        group by scope
        order by max(created_at) desc
        limit ${Math.min(limitFor(input.limit), 12)}
      `;
  const profiles: ViewerProfile[] = [];

  for (const item of scopes) {
    const [counts] = await sql<Array<{
      sessions: number;
      memories: number;
      episodes: number;
      entities: number;
      edges: number;
    }>>`
      select
        (select count(*)::int from chat_sessions where scope = ${item.scope}) as sessions,
        (select count(*)::int from memories where scope = ${item.scope}) as memories,
        (select count(*)::int from episodes where scope = ${item.scope}) as episodes,
        (select count(*)::int from entities where scope = ${item.scope}) as entities,
        (select count(*)::int from edges where scope = ${item.scope}) as edges
    `;
    profiles.push({
      scope: item.scope,
      sessions: counts?.sessions ?? 0,
      memories: counts?.memories ?? 0,
      episodes: counts?.episodes ?? 0,
      entities: counts?.entities ?? 0,
      edges: counts?.edges ?? 0,
      latestSession: (await listViewerSessions({ scope: item.scope, limit: 1 }))[0] ?? null,
      topEntities: await listViewerEntities({ scope: item.scope, limit: 5 }),
      recentMemories: await listViewerMemories({ scope: item.scope, limit: 3 }),
    });
  }

  return profiles;
}

export async function getViewerGraphData(
  input: ViewerListInput = {},
): Promise<ViewerGraphData> {
  const [entities, edges] = await Promise.all([
    listViewerEntities({ ...input, limit: 80 }),
    listViewerEdges({ ...input, limit: 120 }),
  ]);

  return {
    nodes: entities.map((entity) => ({
      id: entity.id,
      label: entity.name,
      kind: entity.kind,
      scope: entity.scope,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      fact: edge.fact,
      scope: edge.scope,
    })),
  };
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
