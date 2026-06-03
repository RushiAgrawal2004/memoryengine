import { getSqlClient } from "./client.js";
import { syncMemoryVector } from "./embedding-vectors.js";
import { getEmbeddings } from "../providers/embeddings.js";
import { currentRepoRef, projectScope } from "../grounding/git.js";
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
  asOf?: Date;
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
  const repoRef = await currentRepoRef();
  const scope = input.scope ?? (repoRef ? await projectScope() : DEFAULT_SCOPE);
  const [embedding] = await getEmbeddings().embed([input.content]);

  const [row] = await sql<{ id: string }[]>`
    insert into memories (type, scope, content, embedding, repo_ref)
    values (
      ${type},
      ${scope},
      ${input.content},
      ${sql.json(embedding)},
      ${repoRef ? sql.json(repoRef as never) : null}
    )
    returning id
  `;
  await syncMemoryVector(row.id, embedding);

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
  return retrieve({
    query,
    scope: input.scope,
    topN: limit,
    asOf: input.asOf,
  });
}
