import { getSqlClient } from "./client.js";
import { config } from "../lib/config.js";

export type EmbeddingTable = "memories" | "entities" | "edges";

let supportCache: Partial<Record<EmbeddingTable, boolean>> = {};

export interface PgvectorTableReport {
  table: EmbeddingTable;
  totalRows: number;
  jsonEmbeddings: number;
  vectorEmbeddings: number;
  missingVectors: number;
  vectorColumn: boolean;
  hnswIndex: boolean;
  vectorizedPercent: number;
}

export interface PgvectorDoctorReport {
  extensionInstalled: boolean;
  localFallbackEnabled: boolean;
  tables: PgvectorTableReport[];
  memoryQueryPlan: string[];
  memoryQueryPlanUsesIndex: boolean;
}

const hnswIndexes: Record<EmbeddingTable, string> = {
  memories: "memories_embedding_vector_hnsw_idx",
  entities: "entities_embedding_vector_hnsw_idx",
  edges: "edges_embedding_vector_hnsw_idx",
};

export function localEmbeddingFallbackEnabled(): boolean {
  return config.embeddingsLocal || process.env.EMBEDDINGS_LOCAL === "1";
}

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

export async function getPgvectorDoctorReport(): Promise<PgvectorDoctorReport> {
  const extensionInstalled = await hasPgvectorExtension();
  const tables = await Promise.all(
    (["memories", "entities", "edges"] as const).map((table) =>
      getPgvectorTableReport(table),
    ),
  );
  const memoryQueryPlan = await explainMemoryVectorRecall();

  return {
    extensionInstalled,
    localFallbackEnabled: localEmbeddingFallbackEnabled(),
    tables,
    memoryQueryPlan,
    memoryQueryPlanUsesIndex: memoryQueryPlan.some((line) =>
      line.includes(hnswIndexes.memories) || /Index Scan|Index Only Scan/i.test(line),
    ),
  };
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

async function hasPgvectorExtension(): Promise<boolean> {
  const sql = getSqlClient();
  const [row] = await sql<Array<{ installed: boolean }>>`
    select exists(select 1 from pg_extension where extname = 'vector') as installed
  `;
  return row.installed;
}

async function hasHnswIndex(table: EmbeddingTable): Promise<boolean> {
  const sql = getSqlClient();
  const [row] = await sql<Array<{ exists: boolean }>>`
    select exists(
      select 1
      from pg_indexes
      where schemaname = 'public'
        and indexname = ${hnswIndexes[table]}
    ) as "exists"
  `;
  return row.exists;
}

async function getPgvectorTableReport(table: EmbeddingTable): Promise<PgvectorTableReport> {
  const vectorColumn = await hasEmbeddingVectorColumn(table);
  const hnswIndex = await hasHnswIndex(table);
  const counts = vectorColumn
    ? await countsWithVectorColumn(table)
    : await countsWithoutVectorColumn(table);
  const missingVectors = Math.max(counts.totalRows - counts.vectorEmbeddings, 0);

  return {
    table,
    ...counts,
    missingVectors,
    vectorColumn,
    hnswIndex,
    vectorizedPercent: counts.totalRows === 0
      ? 100
      : Math.round((counts.vectorEmbeddings / counts.totalRows) * 10000) / 100,
  };
}

async function countsWithVectorColumn(
  table: EmbeddingTable,
): Promise<{ totalRows: number; jsonEmbeddings: number; vectorEmbeddings: number }> {
  const sql = getSqlClient();

  if (table === "memories") {
    const [row] = await sql<Array<{ totalRows: number; jsonEmbeddings: number; vectorEmbeddings: number }>>`
      select
        count(*)::int as "totalRows",
        count(embedding)::int as "jsonEmbeddings",
        count(embedding_vector)::int as "vectorEmbeddings"
      from memories
    `;
    return row;
  }

  if (table === "entities") {
    const [row] = await sql<Array<{ totalRows: number; jsonEmbeddings: number; vectorEmbeddings: number }>>`
      select
        count(*)::int as "totalRows",
        count(embedding)::int as "jsonEmbeddings",
        count(embedding_vector)::int as "vectorEmbeddings"
      from entities
    `;
    return row;
  }

  const [row] = await sql<Array<{ totalRows: number; jsonEmbeddings: number; vectorEmbeddings: number }>>`
    select
      count(*)::int as "totalRows",
      count(embedding)::int as "jsonEmbeddings",
      count(embedding_vector)::int as "vectorEmbeddings"
    from edges
  `;
  return row;
}

async function countsWithoutVectorColumn(
  table: EmbeddingTable,
): Promise<{ totalRows: number; jsonEmbeddings: number; vectorEmbeddings: number }> {
  const sql = getSqlClient();

  if (table === "memories") {
    const [row] = await sql<Array<{ totalRows: number; jsonEmbeddings: number }>>`
      select count(*)::int as "totalRows", count(embedding)::int as "jsonEmbeddings"
      from memories
    `;
    return { ...row, vectorEmbeddings: 0 };
  }

  if (table === "entities") {
    const [row] = await sql<Array<{ totalRows: number; jsonEmbeddings: number }>>`
      select count(*)::int as "totalRows", count(embedding)::int as "jsonEmbeddings"
      from entities
    `;
    return { ...row, vectorEmbeddings: 0 };
  }

  const [row] = await sql<Array<{ totalRows: number; jsonEmbeddings: number }>>`
    select count(*)::int as "totalRows", count(embedding)::int as "jsonEmbeddings"
    from edges
  `;
  return { ...row, vectorEmbeddings: 0 };
}

async function explainMemoryVectorRecall(): Promise<string[]> {
  if (!(await hasEmbeddingVectorColumn("memories"))) {
    return [];
  }

  const sql = getSqlClient();
  const [sample] = await sql<Array<{ vector: string }>>`
    select embedding_vector::text as vector
    from memories
    where embedding_vector is not null
    limit 1
  `;

  if (!sample) {
    return [];
  }

  return sql.begin(async (tx) => {
    await tx`set local enable_seqscan = off`;
    const plan = await tx<Array<{ "QUERY PLAN": string }>>`
      explain
      select id
      from memories
      where status = 'active'
        and embedding_vector is not null
      order by embedding_vector <=> ${sample.vector}::vector
      limit 5
    `;
    return plan.map((row) => row["QUERY PLAN"]);
  });
}

function finiteNumber(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return value;
}
