import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { createApp } from "../src/index.js";

describe("POST /remember", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("captures an episode and ingests memory facts", async () => {
    const app = createApp();
    const scope = `test:${crypto.randomUUID()}`;
    const activated = await app.request("/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope,
        task: "test scoped remember",
        agent: "codex",
      }),
    });
    const activation = (await activated.json()) as { session: { id: string } };

    const response = await app.request("/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "hooks capture tool output",
        scope,
        sessionId: activation.session.id,
      }),
    });

    const payload = (await response.json()) as {
      episodeId: string;
      sessionId: string;
      facts: string[];
    };
    const sql = getSqlClient();
    const [episodeCount] = await sql<Array<{ count: number }>>`
      select count(*)::int as count from episodes where scope = ${scope}
    `;
    const [memoryCount] = await sql<Array<{ count: number }>>`
      select count(*)::int as count from memories where scope = ${scope}
    `;

    expect(response.status).toBe(200);
    expect(payload.episodeId).toBeTruthy();
    expect(payload.sessionId).toBe(activation.session.id);
    expect(payload.facts).toContain("hooks capture tool output");
    expect(episodeCount.count).toBe(1);
    expect(memoryCount.count).toBeGreaterThan(0);

    await sql`delete from memories where scope = ${scope}`;
    await sql`delete from episodes where scope = ${scope}`;
    await sql`delete from chat_sessions where scope = ${scope}`;
  });

  it("rejects remember calls before a chat session is activated", async () => {
    const app = createApp();
    const scope = `test:${crypto.randomUUID()}`;

    const response = await app.request("/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "this should not be stored without activation",
        scope,
      }),
    });
    const payload = (await response.json()) as { code: string };
    const [episodeCount] = await getSqlClient()<Array<{ count: number }>>`
      select count(*)::int as count from episodes where scope = ${scope}
    `;

    expect(response.status).toBe(400);
    expect(payload.code).toBe("MEMORY_SESSION_REQUIRED");
    expect(episodeCount.count).toBe(0);
  });
});
