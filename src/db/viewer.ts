import { getSqlClient } from "./client.js";

export interface ViewerMemory {
  id: string;
  type: string;
  scope: string;
  content: string;
  status: string;
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
  scope: string;
  kind: string;
  source: string;
  content: string;
  occurredAt: Date;
  createdAt: Date;
}

export interface ViewerListInput {
  q?: string;
  scope?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function listViewerMemories(
  input: ViewerListInput = {},
): Promise<ViewerMemory[]> {
  const sql = getSqlClient();
  const query = searchPattern(input.q);
  const scope = normalized(input.scope);

  return sql<ViewerMemory[]>`
    select
      id,
      type,
      scope,
      content,
      status,
      confidence,
      t_valid as "tValid",
      t_invalid as "tInvalid",
      t_created as "tCreated",
      t_expired as "tExpired",
      created_at as "createdAt"
    from memories
    where (${scope}::text is null or scope = ${scope})
      and (${query}::text is null or content ilike ${query})
    order by created_at desc
    limit ${limitFor(input.limit)}
  `;
}

export async function listViewerEntities(
  input: ViewerListInput = {},
): Promise<ViewerEntity[]> {
  const sql = getSqlClient();
  const query = searchPattern(input.q);
  const scope = normalized(input.scope);

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
      and (${query}::text is null or name ilike ${query} or kind ilike ${query})
    order by created_at desc
    limit ${limitFor(input.limit)}
  `;
}

export async function listViewerEdges(input: ViewerListInput = {}): Promise<ViewerEdge[]> {
  const sql = getSqlClient();
  const query = searchPattern(input.q);
  const scope = normalized(input.scope);

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

  return sql<ViewerEpisode[]>`
    select
      id,
      scope,
      kind,
      source,
      content,
      occurred_at as "occurredAt",
      created_at as "createdAt"
    from episodes
    where (${scope}::text is null or scope = ${scope})
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
