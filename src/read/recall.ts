import { getSqlClient } from "../db/client.js";
import {
  hasEmbeddingVectorColumn,
  localEmbeddingFallbackEnabled,
  vectorLiteral,
} from "../db/embedding-vectors.js";
import { getEmbeddings } from "../providers/embeddings.js";

export interface RecallResult {
  id: string;
  type: string;
  scope: string;
  content: string;
  rank: number;
  createdAt: string;
}

interface MemoryRow {
  id: string;
  type: string;
  scope: string;
  content: string;
  embedding: number[] | null;
  createdAt: string;
}

const VECTOR_CANDIDATE_LIMIT = 500;

export async function vectorRecall(
  query: string,
  scope: string | undefined,
  k: number,
  asOf?: Date,
): Promise<RecallResult[]> {
  const [queryEmbedding] = await getEmbeddings().embed([query]);
  if (await hasEmbeddingVectorColumn("memories")) {
    return pgVectorRecall(queryEmbedding, scope, k, asOf);
  }

  if (!localEmbeddingFallbackEnabled()) {
    return [];
  }

  const sql = getSqlClient();

  const rows = asOf
    ? scope
      ? await sql<MemoryRow[]>`
          select
            id,
            type,
            scope,
            content,
            embedding,
            created_at::text as "createdAt"
          from memories
          where scope = ${scope}
            and embedding is not null
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit ${VECTOR_CANDIDATE_LIMIT}
        `
      : await sql<MemoryRow[]>`
          select
            id,
            type,
            scope,
            content,
            embedding,
            created_at::text as "createdAt"
          from memories
          where embedding is not null
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit ${VECTOR_CANDIDATE_LIMIT}
        `
    : scope
      ? await sql<MemoryRow[]>`
        select
          id,
          type,
          scope,
          content,
          embedding,
          created_at::text as "createdAt"
        from memories
        where status = 'active'
          and scope = ${scope}
          and embedding is not null
        order by created_at desc
        limit ${VECTOR_CANDIDATE_LIMIT}
      `
      : await sql<MemoryRow[]>`
        select
          id,
          type,
          scope,
          content,
          embedding,
          created_at::text as "createdAt"
        from memories
        where status = 'active'
          and embedding is not null
        order by created_at desc
        limit ${VECTOR_CANDIDATE_LIMIT}
      `;

  return rows
    .map((row) => ({
      id: row.id,
      type: row.type,
      scope: row.scope,
      content: row.content,
      rank: cosineSimilarity(queryEmbedding, row.embedding ?? []),
      createdAt: row.createdAt,
    }))
    .filter((row) => row.rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, k);
}

async function pgVectorRecall(
  queryEmbedding: number[],
  scope: string | undefined,
  k: number,
  asOf?: Date,
): Promise<RecallResult[]> {
  const sql = getSqlClient();
  const vector = vectorLiteral(queryEmbedding);

  return asOf
    ? scope
      ? await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            (1 - (embedding_vector <=> ${vector}::vector))::real as rank,
            created_at::text as "createdAt"
          from memories
          where scope = ${scope}
            and embedding_vector is not null
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by embedding_vector <=> ${vector}::vector
          limit ${k}
        `
      : await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            (1 - (embedding_vector <=> ${vector}::vector))::real as rank,
            created_at::text as "createdAt"
          from memories
          where embedding_vector is not null
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by embedding_vector <=> ${vector}::vector
          limit ${k}
        `
    : scope
      ? await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            (1 - (embedding_vector <=> ${vector}::vector))::real as rank,
            created_at::text as "createdAt"
          from memories
          where status = 'active'
            and scope = ${scope}
            and embedding_vector is not null
          order by embedding_vector <=> ${vector}::vector
          limit ${k}
        `
      : await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            (1 - (embedding_vector <=> ${vector}::vector))::real as rank,
            created_at::text as "createdAt"
          from memories
          where status = 'active'
            and embedding_vector is not null
          order by embedding_vector <=> ${vector}::vector
          limit ${k}
        `;
}

