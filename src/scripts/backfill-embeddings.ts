import { getSqlClient, closeDb } from "../db/client.js";
import { getEmbeddings } from "../providers/embeddings.js";

const BATCH_SIZE = 100;

interface MemoryWithoutEmbedding {
  id: string;
  content: string;
}

async function backfillEmbeddings(): Promise<number> {
  const sql = getSqlClient();
  const embeddings = getEmbeddings();
  let updated = 0;

  while (true) {
    const rows = await sql<MemoryWithoutEmbedding[]>`
      select id, content
      from memories
      where embedding is null and status = 'active'
      order by created_at asc
      limit ${BATCH_SIZE}
    `;

    if (rows.length === 0) {
      return updated;
    }

    const vectors = await embeddings.embed(rows.map((row) => row.content));

    for (let i = 0; i < rows.length; i += 1) {
      await sql`
        update memories
        set embedding = ${sql.json(vectors[i])}
        where id = ${rows[i].id}
      `;
      updated += 1;
    }
  }
}

backfillEmbeddings()
  .then((count) => {
    console.log(`Backfilled ${count} memories`);
  })
  .finally(async () => {
    await closeDb();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
