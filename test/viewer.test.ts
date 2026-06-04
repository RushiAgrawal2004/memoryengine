import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { createApp } from "../src/index.js";

describe("viewer routes", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("serves the viewer page and tab data", async () => {
    const app = createApp();
    const scope = `test-viewer:${crypto.randomUUID()}`;

    await app.request("/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "viewer.ts calls renderViewer. renderViewer depends on hono.",
        scope,
      }),
    });

    const page = await app.request("/viewer");
    const memories = await app.request(
      `/viewer/data/memories?scope=${encodeURIComponent(scope)}&q=viewer`,
    );
    const entities = await app.request(
      `/viewer/data/entities?scope=${encodeURIComponent(scope)}&q=viewer`,
    );
    const edges = await app.request(
      `/viewer/data/edges?scope=${encodeURIComponent(scope)}&q=depends`,
    );
    const sessions = await app.request(
      `/viewer/data/sessions?scope=${encodeURIComponent(scope)}`,
    );
    const episodes = await app.request(
      `/viewer/data/episodes?scope=${encodeURIComponent(scope)}&q=viewer`,
    );

    expect(await page.text()).toContain("Memory Engine Viewer");
    await expectRows(memories);
    await expectRows(entities);
    await expectRows(edges);
    expect(sessions.status).toBe(200);
    await expectRows(episodes);

    const sql = getSqlClient();
    await sql`delete from edges where scope = ${scope}`;
    await sql`delete from entities where scope = ${scope}`;
    await sql`delete from memories where scope = ${scope}`;
    await sql`delete from episodes where scope = ${scope}`;
    await sql`delete from chat_sessions where scope = ${scope}`;
  }, 10000);
});

async function expectRows(response: Response): Promise<void> {
  const payload = (await response.json()) as { rows: unknown[] };

  expect(response.status).toBe(200);
  expect(payload.rows.length).toBeGreaterThan(0);
}
