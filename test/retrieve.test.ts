import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { saveMemory, searchMemories } from "../src/db/memories.js";

describe("hybrid retrieve", () => {
  const originalEmbeddingsLocal = process.env.EMBEDDINGS_LOCAL;

  afterEach(() => {
    if (originalEmbeddingsLocal === undefined) {
      delete process.env.EMBEDDINGS_LOCAL;
    } else {
      process.env.EMBEDDINGS_LOCAL = originalEmbeddingsLocal;
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns a semantically relevant memory for a paraphrased query", async () => {
    process.env.EMBEDDINGS_LOCAL = "1";
    const sql = getSqlClient();
    const scope = `test:${crypto.randomUUID()}`;

    try {
      for (let i = 0; i < 30; i += 1) {
        await saveMemory({
          scope,
          content: `background note ${i} about unrelated implementation details`,
        });
      }

      await saveMemory({
        scope,
        content: "npm handles scripts for this repository",
      });

      const results = await searchMemories({
        scope,
        query: "dependency manager",
        limit: 3,
      });

      expect(results.map((result) => result.content)).toContain(
        "npm handles scripts for this repository",
      );
    } finally {
      await sql`delete from memories where scope = ${scope}`;
    }
  }, 30000);
});
