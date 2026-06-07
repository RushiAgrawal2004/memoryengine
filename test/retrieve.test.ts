import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { saveMemory, searchMemories } from "../src/db/memories.js";
import { retrieve } from "../src/read/retrieve.js";

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
      await sql`delete from traces where scope = ${scope}`;
      await sql`delete from memories where scope = ${scope}`;
    }
  }, 30000);

  it("uses keyword recall for natural questions in local mode", async () => {
    process.env.EMBEDDINGS_LOCAL = "1";
    const sql = getSqlClient();
    const scope = `test:${crypto.randomUUID()}`;

    try {
      await saveMemory({
        scope,
        content: "session alpha: user said The first issue after the new car service was the GPS system failing.",
      });
      await saveMemory({
        scope,
        content: "session beta: user said The detailer recommendation should be checked through reviews.",
      });

      const results = await retrieve({
        scope,
        query: "What was the first issue with my new car after service?",
        topN: 1,
      });

      expect(results[0]?.content).toContain("GPS system");
    } finally {
      await sql`delete from traces where scope = ${scope}`;
      await sql`delete from memories where scope = ${scope}`;
    }
  }, 30000);

  it("diversifies final results across source sessions", async () => {
    process.env.EMBEDDINGS_LOCAL = "1";
    const sql = getSqlClient();
    const scope = `test:${crypto.randomUUID()}`;

    try {
      await saveMemory({
        scope,
        content: "session alpha: user said project auth tokens depend on jose for edge runtime",
      });
      await saveMemory({
        scope,
        content: "session alpha: user said jose auth tokens are validated in middleware",
      });
      await saveMemory({
        scope,
        content: "session beta: user said auth middleware runs before dashboard routes",
      });

      const results = await retrieve({
        scope,
        query: "auth middleware tokens",
        topN: 2,
      });

      expect(results.map((result) => result.content).join("\n")).toContain("session alpha");
      expect(results.map((result) => result.content).join("\n")).toContain("session beta");
    } finally {
      await sql`delete from traces where scope = ${scope}`;
      await sql`delete from memories where scope = ${scope}`;
    }
  }, 30000);
});
