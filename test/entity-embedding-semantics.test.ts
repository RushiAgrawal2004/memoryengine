import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { upsertEntity } from "../src/graph/entities.js";
import { setEmbeddingsForTest } from "../src/providers/embeddings.js";

describe("entity embedding semantics", () => {
  const scopes: string[] = [];

  afterEach(async () => {
    setEmbeddingsForTest(undefined);
    const sql = getSqlClient();
    for (const scope of scopes.splice(0)) {
      await sql`delete from entities where scope = ${scope}`;
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("does not merge near-duplicate entities with a non-semantic embeddings provider", async () => {
    const scope = testScope();
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
    setEmbeddingsForTest({ semantic: false, embed });

    const first = await upsertEntity(scope, "symbol", "verifyToken");
    const second = await upsertEntity(scope, "symbol", "verify-token");

    expect(first.id).not.toBe(second.id);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("still merges near-duplicates with a semantic embeddings provider", async () => {
    const scope = testScope();
    setEmbeddingsForTest({
      semantic: true,
      embed: async (texts) => texts.map(() => [1, 0, 0]),
    });

    const first = await upsertEntity(scope, "symbol", "verifyToken");
    const second = await upsertEntity(scope, "symbol", "verify-token");

    expect(first.id).toBe(second.id);
  });

  function testScope(): string {
    const scope = `test:entity:${crypto.randomUUID()}`;
    scopes.push(scope);
    return scope;
  }
});
