import * as z from "zod/v4";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { saveMemory, searchMemories } from "../src/db/memories.js";
import { listTraces, saveTrace } from "../src/db/traces.js";
import { LLM, setLLMForTest } from "../src/providers/llm.js";
import { ingestFacts } from "../src/write/memory-ops.js";

class TraceOpsLLM implements LLM {
  async json<T>(_system: string, user: string, schema: z.ZodType<T>): Promise<T> {
    const fact = user.match(/Fact: (?<fact>.*)/)?.groups?.fact ?? "";
    const existingJson = user.match(/Existing memories:\n(?<json>.*)\nReturn/s)?.groups?.json ?? "[]";
    const existing = JSON.parse(existingJson) as Array<{ id: string }>;
    const [prefix, ...rest] = fact.split(":");
    const op = prefix.trim();
    const content = rest.join(":").trim();

    return schema.parse({
      op,
      content,
      targetId: op === "ADD" ? undefined : existing[0]?.id,
      rationale: `test chose ${op}`,
    });
  }

  async chat(_system: string, user: string): Promise<string> {
    return user;
  }
}

describe("trace logger", () => {
  const scopes: string[] = [];
  const originalEmbeddingsLocal = process.env.EMBEDDINGS_LOCAL;

  beforeEach(() => {
    process.env.EMBEDDINGS_LOCAL = "1";
    setLLMForTest(new TraceOpsLLM());
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
      await sql`delete from traces where scope = ${scope}`;
      await sql`delete from memories where scope = ${scope}`;
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("keeps only the newest 200 traces", async () => {
    const scope = testScope();
    for (let i = 0; i < 205; i += 1) {
      await saveTrace({
        kind: "retrieve",
        scope,
        query: `q-${i}`,
        payload: { index: i },
      });
    }

    const [row] = await getSqlClient()<Array<{ count: number }>>`
      select count(*)::int as count from traces
    `;
    const scoped = await listTraces({ scope, limit: 100 });

    expect(row.count).toBeLessThanOrEqual(200);
    expect(scoped[0]?.query).toBe("q-204");
  });

  it("records structured retrieve and ingest traces", async () => {
    const scope = testScope();
    await saveMemory({ scope, content: "pnpm runs package scripts" });

    await searchMemories({ scope, query: "package manager", limit: 1 });
    await ingestFacts([{ fact: "UPDATE: pnpm runs package scripts in this repo", temporalRefs: [] }], {
      scope,
    });

    const traces = await listTraces({ scope, limit: 20 });
    const retrieveTrace = traces.find((trace) =>
      trace.kind === "retrieve" && trace.query === "package manager"
    );
    const ingestTrace = traces.find((trace) => trace.kind === "ingest");

    expect(retrieveTrace?.payload).toMatchObject({
      query: "package manager",
      sources: expect.any(Object),
      finalSelectedIds: expect.any(Array),
    });
    expect(retrieveTrace?.payload).toHaveProperty("postRrf");
    expect(retrieveTrace?.payload).toHaveProperty("postRerank");
    expect(ingestTrace?.payload).toMatchObject({
      fact: "UPDATE: pnpm runs package scripts in this repo",
      chosenOp: "UPDATE",
      rationale: "test chose UPDATE",
    });
  }, 30000);

  function testScope(): string {
    const scope = `test:traces:${crypto.randomUUID()}`;
    scopes.push(scope);
    return scope;
  }
});
