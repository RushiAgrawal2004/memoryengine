import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { saveMemory } from "../src/db/memories.js";
import { createApp } from "../src/index.js";
import { activateMemory } from "../src/memory/activate.js";

describe("memory activation", () => {
  const scopes: string[] = [];

  afterEach(async () => {
    const sql = getSqlClient();
    for (const scope of scopes.splice(0)) {
      await sql`delete from memories where scope = ${scope}`;
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns project context and chat instructions", async () => {
    const scope = testScope();
    await saveMemory({
      scope,
      content: "The todo app must persist tasks in localStorage.",
    });

    const result = await activateMemory({
      scope,
      task: "build todo app persistence",
    });

    expect(result.activated).toBe(true);
    expect(result.scope).toBe(scope);
    expect(result.memories.map((memory) => memory.content)).toContain(
      "The todo app must persist tasks in localStorage.",
    );
    expect(result.instructions.join(" ")).toContain("memory.remember");
  });

  it("exposes activation over HTTP", async () => {
    const scope = testScope();
    await saveMemory({
      scope,
      content: "The dashboard should show memories, entities, edges, and episodes.",
    });

    const response = await createApp().request("/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope,
        task: "dashboard",
      }),
    });
    const payload = (await response.json()) as Awaited<ReturnType<typeof activateMemory>>;

    expect(response.status).toBe(200);
    expect(payload.activated).toBe(true);
    expect(payload.memories.length).toBeGreaterThan(0);
  });

  function testScope(): string {
    const scope = `test:${crypto.randomUUID()}`;
    scopes.push(scope);
    return scope;
  }
});
