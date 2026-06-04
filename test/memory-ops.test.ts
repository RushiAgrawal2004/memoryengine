import * as z from "zod/v4";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { saveMemory } from "../src/db/memories.js";
import { config } from "../src/lib/config.js";
import { LLM, setLLMForTest } from "../src/providers/llm.js";
import { ingestFacts } from "../src/write/memory-ops.js";

class FakeOpsLLM implements LLM {
  calls = 0;
  lastBatch: Array<{
    factIndex: number;
    fact: string;
    candidates: Array<{ id: string; content?: string }>;
  }> = [];

  async json<T>(_system: string, user: string, schema: z.ZodType<T>): Promise<T> {
    this.calls += 1;
    const batchJson = user.match(/Facts with candidates:\n(?<json>.*)\nReturn JSON array/s)?.groups?.json;
    if (batchJson) {
      const batch = JSON.parse(batchJson) as Array<{
        factIndex: number;
        fact: string;
        candidates: Array<{ id: string }>;
      }>;
      this.lastBatch = batch;

      return schema.parse(batch.map((item) => ({
        factIndex: item.factIndex,
        ...this.decisionFor(item.fact, item.candidates),
      })));
    }

    const fact = user.match(/Fact: (?<fact>.*)/)?.groups?.fact ?? "";
    const existingJson = user.match(/Existing memories:\n(?<json>.*)\nReturn/s)?.groups?.json ?? "[]";
    const existing = JSON.parse(existingJson) as Array<{ id: string }>;

    return schema.parse(this.decisionFor(fact, existing));
  }

  async chat(_system: string, user: string): Promise<string> {
    return user;
  }

  private decisionFor(fact: string, existing: Array<{ id: string }>): Record<string, unknown> {
    const [prefix, ...rest] = fact.split(":");
    const op = prefix.trim();
    const content = rest.join(":").trim();

    return {
      op,
      content,
      targetId: op === "ADD" ? undefined : existing[0]?.id,
    };
  }
}

class ThrowingLLM implements LLM {
  async json<T>(): Promise<T> {
    throw new Error("LLM should not be called");
  }

  async chat(): Promise<string> {
    throw new Error("LLM should not be called");
  }
}

