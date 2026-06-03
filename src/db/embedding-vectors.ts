import { getSqlClient } from "./client.js";

export type EmbeddingTable = "memories" | "entities" | "edges";

let supportCache: Partial<Record<EmbeddingTable, boolean>> = {};

export async function hasEmbeddingVectorColumn(table: EmbeddingTable): Promise<boolean> {
  if (supportCache[table] !== undefined) {
    return supportCache[table];
  }

  const sql = getSqlClient();
  const [row] = await sql<Array<{ supported: boolean }>>`
    select (
      exists(select 1 from pg_extension where extname = 'vector')
      and exists(
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = ${table}
          and column_name = 'embedding_vector'
      )
    ) as supported
  `;

  supportCache[table] = row.supported;
  return row.supported;
}

export async function syncMemoryVector(id: string, embedding: number[]): Promise<void> {
  if (!(await hasEmbeddingVectorColumn("memories"))) {
    return;
  }

  const sql = getSqlClient();
  await sql`
    update memories
    set embedding_vector = ${vectorLiteral(embedding)}::vector
    where id = ${id}
  `;
}

export async function syncEntityVector(id: string, embedding: number[]): Promise<void> {
  if (!(await hasEmbeddingVectorColumn("entities"))) {
    return;
  }

  const sql = getSqlClient();
  await sql`
    update entities
    set embedding_vector = ${vectorLiteral(embedding)}::vector
    where id = ${id}
  `;
}

export async function syncEdgeVector(id: string, embedding: number[]): Promise<void> {
  if (!(await hasEmbeddingVectorColumn("edges"))) {
    return;
  }

  const sql = getSqlClient();
  await sql`
    update edges
    set embedding_vector = ${vectorLiteral(embedding)}::vector
    where id = ${id}
  `;
}

export function vectorLiteral(embedding: number[]): string {
  return `[${embedding.map((value) => finiteNumber(value).toString()).join(",")}]`;
}

export function resetEmbeddingVectorSupportCacheForTest(): void {
  supportCache = {};
}

function finiteNumber(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return value;
}
