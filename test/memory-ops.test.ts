import * as z from "zod/v4";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { saveMemory } from "../src/db/memories.js";
import { LLM, setLLMForTest } from "../src/providers/llm.js";
import { ingestFacts } from "../src/write/memory-ops.js";

class FakeOpsLLM implements LLM {
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
    });
  }

  async chat(_system: string, user: string): Promise<string> {
    return user;
  }
}

describe("ingestFacts", () => {
  const scopes: string[] = [];
  const originalEmbeddingsLocal = process.env.EMBEDDINGS_LOCAL;

  beforeEach(() => {
    process.env.EMBEDDINGS_LOCAL = "1";
    setLLMForTest(new FakeOpsLLM());
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