export async function ftsRecall(
  query: string,
  scope: string | undefined,
  k: number,
  asOf?: Date,
): Promise<RecallResult[]> {
  const sql = getSqlClient();

  return asOf
    ? scope
      ? await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            ts_rank(fts, websearch_to_tsquery('english', ${query}))::real as rank,
            created_at::text as "createdAt"
          from memories
          where scope = ${scope}
            and fts @@ websearch_to_tsquery('english', ${query})
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by rank desc, created_at desc
          limit ${k}
        `
      : await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            ts_rank(fts, websearch_to_tsquery('english', ${query}))::real as rank,
            created_at::text as "createdAt"
          from memories
          where fts @@ websearch_to_tsquery('english', ${query})
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by rank desc, created_at desc
          limit ${k}
        `
    : scope
      ? await sql<RecallResult[]>`
        select
          id,
          type,
          scope,
          content,
          ts_rank(fts, websearch_to_tsquery('english', ${query}))::real as rank,
          created_at::text as "createdAt"
        from memories
        where
          status = 'active'
          and scope = ${scope}
          and fts @@ websearch_to_tsquery('english', ${query})
        order by rank desc, created_at desc
        limit ${k}
      `
      : await sql<RecallResult[]>`
        select
          id,
          type,
          scope,
          content,
          ts_rank(fts, websearch_to_tsquery('english', ${query}))::real as rank,
          created_at::text as "createdAt"
        from memories
        where
          status = 'active'
          and fts @@ websearch_to_tsquery('english', ${query})
        order by rank desc, created_at desc
        limit ${k}
      `;
}

export async function keywordRecall(
  query: string,
  scope: string | undefined,
  k: number,
  asOf?: Date,
): Promise<RecallResult[]> {
  const sql = getSqlClient();
  const rows = asOf
    ? scope
      ? await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt"
          from memories
          where scope = ${scope}
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit 1000
        `
      : await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt"
          from memories
          where (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit 1000
        `
    : scope
      ? await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt"
          from memories
          where status = 'active'
            and scope = ${scope}
          order by created_at desc
          limit 1000
        `
      : await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt"
          from memories
          where status = 'active'
          order by created_at desc
          limit 1000
        `;
  const queryTokens = meaningfulTokens(query);

  return rows
    .map((row) => ({
      ...row,
      rank: tokenOverlapScore(queryTokens, meaningfulTokens(row.content)),
    }))
    .filter((row) => row.rank > 0)
    .sort((a, b) => b.rank - a.rank || b.createdAt.localeCompare(a.createdAt))
    .slice(0, k);
}

export async function temporalRecall(
  query: string,
  scope: string | undefined,
  k: number,
  asOf?: Date,
): Promise<RecallResult[]> {
  if (!isTemporalQuery(query)) {
    return [];
  }

  const sql = getSqlClient();
  const rows = asOf
    ? scope
      ? await sql<Array<RecallResult & { eventDate: string | null; temporalRefs: unknown }>>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            attrs->'observation'->>'eventDate' as "eventDate",
            attrs->'observation'->'temporalRefs' as "temporalRefs"
          from memories
          where scope = ${scope}
            and (attrs->'observation'->>'eventDate' is not null
              or attrs->'observation'->'temporalRefs' is not null)
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit 1000
        `
      : await sql<Array<RecallResult & { eventDate: string | null; temporalRefs: unknown }>>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            attrs->'observation'->>'eventDate' as "eventDate",
            attrs->'observation'->'temporalRefs' as "temporalRefs"
          from memories
          where (attrs->'observation'->>'eventDate' is not null
              or attrs->'observation'->'temporalRefs' is not null)
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit 1000
        `
    : scope
      ? await sql<Array<RecallResult & { eventDate: string | null; temporalRefs: unknown }>>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            attrs->'observation'->>'eventDate' as "eventDate",
            attrs->'observation'->'temporalRefs' as "temporalRefs"
          from memories
          where status = 'active'
            and scope = ${scope}
            and (attrs->'observation'->>'eventDate' is not null
              or attrs->'observation'->'temporalRefs' is not null)
          order by created_at desc
          limit 1000
        `
      : await sql<Array<RecallResult & { eventDate: string | null; temporalRefs: unknown }>>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            attrs->'observation'->>'eventDate' as "eventDate",
            attrs->'observation'->'temporalRefs' as "temporalRefs"
          from memories
          where status = 'active'
            and (attrs->'observation'->>'eventDate' is not null
              or attrs->'observation'->'temporalRefs' is not null)
          order by created_at desc
          limit 1000
        `;

  const queryTokens = meaningfulTokens(query);
  const latest = /\b(?:latest|newest|recent|current|now)\b/i.test(query);
  const between = /\bbetween\b|\bhow many days\b|\bdays between\b/i.test(query);

  return rows
    .map((row) => {
      const lexical = tokenOverlapScore(queryTokens, meaningfulTokens(row.content));
      const dateScore = row.eventDate ? normalizedDateScore(row.eventDate) : 0.2;
      const temporalDensity = Array.isArray(row.temporalRefs) ? Math.min(row.temporalRefs.length, 5) / 10 : 0;
      const rank = between
        ? 0.55 + lexical * 0.35 + temporalDensity
        : latest
          ? 0.65 + dateScore * 0.3 + lexical * 0.2
          : 0.45 + lexical * 0.4 + dateScore * 0.15 + temporalDensity;

      return {
        id: row.id,
        type: row.type,
        scope: row.scope,
        content: row.content,
        rank,
        createdAt: row.createdAt,
      };
    })
    .filter((row) => row.rank > 0.45)
    .sort((a, b) => b.rank - a.rank || b.createdAt.localeCompare(a.createdAt))
    .slice(0, k);
}

