import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { saveMemory } from "../src/db/memories.js";
import { createApp } from "../src/index.js";

describe("viewer routes", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("serves the viewer page and tab data", async () => {
    const app = createApp();
    const scope = `test-viewer:${crypto.randomUUID()}`;
    const activated = await app.request("/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope,
        task: "viewer data",
        agent: "codex",
      }),
    });
    const activation = (await activated.json()) as { session: { id: string } };

    await app.request("/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "viewer.ts calls renderViewer. renderViewer depends on hono.",
        scope,
        sessionId: activation.session.id,
      }),
    });

    const page = await app.request("/viewer");
    const overview = await app.request(
      `/viewer/data/overview?scope=${encodeURIComponent(scope)}`,
    );
    const graph = await app.request(
      `/viewer/data/graph?scope=${encodeURIComponent(scope)}`,
    );
    const activity = await app.request(
      `/viewer/data/activity?scope=${encodeURIComponent(scope)}&q=viewer`,
    );
    const profile = await app.request(
      `/viewer/data/profile?scope=${encodeURIComponent(scope)}`,
    );
    const audit = await app.request(
      `/viewer/data/audit?scope=${encodeURIComponent(scope)}`,
    );
    const traces = await app.request(
      `/viewer/data/traces?scope=${encodeURIComponent(scope)}`,
    );
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

    const html = await page.text();
    expect(html).toContain("Memory Engine Dashboard");
    expect(html).toContain("Overview");
    expect(html).toContain("Timeline");
    expect(html).toContain("Profile");
    expect(html).toContain("Traces");
    expect(overview.status).toBe(200);
    expect(graph.status).toBe(200);
    await expectRows(activity);
    await expectRows(profile);
    expect(audit.status).toBe(200);
    expect(traces.status).toBe(200);
    await expectRows(memories);
    await expectRows(entities);
    await expectRows(edges);
    expect(sessions.status).toBe(200);
    await expectRows(episodes);

    const sql = getSqlClient();
    await sql`delete from traces where scope = ${scope}`;
    await sql`delete from edges where scope = ${scope}`;
    await sql`delete from entities where scope = ${scope}`;
    await sql`delete from memories where scope = ${scope}`;
    await sql`delete from episodes where scope = ${scope}`;
    await sql`delete from chat_sessions where scope = ${scope}`;
  }, 10000);

  it("hides test and demo scopes by default but allows explicit inspection", async () => {
    const app = createApp();
    const scope = `test-viewer:${crypto.randomUUID()}`;
    const content = `hidden viewer fixture ${crypto.randomUUID()}`;
    await saveMemory({ scope, content });

    const hidden = await app.request(
      `/viewer/data/memories?q=${encodeURIComponent(content)}`,
    );
    const included = await app.request(
      `/viewer/data/memories?includeInternal=1&q=${encodeURIComponent(content)}`,
    );
    const scoped = await app.request(
      `/viewer/data/memories?scope=${encodeURIComponent(scope)}&q=${encodeURIComponent(content)}`,
    );

    await expectRowCount(hidden, 0);
    await expectRowCount(included, 1);
    await expectRowCount(scoped, 1);

    await getSqlClient()`delete from memories where scope = ${scope}`;
  });
});

async function expectRows(response: Response): Promise<void> {
  const payload = (await response.json()) as { rows: unknown[] };

  expect(response.status).toBe(200);
  expect(payload.rows.length).toBeGreaterThan(0);
}

async function expectRowCount(response: Response, count: number): Promise<void> {
  const payload = (await response.json()) as { rows: unknown[] };

  expect(response.status).toBe(200);
  expect(payload.rows.length).toBe(count);
}
