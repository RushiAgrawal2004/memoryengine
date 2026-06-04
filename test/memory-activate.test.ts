import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { saveMemory } from "../src/db/memories.js";
import { createApp } from "../src/index.js";
import { activateMemory } from "../src/memory/activate.js";
import { remember } from "../src/write/remember.js";

describe("memory activation", () => {
  const scopes: string[] = [];

  afterEach(async () => {
    const sql = getSqlClient();
    for (const scope of scopes.splice(0)) {
      await sql`delete from memories where scope = ${scope}`;
      await sql`delete from episodes where scope = ${scope}`;
      await sql`delete from chat_sessions where scope = ${scope}`;
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("starts a saved plugin-style chat session", async () => {
    const scope = testScope();

    const result = await activateMemory({
      scope,
      task: "build a todo app",
      agent: "codex",
    });

    const [session] = await getSqlClient()<Array<{
      id: string;
      scope: string;
      task: string | null;
      agent: string | null;
      status: string;
    }>>`
      select id, scope, task, agent, status
      from chat_sessions
      where id = ${result.session.id}
    `;

    expect(result.session.id).toBeTruthy();
    expect(session?.scope).toBe(scope);
    expect(session?.task).toBe("build a todo app");
    expect(session?.agent).toBe("codex");
    expect(session?.status).toBe("active");
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
    expect(result.session.scope).toBe(scope);
    expect(result.memories.map((memory) => memory.content)).toContain(
      "The todo app must persist tasks in localStorage.",
    );
    expect(result.instructions.join(" ")).toContain("memory.remember");
  });

  it("resolves a generic project scope to a concrete project scope", async () => {
    const result = await activateMemory({
      scope: "project",
      task: "build a todo app",
      agent: "codex",
    });
    scopes.push(result.scope);

    expect(result.scope).toMatch(/^project:/);
    expect(result.scope).not.toBe("project");
    expect(result.session.scope).toBe(result.scope);
  });

  it("attaches remembered episodes and memories to the active session", async () => {
    const scope = testScope();
    const activated = await activateMemory({
      scope,
      task: "remember session facts",
      agent: "codex",
    });

    await remember({
      scope,
      sessionId: activated.session.id,
      text: "This session decided the todo app persists tasks in localStorage.",
    });

    const [row] = await getSqlClient()<Array<{
      episodeCount: number;
      memoryCount: number;
    }>>`
      select
        (select count(*)::int from episodes where session_id = ${activated.session.id}) as "episodeCount",
        (select count(*)::int from memories where source_session = ${activated.session.id}) as "memoryCount"
    `;

    expect(row?.episodeCount).toBeGreaterThan(0);
    expect(row?.memoryCount).toBeGreaterThan(0);
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
        agent: "codex",
      }),
    });
    const payload = (await response.json()) as Awaited<ReturnType<typeof activateMemory>>;

    expect(response.status).toBe(200);
    expect(payload.activated).toBe(true);
    expect(payload.session.agent).toBe("codex");
    expect(payload.memories.length).toBeGreaterThan(0);
  });

  function testScope(): string {
    const scope = `test:${crypto.randomUUID()}`;
    scopes.push(scope);
    return scope;
  }
});
