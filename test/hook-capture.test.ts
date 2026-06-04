import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { createApp } from "../src/index.js";
import { processNextJob } from "../src/write/worker.js";

describe("POST /hook/capture", () => {
  const scopes: string[] = [];

  afterEach(async () => {
    const sql = getSqlClient();
    for (const scope of scopes.splice(0)) {
      await sql`delete from jobs where scope = ${scope}`;
      await sql`delete from memories where scope = ${scope}`;
      await sql`delete from episodes where scope = ${scope}`;
      await sql`delete from chat_sessions where scope = ${scope}`;
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("skips automatic capture when no chat session is active", async () => {
    const app = createApp();
    const scope = testScope();

    const response = await app.request("/hook/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope,
        text: "Codex post-tool-use output: changed script.js",
      }),
    });
    const payload = (await response.json()) as { captured: boolean; reason: string };
    const [row] = await getSqlClient()<Array<{ episodeCount: number }>>`
      select count(*)::int as "episodeCount" from episodes where scope = ${scope}
    `;

    expect(response.status).toBe(202);
    expect(payload.captured).toBe(false);
    expect(payload.reason).toBe("no_active_session");
    expect(row?.episodeCount).toBe(0);
  });

  it("captures hook events quickly and queues processing for the latest active project session", async () => {
    const app = createApp();
    const scope = testScope();
    const activated = await app.request("/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope,
        task: "build todo app",
        agent: "codex",
      }),
    });
    const activation = (await activated.json()) as { session: { id: string } };

    const response = await app.request("/hook/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope,
        text: "Codex post-tool-use\ncommand: wrote script.js\noutput: implemented localStorage persistence",
      }),
    });
    const payload = (await response.json()) as {
      captured: boolean;
      queued: boolean;
      sessionId: string;
      episodeId: string;
      jobId: string;
      jobStatus: string;
    };
    const [row] = await getSqlClient()<Array<{
      episodeCount: number;
      memoryCount: number;
      jobCount: number;
    }>>`
      select
        count(distinct episodes.id)::int as "episodeCount",
        count(distinct memories.id)::int as "memoryCount",
        count(distinct jobs.id)::int as "jobCount"
      from chat_sessions
      left join episodes on episodes.session_id = chat_sessions.id
      left join memories on memories.source_session = chat_sessions.id
      left join jobs on jobs.episode_id = episodes.id
      where chat_sessions.id = ${activation.session.id}
    `;

    expect(response.status).toBe(202);
    expect(payload.captured).toBe(true);
    expect(payload.queued).toBe(true);
    expect(payload.sessionId).toBe(activation.session.id);
    expect(payload.episodeId).toBeTruthy();
    expect(payload.jobId).toBeTruthy();
    expect(payload.jobStatus).toBe("pending");
    expect(row?.episodeCount).toBe(1);
    expect(row?.jobCount).toBe(1);
    expect(row?.memoryCount).toBe(0);

    await processNextJob();

    const [processed] = await getSqlClient()<Array<{
      status: string;
      memoryCount: number;
    }>>`
      select
        jobs.status,
        count(memories.id)::int as "memoryCount"
      from jobs
      left join memories on memories.source_episode = jobs.episode_id
      where jobs.id = ${payload.jobId}
      group by jobs.status
    `;
    expect(processed?.status).toBe("done");
    expect(processed?.memoryCount).toBeGreaterThan(0);
  });

  function testScope(): string {
    const scope = `test-hook:${crypto.randomUUID()}`;
    scopes.push(scope);
    return scope;
  }
});