describe("ingestFacts", () => {
  const scopes: string[] = [];
  const originalEmbeddingsLocal = process.env.EMBEDDINGS_LOCAL;
  const originalMaxOpsPerRemember = config.maxOpsPerRemember;

  beforeEach(() => {
    process.env.EMBEDDINGS_LOCAL = "1";
    setLLMForTest(new FakeOpsLLM());
    config.maxOpsPerRemember = originalMaxOpsPerRemember;
  });

  afterEach(async () => {
    if (originalEmbeddingsLocal === undefined) {
      delete process.env.EMBEDDINGS_LOCAL;
    } else {
      process.env.EMBEDDINGS_LOCAL = originalEmbeddingsLocal;
    }
    setLLMForTest(undefined);
    config.maxOpsPerRemember = originalMaxOpsPerRemember;
    vi.restoreAllMocks();
    const sql = getSqlClient();
    for (const scope of scopes.splice(0)) {
      await sql`delete from traces where scope = ${scope}`;
      await sql`delete from memories where scope = ${scope}`;
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("applies ADD", async () => {
    const scope = testScope();

    const operations = await ingestFacts([{ fact: "ADD: we use vitest", temporalRefs: [] }], {
      scope,
    });

    const rows = await memoriesForScope(scope);
    expect(operations[0]?.op).toBe("ADD");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("we use vitest");
    expect(rows[0]?.status).toBe("active");
  });

  it("applies UPDATE", async () => {
    const scope = testScope();
    await saveMemory({ scope, content: "auth uses token checks" });

    await ingestFacts(
      [{ fact: "UPDATE: auth uses token checks in auth.ts", temporalRefs: [] }],
      { scope },
    );

    const rows = await memoriesForScope(scope);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("auth uses token checks in auth.ts");
    expect(rows[0]?.confidence).toBeGreaterThan(0.5);
    expect(rows[0]?.lastUsedAt).not.toBeNull();
  });

  it("applies INVALIDATE and supersedes the old memory", async () => {
    const scope = testScope();
    const saved = await saveMemory({ scope, content: "we use npm" });

    await ingestFacts([{ fact: "INVALIDATE: we switched to pnpm", temporalRefs: [] }], {
      scope,
    });

    const rows = await memoriesForScope(scope);
    const oldMemory = rows.find((row) => row.id === saved.id);
    const newMemory = rows.find((row) => row.supersedes === saved.id);

    expect(oldMemory?.status).toBe("invalid");
    expect(oldMemory?.tInvalid).not.toBeNull();
    expect(oldMemory?.tExpired).not.toBeNull();
    expect(newMemory?.content).toBe("we switched to pnpm");
    expect(newMemory?.status).toBe("active");
  });

  it("applies NOOP", async () => {
    const scope = testScope();
    await saveMemory({ scope, content: "we use npm" });

    const operations = await ingestFacts([{ fact: "NOOP: we use npm", temporalRefs: [] }], {
      scope,
    });

    const rows = await memoriesForScope(scope);
    expect(operations[0]?.op).toBe("NOOP");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("we use npm");
    expect(rows[0]?.status).toBe("active");
  });

  it("short-circuits exact duplicate facts without calling the LLM and bumps confidence", async () => {
    const scope = testScope();
    await saveMemory({ scope, content: "we use npm" });
    setLLMForTest(new ThrowingLLM());

    const operations = await ingestFacts([{ fact: "we use npm", temporalRefs: [] }], {
      scope,
    });

    const rows = await memoriesForScope(scope);
    expect(operations[0]?.op).toBe("NOOP");
    expect(operations[0]?.targetId).toBe(rows[0]?.id);
    expect(operations[0]?.memoryId).toBe(rows[0]?.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confidence).toBeGreaterThan(0.5);
    expect(rows[0]?.lastUsedAt).not.toBeNull();
  });

  it("batches remaining LLM op decisions into one call", async () => {
    const scope = testScope();
    const llm = new FakeOpsLLM();
    setLLMForTest(llm);

    const operations = await ingestFacts(
      [
        { fact: "ADD: first batched fact", temporalRefs: [] },
        { fact: "ADD: second batched fact", temporalRefs: [] },
        { fact: "ADD: third batched fact", temporalRefs: [] },
      ],
      { scope },
    );

    const rows = await memoriesForScope(scope);
    expect(llm.calls).toBe(1);
    expect(operations.map((operation) => operation.content)).toEqual([
      "first batched fact",
      "second batched fact",
      "third batched fact",
    ]);
    expect(rows).toHaveLength(3);
  });

  it("guards excessive operation counts and logs a warning", async () => {
    const scope = testScope();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    config.maxOpsPerRemember = 2;

    const operations = await ingestFacts(
      [
        { fact: "ADD: keep one", temporalRefs: [] },
        { fact: "ADD: keep two", temporalRefs: [] },
        { fact: "ADD: drop three", temporalRefs: [] },
      ],
      { scope },
    );

    const rows = await memoriesForScope(scope);
    expect(operations.map((operation) => operation.content)).toEqual(["keep one", "keep two"]);
    expect(rows.map((row) => row.content)).toEqual(["keep one", "keep two"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("MAX_OPS_PER_REMEMBER exceeded"));
    warn.mockRestore();
  });

  it("supplies lexical candidates for contradiction decisions when strict FTS misses them", async () => {
    const scope = testScope();
    const llm = new FakeOpsLLM();
    setLLMForTest(llm);
    await saveMemory({ scope, content: "The JavaScript package manager for this repository is npm." });

    const operations = await ingestFacts(
      [{ fact: "INVALIDATE: package manager moved to pnpm", temporalRefs: [] }],
      { scope },
    );

    expect(llm.lastBatch[0]?.candidates.some((candidate) =>
      candidate.content?.includes("npm")
    )).toBe(true);
    expect(operations[0]?.op).toBe("INVALIDATE");
  });

  it("collapses repeated INVALIDATE decisions against the same memory", async () => {
    const scope = testScope();
    await saveMemory({ scope, content: "The package manager for this repository is npm." });

    const operations = await ingestFacts(
      [
        { fact: "INVALIDATE: we no longer use npm", temporalRefs: [] },
        { fact: "INVALIDATE: package manager moved to pnpm", temporalRefs: [] },
      ],
      { scope },
    );

    const rows = await memoriesForScope(scope);
    expect(operations.filter((operation) => operation.op === "INVALIDATE")).toHaveLength(1);
    expect(rows.filter((row) => row.supersedes).map((row) => row.content)).toEqual([
      "package manager moved to pnpm",
    ]);
  });

  function testScope(): string {
    const scope = `test:${crypto.randomUUID()}`;
    scopes.push(scope);
    return scope;
  }
});

interface MemoryRow {
  id: string;
  content: string;
  status: string;
  confidence: number;
  supersedes: string | null;
  tInvalid: string | null;
  tExpired: string | null;
  lastUsedAt: string | null;
}

async function memoriesForScope(scope: string): Promise<MemoryRow[]> {
  return getSqlClient()<MemoryRow[]>`
    select
      id,
      content,
      status,
      confidence,
      supersedes,
      t_invalid::text as "tInvalid",
      t_expired::text as "tExpired",
      last_used_at::text as "lastUsedAt"
    from memories
    where scope = ${scope}
    order by created_at asc
  `;
}
