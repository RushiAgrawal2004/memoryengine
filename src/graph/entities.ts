import { getSqlClient } from "../db/client.js";
import { getEmbeddings } from "../providers/embeddings.js";

export interface Entity {
  id: string;
  scope: string;
  kind: string;
  name: string;
}

interface EntityCandidate extends Entity {
  embedding: number[] | null;
}

const SIMILARITY_THRESHOLD = 0.94;

export async function upsertEntity(
  scope: string,
  kind: string,
  name: string,
  attrs: Record<string, unknown> = {},
): Promise<Entity> {
  const sql = getSqlClient();

  const [exact] = await sql<Entity[]>`
    select id, scope, kind, name
    from entities
    where scope = ${scope}
      and kind = ${kind}
      and lower(name) = lower(${name})
    limit 1
  `;

  if (exact) {
    return exact;
  }

  const [embedding] = await getEmbeddings().embed([name]);
  const candidates = await sql<EntityCandidate[]>`
    select id, scope, kind, name, embedding
    from entities
    where scope = ${scope}
      and kind = ${kind}
      and embedding is not null
  `;

  const similar = candidates
    .map((candidate) => ({
      candidate,
      score: cosineSimilarity(embedding, candidate.embedding ?? []),
    }))
    .sort((a, b) => b.score - a.score)[0];

  if (similar && similar.score >= SIMILARITY_THRESHOLD) {
    return similar.candidate;
  }

  const [created] = await sql<Entity[]>`
    insert into entities (scope, kind, name, embedding, attrs)
    values (${scope}, ${kind}, ${name}, ${sql.json(embedding)}, ${sql.json(attrs as never)})
    on conflict (scope, kind, name)
    do update set attrs = excluded.attrs
    returning id, scope, kind, name
  `;

  return created;
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
