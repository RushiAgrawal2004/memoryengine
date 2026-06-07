import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { saveMemory } from "../src/db/memories.js";
import { LocalEmbeddings, setEmbeddingsForTest } from "../src/providers/embeddings.js";
import { LocalHeuristicLLM, setLLMForTest } from "../src/providers/llm.js";
import { extractEpisode } from "../src/write/extract.js";
import { ingestFacts } from "../src/write/memory-ops.js";

describe("chat history memory writing", () => {
  const scopes: string[] = [];

  beforeEach(() => {
    setLLMForTest(new LocalHeuristicLLM());
    setEmbeddingsForTest(new LocalEmbeddings());
  });

  afterEach(async () => {
    setLLMForTest(undefined);
    setEmbeddingsForTest(undefined);
    const sql = getSqlClient();
    for (const scope of scopes.splice(0)) {
      await sql`delete from traces where scope = ${scope}`;
      await sql`delete from memories where scope = ${scope}`;
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("extracts a user by-the-way durable fact without storing the request", async () => {
    const extracted = await extractEpisode([
      "LongMemEval session_id: chat-a",
      "LongMemEval session_date: 2026/06/08 (Mon) 09:00",
      "user: Can you help me clean up the dashboard? By the way, the project uses Vitest for unit tests.",
    ].join("\n"));

    expect(extracted.facts.map((fact) => fact.fact)).toEqual([
      "the project uses Vitest for unit tests",
    ]);
    expect(extracted.facts[0]).toMatchObject({
      sourceSessionId: "chat-a",
      speaker: "user",
      sessionDate: "2026/06/08 (Mon) 09:00",
      observationType: "user_fact",
    });
  });

  it("ignores generic assistant advice", async () => {
    const extracted = await extractEpisode([
      "LongMemEval session_id: chat-advice",
      "assistant: Here are five general debugging tips. First, read the logs. Second, restart the server.",
    ].join("\n"));

    expect(extracted.facts).toEqual([]);
  });

  it("stores user preferences with observation metadata", async () => {
    const scope = testScope(scopes);
    const extracted = await extractEpisode([
      "LongMemEval session_id: preference-session",
      "LongMemEval session_date: 2026/06/08 (Mon) 10:30",
      "user: I prefer concise dashboard cards with clear labels instead of dense raw tables.",
    ].join("\n"));

    await ingestFacts(extracted.facts, { scope });

    const [row] = await memoriesForScope(scope);
    expect(row?.content).toBe(
      "I prefer concise dashboard cards with clear labels instead of dense raw tables",
    );
    expect(row?.attrs).toMatchObject({
      observation: {
        sourceSessionId: "preference-session",
        speaker: "user",
        observationText: "I prefer concise dashboard cards with clear labels instead of dense raw tables",
        sessionDate: "2026/06/08 (Mon) 10:30",
        observationType: "preference",
      },
    });
  });

  it("invalidates an older fact when a chat history contains a knowledge update", async () => {
    const scope = testScope(scopes);
    const old = await saveMemory({ scope, content: "we use npm" });
    const extracted = await extractEpisode([
      "LongMemEval session_id: update-session",
      "LongMemEval session_date: 2026/06/08 (Mon) 11:00",
      "user: Actually, we switched the project package manager to pnpm last week.",
    ].join("\n"), new Date("2026-06-08T11:00:00.000Z"));

    const operations = await ingestFacts(extracted.facts, { scope });
    const rows = await memoriesForScope(scope);
    const oldRow = rows.find((row) => row.id === old.id);
    const newRow = rows.find((row) => row.supersedes === old.id);

    expect(operations[0]?.op).toBe("INVALIDATE");
    expect(oldRow?.status).toBe("invalid");
    expect(oldRow?.tInvalid).not.toBeNull();
    expect(newRow?.content).toBe("we switched the project package manager to pnpm last week");
    expect(newRow?.attrs).toMatchObject({
      observation: {
        sourceSessionId: "update-session",
        speaker: "user",
        sessionDate: "2026/06/08 (Mon) 11:00",
        observationType: "update",
      },
    });
    expect(newRow?.attrs.observation).toHaveProperty("mentionedDate");
  });

  it("preserves source session id for stored observations", async () => {
    const scope = testScope(scopes);
    const extracted = await extractEpisode([
      "LongMemEval session_id: source-session-42",
      "user: By the way, auth.ts calls verifyToken.",
    ].join("\n"));

    await ingestFacts(extracted.facts, { scope });

    const [row] = await memoriesForScope(scope);
    expect(row?.attrs).toMatchObject({
      observation: {
        sourceSessionId: "source-session-42",
        speaker: "user",
        observationText: "auth.ts calls verifyToken",
      },
    });
  });
});

interface MemoryRow {
  id: string;
  content: string;
  status: string;
  supersedes: string | null;
  tInvalid: string | null;
  attrs: {
    observation?: Record<string, unknown>;
  };
}

async function memoriesForScope(scope: string): Promise<MemoryRow[]> {
  return getSqlClient()<MemoryRow[]>`
    select
      id,
      content,
      status,
      supersedes,
      t_invalid::text as "tInvalid",
      coalesce(attrs, '{}'::jsonb) as attrs
    from memories
    where scope = ${scope}
    order by created_at asc
  `;
}

function testScope(scopes: string[]): string {
  const scope = `test:${crypto.randomUUID()}`;
  scopes.push(scope);
  return scope;
}