export async function graphRecall(
  query: string,
  scope: string | undefined,
  k: number,
  asOf?: Date,
): Promise<RecallResult[]> {
  const sql = getSqlClient();

  const scopedPredicate = scope
    ? sql`and ent.scope = ${scope}`
    : sql``;
  const edgeScopePredicate = scope
    ? sql`and e.scope = ${scope}`
    : sql``;
  const edgeTimePredicate = asOf
    ? sql`and (e.t_valid is null or e.t_valid <= ${asOf})
           and (e.t_invalid is null or e.t_invalid > ${asOf})`
    : sql`and e.t_expired is null`;

  return sql<RecallResult[]>`
    with recursive matched_entities as (
      select ent.id, ent.scope
      from entities ent
      where lower(${query}) like '%' || lower(ent.name) || '%'
        ${scopedPredicate}
    ),
    walk(entity_id, edge_id, scope, fact, depth, path) as (
      select
        case when e.src = m.id then e.dst else e.src end,
        e.id,
        e.scope,
        e.fact,
        1,
        array[m.id, case when e.src = m.id then e.dst else e.src end]
      from edges e
      join matched_entities m on e.src = m.id or e.dst = m.id
      where e.fact is not null
        ${edgeScopePredicate}
        ${edgeTimePredicate}

      union all

      select
        case when e.src = w.entity_id then e.dst else e.src end,
        e.id,
        e.scope,
        e.fact,
        w.depth + 1,
        w.path || case when e.src = w.entity_id then e.dst else e.src end
      from edges e
      join walk w on e.src = w.entity_id or e.dst = w.entity_id
      where w.depth < 2
        and e.fact is not null
        and not (case when e.src = w.entity_id then e.dst else e.src end = any(w.path))
        ${edgeScopePredicate}
        ${edgeTimePredicate}
    )
    select distinct on (edge_id)
      edge_id::text as id,
      'graph_fact' as type,
      scope,
      fact as content,
      (1.0 / depth)::real as rank,
      now()::text as "createdAt"
    from walk
    order by edge_id, depth asc
    limit ${k}
  `;
}

function isTemporalQuery(query: string): boolean {
  return /\b(?:after|ago|before|between|current|date|days?|duration|latest|last|newest|recent|today|tomorrow|week|when|yesterday)\b/i
    .test(query);
}

function normalizedDateScore(value: string): number {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return 0;
  }

  return Math.max(0, Math.min(1, time / Date.now()));
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) {
    return 0;
  }

  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;

  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    aMagnitude += a[i] * a[i];
    bMagnitude += b[i] * b[i];
  }

  if (aMagnitude === 0 || bMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}

function tokenOverlapScore(queryTokens: string[], contentTokens: string[]): number {
  if (queryTokens.length === 0 || contentTokens.length === 0) {
    return 0;
  }

  const contentSet = new Set(contentTokens);
  const shared = new Set(queryTokens.filter((token) => contentSet.has(token)));
  return shared.size / queryTokens.length;
}

function meaningfulTokens(value: string): string[] {
  const stopwords = new Set([
    "a",
    "about",
    "after",
    "an",
    "and",
    "are",
    "as",
    "be",
    "by",
    "did",
    "do",
    "does",
    "for",
    "from",
    "had",
    "has",
    "have",
    "how",
    "i",
    "in",
    "is",
    "it",
    "my",
    "of",
    "on",
    "or",
    "the",
    "this",
    "to",
    "was",
    "were",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "with",
  ]);

  return [...new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9_.-]+/g)
      ?.filter((token) => token.length > 2 && !stopwords.has(token)) ?? [],
  )];
}
