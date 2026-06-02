import { getSqlClient } from "./client.js";
import { getEmbeddings } from "../providers/embeddings.js";
import { retrieve } from "../read/retrieve.js";

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
  const [embedding] = await getEmbeddings().embed([input.content]);

  const [row] = await sql<{ id: string }[]>`
    insert into memories (type, scope, content, embedding)
    values (${type}, ${scope}, ${input.content}, ${sql.json(embedding)})
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

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  return retrieve(query, input.scope, limit);
}
