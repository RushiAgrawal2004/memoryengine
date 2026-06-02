import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { decayPass, reflectPass, revalidatePass, runConsolidationOnce } from "../src/consolidate/loop.js";

describe("consolidation loop", () => {
  const scopes: string[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    const sql = getSqlClient();
    for (const scope of scopes.splice(0)) {
      await sql`delete from memories where scope = ${scope}`;
      await sql`delete from episodes where scope = ${scope}`;
    }

    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("reflects related recent episodes into a few durable memories without deleting episodes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-03T00:00:00.000Z"));
    const scope = testScope();
    const sql = getSqlClient();

    for (let i = 0; i < 20; i += 1) {
      await sql`
        insert into episodes (scope, kind, content, source, occurred_at)
        values (
          ${scope},
          'message',
          ${`auth token validation follows middleware pattern ${i}`},
          'test',
          ${new Date()}
        )
      `;
    }

    const result = await runConsolidationOnce({
      scope,
      episodeLimit: 20,
      decayDays: 365,
      logger: silentLogger,
    });
    const [episodeCount] = await sql<Array<{ count: number }>>`
      select count(*)::int as count from episodes where scope = ${scope}
    `;
    const [memoryCount] = await sql<Array<{ count: number }>>`
      select count(*)::int as count
      from memories
      where scope = ${scope}
        and type = 'semantic'
        and status = 'active'
    `;

    expect(result.reflect.checked).toBe(20);
    expect(memoryCount.count).toBeGreaterThan(0);
    expect(memoryCount.count).toBeLessThanOrEqual(3);
    expect(episodeCount.count).toBe(20);
  });

  it("decays unused memories and archives those below the floor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-06-03T00:00:00.000Z");
    vi.setSystemTime(now);
    const scope = testScope();
    const sql = getSqlClient();

    await sql`
      insert into memories (type, scope, content, confidence, status, created_at)
      values (
        'semantic',
        ${scope},
        'old low-confidence memory',
        0.25,
        'active',
        ${new Date("2026-01-01T00:00:00.000Z")}
      )
    `;

    const result = await decayPass({
      scope,
      now,
      decayDays: 30,
      decayFloor: 0.2,
    });
    const [row] = await sql<Array<{ confidence: number; status: string }>>`
      select confidence, status from memories where scope = ${scope}
    `;

    expect(result.changed).toBe(2);
    expect(row.confidence).toBeCloseTo(0.15);
    expect(row.status).toBe("archived");
  });

  it("revalidates flagged memories against current file content", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-03T00:00:00.000Z"));
    const scope = testScope();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "memoryengine-revalidate-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "auth.ts"), "export const current = true;\n");
    const sql = getSqlClient();

    await sql`
      insert into memories (type, scope, content, status, attrs, anchors)
      values (
        'semantic',
        ${scope},
        'auth.ts validates old tokens',
        'active',
        ${sql.json({ needs_revalidation: true } as never)},
        ${sql.json([{ path: "auth.ts", commit: "old" }] as never)}
      )
    `;

    const result = await revalidatePass({ scope, cwd: tempDir });
    const [row] = await sql<Array<{ status: string; needsRevalidation: boolean }>>`
      select
        status,
        coalesce((attrs->>'needs_revalidation')::boolean, false) as "needsRevalidation"
      from memories
      where scope = ${scope}
    `;

    expect(result.checked).toBe(1);
    expect(result.changed).toBe(1);
    expect(row.status).toBe("invalid");
    expect(row.needsRevalidation).toBe(false);
  });

  it("runs reflect as an idempotent pass", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-03T00:00:00.000Z"));
    const scope = testScope();
    const sql = getSqlClient();

    await sql`
      insert into episodes (scope, kind, content, source, occurred_at)
      values
        (${scope}, 'message', 'db migrations use drizzle patterns', 'test', ${new Date()}),
        (${scope}, 'message', 'db migrations use drizzle patterns again', 'test', ${new Date()})
    `;

    const first = await reflectPass({ scope, episodeLimit: 2 });
    const second = await reflectPass({ scope, episodeLimit: 2 });

    expect(first.changed).toBeGreaterThan(0);
    expect(second.changed).toBe(0);
  });

  function testScope(): string {
    const scope = `test:${crypto.randomUUID()}`;
    scopes.push(scope);
    return scope;
  }
});

const silentLogger = {
  log() {
    // test logger
  },
};
