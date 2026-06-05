import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { saveMemory, searchMemories } from "../src/db/memories.js";
import { memoryAudit } from "../src/grounding/staleness.js";
import { writeGraph } from "../src/graph/write.js";
import { createApp } from "../src/index.js";
import { graphRecall } from "../src/read/recall.js";
import { retrieve } from "../src/read/retrieve.js";

describe("scope isolation", () => {
  const scopes = ["project:alpha", "project:beta"];
  const originalEmbeddingsLocal = process.env.EMBEDDINGS_LOCAL;

  beforeEach(async () => {
    process.env.EMBEDDINGS_LOCAL = "1";
    await cleanupScopes();
  });

  afterEach(async () => {
    if (originalEmbeddingsLocal === undefined) {
      delete process.env.EMBEDDINGS_LOCAL;
    } else {
      process.env.EMBEDDINGS_LOCAL = originalEmbeddingsLocal;
    }
    await cleanupScopes();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("keeps search, retrieve, graph recall, audit, and viewer data scoped per project", async () => {
    await seedProject("project:alpha", {
      uniqueMemory: "alpha uses Redis for queue storage",
      file: "alpha.ts",
      dependency: "alphaLib",
      anchoredContent: "alpha.ts owns alpha-only auth",
    });
    await seedProject("project:beta", {
      uniqueMemory: "beta uses SQS for queue storage",
      file: "beta.ts",
      dependency: "betaLib",
      anchoredContent: "beta.ts owns beta-only auth",
    });

    await assertMemorySurface("project:alpha", "alpha", "beta");
    await assertMemorySurface("project:beta", "beta", "alpha");
    await assertGraphSurface("project:alpha", "alpha", "beta");
    await assertGraphSurface("project:beta", "beta", "alpha");
    await assertAuditSurface();
    await assertViewerSurface("project:alpha", "alpha", "beta");
    await assertViewerSurface("project:beta", "beta", "alpha");
  }, 30000);

  async function seedProject(
    scope: string,
    input: {
      uniqueMemory: string;
      file: string;
      dependency: string;
      anchoredContent: string;
    },
  ): Promise<void> {
    await saveMemory({ scope, content: "shared setup uses a shared retry policy" });
    await saveMemory({ scope, content: input.uniqueMemory });

    const sql = getSqlClient();
    await sql`
      insert into memories (type, scope, content, status, anchors, attrs)
      values (
        'semantic',
        ${scope},
        ${input.anchoredContent},
        'active',
        ${sql.json([{ path: input.file, commit: "old" }] as never)},
        ${sql.json({ needs_revalidation: true } as never)}
      )
    `;

    await writeGraph({
      scope,
      entities: [
        { kind: "file", name: input.file },
        { kind: "symbol", name: "sharedHandler" },
        { kind: "dependency", name: input.dependency },
      ],
      relations: [
        {
          srcName: input.file,
          srcKind: "file",
          relation: "calls",
          dstName: "sharedHandler",
          dstKind: "symbol",
          fact: `${input.file} calls sharedHandler`,
        },
        {
          srcName: "sharedHandler",
          srcKind: "symbol",
          relation: "depends_on",
          dstName: input.dependency,
          dstKind: "dependency",
          fact: `sharedHandler depends on ${input.dependency}`,
        },
      ],
    });
  }

  async function assertMemorySurface(
    scope: string,
    expected: "alpha" | "beta",
    forbidden: "alpha" | "beta",
  ): Promise<void> {
    const searchResults = await searchMemories({
      scope,
      query: "queue storage",
      limit: 10,
    });
    const retrieveResults = await retrieve({
      scope,
      query: "queue storage",
      topN: 10,
    });

    expect(searchResults.map((row) => row.scope).every((rowScope) => rowScope === scope)).toBe(true);
    expect(retrieveResults.map((row) => row.scope).every((rowScope) => rowScope === scope)).toBe(true);
    expect(searchResults.map((row) => row.content).join("\n")).toContain(expected);
    expect(searchResults.map((row) => row.content).join("\n")).not.toContain(forbidden);
    expect(retrieveResults.map((row) => row.content).join("\n")).toContain(expected);
    expect(retrieveResults.map((row) => row.content).join("\n")).not.toContain(forbidden);

    const shared = await searchMemories({
      scope: ` ${scope}\r\n`,
      query: "shared retry policy",
      limit: 10,
    });
    expect(shared).toHaveLength(1);
    expect(shared[0]?.scope).toBe(scope);
    expect(shared[0]?.content).toBe("shared setup uses a shared retry policy");
  }

  async function assertGraphSurface(
    scope: string,
    expected: "alpha" | "beta",
    forbidden: "alpha" | "beta",
  ): Promise<void> {
    const results = await graphRecall(`${expected}.ts`, scope, 10);
    const content = results.map((row) => row.content).join("\n");

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((row) => row.scope === scope)).toBe(true);
    expect(content).toContain(`${expected}.ts calls sharedHandler`);
    expect(content).toContain(`${expected}Lib`);
    expect(content).not.toContain(`${forbidden}.ts`);
    expect(content).not.toContain(`${forbidden}Lib`);
  }

  async function assertAuditSurface(): Promise<void> {
    const alphaAudit = await memoryAudit(" project:alpha\r\n");
    const betaAudit = await memoryAudit(" project:beta\r\n");

    expect(alphaAudit).toMatchObject({
      active: 3,
      invalid: 0,
      needsRevalidation: 1,
    });
    expect(betaAudit).toMatchObject({
      active: 3,
      invalid: 0,
      needsRevalidation: 1,
    });
  }

  async function assertViewerSurface(
    scope: string,
    expected: "alpha" | "beta",
    forbidden: "alpha" | "beta",
  ): Promise<void> {
    const app = createApp();
    const encoded = encodeURIComponent(scope);
    const [memories, entities, edges, audit] = await Promise.all([
      rowsFrom(app.request(`/viewer/data/memories?scope=${encoded}&includeInternal=1&limit=100`)),
      rowsFrom(app.request(`/viewer/data/entities?scope=${encoded}&includeInternal=1&limit=100`)),
      rowsFrom(app.request(`/viewer/data/edges?scope=${encoded}&includeInternal=1&limit=100`)),
      rowsFrom(app.request(`/viewer/data/audit?scope=${encoded}&includeInternal=1&limit=100`)),
    ]);

    expect(allRowsInScope(memories, scope)).toBe(true);
    expect(allRowsInScope(entities, scope)).toBe(true);
    expect(allRowsInScope(edges, scope)).toBe(true);
    expect(allRowsInScope(audit, scope)).toBe(true);
    expect(JSON.stringify({ memories, entities, edges, audit })).toContain(expected);
    expect(JSON.stringify({ memories, entities, edges, audit })).not.toContain(forbidden);
  }

  async function rowsFrom(
    responseInput: Response | Promise<Response>,
  ): Promise<Array<Record<string, unknown>>> {
    const response = await responseInput;
    const payload = (await response.json()) as { rows: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    return payload.rows;
  }

  function allRowsInScope(rows: Array<Record<string, unknown>>, scope: string): boolean {
    return rows.length > 0 && rows.every((row) => row.scope === scope);
  }

  async function cleanupScopes(): Promise<void> {
    const sql = getSqlClient();
    for (const scope of scopes) {
      await sql`delete from traces where scope = ${scope}`;
      await sql`delete from edges where scope = ${scope}`;
      await sql`delete from entities where scope = ${scope}`;
      await sql`delete from memories where scope = ${scope}`;
      await sql`delete from episodes where scope = ${scope}`;
      await sql`delete from chat_sessions where scope = ${scope}`;
    }
  }
});
