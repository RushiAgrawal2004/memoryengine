import * as z from "zod/v4";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import {
  enqueueEpisodeProcessingJob,
  getProcessingJob,
} from "../src/db/jobs.js";
import { createApp } from "../src/index.js";
import { LLM, setLLMForTest } from "../src/providers/llm.js";
import { capture } from "../src/write/capture.js";
import { processNextJob } from "../src/write/worker.js";

class FailingLLM implements LLM {
  async json<T>(_system: string, _user: string, _schema: z.ZodType<T>): Promise<T> {
    throw new Error("forced extraction failure");
  }

  async chat(_system: string, user: string): Promise<string> {
    return user;
  }
}

describe("write queue", () => {
  const scopes: string[] = [];
  const originalEmbeddingsLocal = process.env.EMBEDDINGS_LOCAL;

  beforeEach(() => {
    process.env.EMBEDDINGS_LOCAL = "1";
  });

  afterEach(async () => {
    if (originalEmbeddingsLocal === undefined) {
      delete process.env.EMBEDDINGS_LOCAL;
    } else {
      process.env.EMBEDDINGS_LOCAL = originalEmbeddingsLocal;
    }
    setLLMForTest(undefined);
    const sql = getSqlClient();
    for (const scope of scopes.splice(0)) {
      await sql`delete from jobs where scope = ${scope}`;
      await sql`delete from traces where scope = ${scope}`;
      await sql`delete from edges where scope = ${scope}`;
      await sql`delete from entities where scope = ${scope}`;
      await sql`delete from memories where scope = ${scope}`;
      await sql`delete from episodes where scope = ${scope}`;
      await sql`delete from chat_sessions where scope = ${scope}`;
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("captures raw episodes, dedupes processing jobs, and retries failed jobs with backoff", async () => {
    const scope = testScope();
    const app = createApp();
    const activated = await app.request("/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope,
        task: "queue processing",
        agent: "codex",
      }),
    });
    const activation = (await activated.json()) as { session: { id: string } };

    const queued = await capture({
      text: "queue.ts calls processEpisode. processEpisode depends on ingestFacts.",
      scope,
      sessionId: activation.session.id,
      source: "hook",
    });
    const duplicate = await enqueueEpisodeProcessingJob({
      episodeId: queued.id,
      scope,
      payload: { duplicate: true },
    });
    const [queuedCounts] = await getSqlClient()<Array<{
      episodes: number;
      jobs: number;
      memories: number;
    }>>`
      select
        (select count(*)::int from episodes where scope = ${scope}) as episodes,
        (select count(*)::int from jobs where scope = ${scope}) as jobs,
        (select count(*)::int from memories where scope = ${scope}) as memories
    `;

    expect(duplicate.id).toBe(queued.jobId);
    expect(queuedCounts).toEqual({ episodes: 1, jobs: 1, memories: 0 });

    setLLMForTest(new FailingLLM());
    await processNextJob();

    const failed = await getProcessingJob(queued.jobId);
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(1);
    expect(failed?.lastError).toContain("forced extraction failure");
    expect(failed?.runAfter.getTime()).toBeGreaterThan(Date.now() - 100);

    await getSqlClient()`
      update jobs
      set run_after = now() - interval '1 second'
      where id = ${queued.jobId}
    `;
    setLLMForTest(undefined);
    await processNextJob();

    const done = await getProcessingJob(queued.jobId);
    const [processedCounts] = await getSqlClient()<Array<{
      memories: number;
      entities: number;
      edges: number;
    }>>`
      select
        (select count(*)::int from memories where scope = ${scope}) as memories,
        (select count(*)::int from entities where scope = ${scope}) as entities,
        (select count(*)::int from edges where scope = ${scope}) as edges
    `;

    expect(done?.status).toBe("done");
    expect(done?.attempts).toBe(2);
    expect(processedCounts.memories).toBeGreaterThan(0);
    expect(processedCounts.entities).toBeGreaterThan(0);
    expect(processedCounts.edges).toBeGreaterThan(0);
  }, 30000);

  function testScope(): string {
    const scope = `test:queue:${crypto.randomUUID()}`;
    scopes.push(scope);
    return scope;
  }
});
