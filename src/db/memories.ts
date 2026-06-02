import { getSqlClient } from "./client.js";

export interface SaveMemoryInput {
  content: string;
  type?: string;
  scope?: string;
}

export interface SavedMemory {
  id: string;
}

export interface SearchMemoryInput {
  query: string;
  scope?: string;
  limit?: number;
}

export interface MemorySearchResult {
  id: string;
  type: string;
  scope: string;
  content: string;
  rank: number;
  createdAt: string;
}

const DEFAULT_TYPE = "semantic";
const DEFAULT_SCOPE = "global";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

export async function saveMemory(input: SaveMemoryInput): Promise<SavedMemory> {
  const sql = getSqlClient();
  const type = input.type ?? DEFAULT_TYPE;
  const scope = input.scope ?? DEFAULT_SCOPE;

  const [row] = await sql<{ id: string }[]>`
    insert into memories (type, scope, content)
    values (${type}, ${scope}, ${input.content})
    returning id
  `;

  return row;
}

export async function searchMemories(
  input: SearchMemoryInput,
): Promise<MemorySearchResult[]> {
  const query = input.query.trim();
  if (!query) {
    return [];
  }

  const sql = getSqlClient();
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const rows = input.scope
    ? await sql<MemorySearchResult[]>`
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
          and scope = ${input.scope}
          and fts @@ websearch_to_tsquery('english', ${query})
        order by rank desc, created_at desc
        limit ${limit}
      `
    : await sql<MemorySearchResult[]>`
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
        limit ${limit}
      `;

  return rows;
}
