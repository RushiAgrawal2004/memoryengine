import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { searchMemories } from "../src/db/memories.js";
import { remember } from "../src/write/remember.js";

describe("graph recall", () => {
  const scopes: string[] = [];

  afterEach(async () => {
    const sql = getSqlClient();
    for (const scope of scopes.splice(0)) {
      await sql`delete from edges where scope = ${scope}`;
      await sql`delete from entities where scope = ${scope}`;
      await sql`delete from memories where scope = ${scope}`;
      await sql`delete from episodes where scope = ${scope}`;
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("uses two-hop graph recall to surface connected dependencies", async () => {
    const scope = testScope();

    await remember({ scope, text: "auth.ts calls verifyToken" });
    await remember({ scope, text: "verifyToken depends on jwtlib" });

    const results = await searchMemories({
      scope,
      query: "auth.ts",
      limit: 5,
    });

    expect(results.map((result) => result.content)).toContain(
      "verifyToken depends on jwtlib",
    );
  });

  it("uses asOf to return an edge that was valid before invalidation", async () => {
    const scope = testScope();

    await remember({ scope, text: "auth.ts calls verifyToken" });
    const asOf = new Date();
    await remember({ scope, text: "auth.ts no longer calls verifyToken" });

    const historical = await searchMemories({
      scope,
      query: "auth.ts",
      limit: 5,
      asOf,
    });

    expect(historical.map((result) => result.content)).toContain(
      "auth.ts calls verifyToken",
    );
  });

  function testScope(): string {
    const scope = `test:${crypto.randomUUID()}`;
    scopes.push(scope);
    return scope;
  }
});
