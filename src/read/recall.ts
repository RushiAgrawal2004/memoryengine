import { getSqlClient } from "../db/client.js";
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
): Promise<RecallResult[]> {
  const [queryEmbedding] = await getEmbeddings().embed([query]);
  const sql = getSqlClient();

  const rows = scope
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

export async function ftsRecall(
  query: string,
  scope: string | undefined,
  k: number,
): Promise<RecallResult[]> {
  const sql = getSqlClient();

  return scope
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
