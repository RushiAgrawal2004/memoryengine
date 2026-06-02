import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { createApp } from "../src/index.js";

describe("memory routes", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("saves memories and returns the relevant FTS result first", async () => {
    const app = createApp();
    const scope = `test:${crypto.randomUUID()}`;

    await app.request("/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "we use npm for package scripts",
        scope,
      }),
    });
    await app.request("/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "authentication checks happen in auth.ts",
        scope,
      }),
    });
    await app.request("/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "database migrations are handled by drizzle-kit",
        scope,
      }),
    });

    const response = await app.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "database migrations",
        scope,
      }),
    });

    const payload = (await response.json()) as {
      results: Array<{ content: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.results[0]?.content).toBe(
      "database migrations are handled by drizzle-kit",
    );

    await getSqlClient()`delete from memories where scope = ${scope}`;
  });
});
