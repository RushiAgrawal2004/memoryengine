import { getSqlClient, closeDb } from "../db/client.js";
import {
  hasEmbeddingVectorColumn,
  localEmbeddingFallbackEnabled,
  syncEdgeVector,
  syncEntityVector,
  syncMemoryVector,
} from "../db/embedding-vectors.js";
import { getEmbeddings } from "../providers/embeddings.js";

const BATCH_SIZE = 100;

type BackfillTable = "memories" | "entities" | "edges";

interface BackfillRow {
  id: string;
  text: string;
}

interface BackfillResult {
  table: BackfillTable;
  updated: number;
}

async function backfillEmbeddings(): Promise<BackfillResult[]> {
  const results: BackfillResult[] = [];

  results.push(await backfillTable("memories"));
  results.push(await backfillTable("entities"));
  results.push(await backfillTable("edges"));

  return results;
}

async function backfillTable(table: BackfillTable): Promise<BackfillResult> {
  const sql = getSqlClient();
  const embeddings = getEmbeddings();
  const vectorColumn = await hasEmbeddingVectorColumn(table);

  if (!vectorColumn && !localEmbeddingFallbackEnabled()) {
    throw new Error(
      `pgvector column is missing for ${table}. Run migrations against a pgvector-enabled database or set EMBEDDINGS_LOCAL=1 for dev-only JSON backfill.`,
    );
  }

  let updated = 0;

  while (true) {
    const rows = await rowsNeedingBackfill(table, vectorColumn);

    if (rows.length === 0) {
      return { table, updated };
    }

    const vectors = await embeddings.embed(rows.map((row) => row.text));

    for (let i = 0; i < rows.length; i += 1) {
      if (table === "memories") {
        await sql`
          update memories
          set embedding = ${sql.json(vectors[i])}
          where id = ${rows[i].id}
        `;
        await syncMemoryVector(rows[i].id, vectors[i]);
      } else if (table === "entities") {
        await sql`
          update entities
          set embedding = ${sql.json(vectors[i])}
          where id = ${rows[i].id}
        `;
        await syncEntityVector(rows[i].id, vectors[i]);
      } else {
        await sql`
          update edges
          set embedding = ${sql.json(vectors[i])}
          where id = ${rows[i].id}
        `;
        await syncEdgeVector(rows[i].id, vectors[i]);
      }

      updated += 1;
    }
  }
}

async function rowsNeedingBackfill(
  table: BackfillTable,
  vectorColumn: boolean,
): Promise<BackfillRow[]> {
  if (table === "memories") {
    return vectorColumn
      ? getSqlClient()<BackfillRow[]>`
          select id, content as text
          from memories
          where embedding is null or embedding_vector is null
          order by created_at asc
          limit ${BATCH_SIZE}
        `
      : getSqlClient()<BackfillRow[]>`
          select id, content as text
          from memories
          where embedding is null
          order by created_at asc
          limit ${BATCH_SIZE}
        `;
  }

  if (table === "entities") {
    return vectorColumn
      ? getSqlClient()<BackfillRow[]>`
          select id, name as text
          from entities
          where embedding is null or embedding_vector is null
          order by created_at asc
          limit ${BATCH_SIZE}
        `
      : getSqlClient()<BackfillRow[]>`
          select id, name as text
          from entities
          where embedding is null
          order by created_at asc
          limit ${BATCH_SIZE}
        `;
  }

  return vectorColumn
    ? getSqlClient()<BackfillRow[]>`
        select id, fact as text
        from edges
        where fact is not null
          and (embedding is null or embedding_vector is null)
        order by created_at asc
        limit ${BATCH_SIZE}
      `
    : getSqlClient()<BackfillRow[]>`
        select id, fact as text
        from edges
        where fact is not null
          and embedding is null
        order by created_at asc
        limit ${BATCH_SIZE}
      `;
}

backfillEmbeddings()
  .then((results) => {
    for (const result of results) {
      console.log(`Backfilled ${result.updated} ${result.table}`);
    }
  })
  .finally(async () => {
    await closeDb();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
