import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { LocalEmbeddings, setEmbeddingsForTest } from "../src/providers/embeddings.js";
import { NoopReranker, setRerankerForTest } from "../src/providers/rerank.js";
import {
  adaptiveKFor,
  classifyQuestion,
  retrieveEvidence,
} from "../src/read/question.js";

describe("multi-hop evidence retrieval", () => {
  const scopes: string[] = [];

  beforeEach(() => {
    process.env.EMBEDDINGS_LOCAL = "1";
    setEmbeddingsForTest(new LocalEmbeddings());
    setRerankerForTest(new NoopReranker());
  });

  afterEach(async () => {
    setEmbeddingsForTest(undefined);
    setRerankerForTest(undefined);
    const sql = getSqlClient();
    for (const scope of scopes.splice(0)) {
      await sql`delete from traces where scope = ${scope}`;
      await sql`delete from memories where scope = ${scope}`;
      await sql`delete from episodes where scope = ${scope}`;
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("retrieves both event memories for a two-hop temporal question", async () => {
    const scope = testScope(scopes);
    await insertMemory({
      scope,
      content: "The beta launch happened on May 1, 2026.",
      sourceSessionId: "launch-session",
      eventDate: "2026-05-01T00:00:00.000Z",
    });
    await insertMemory({
      scope,
      content: "The billing migration happened on May 20, 2026.",
      sourceSessionId: "migration-session",
      eventDate: "2026-05-20T00:00:00.000Z",
    });
    await insertMemory({
      scope,
      content: "The unrelated dashboard color decision was green.",
      sourceSessionId: "noise-session",
    });

    const evidence = await retrieveEvidence(
      "how many days between beta launch and billing migration",
      scope,
      { topN: 2 },
    );

    expect(evidence[0]?.content).toBe("Answer: 19 days.");
    expect(evidence.map((item) => item.content)).toEqual(
      expect.arrayContaining([
        "The beta launch happened on May 1, 2026.",
        "The billing migration happened on May 20, 2026.",
      ]),
    );
  });

  it("diversifies repeated memories so one source session does not crowd out another", async () => {
    const scope = testScope(scopes);
    await insertMemory({
      scope,
      content: "Auth tokens use jose in middleware.",
      sourceSessionId: "alpha",
    });
    await insertMemory({
      scope,
      content: "Auth tokens are refreshed in middleware.",
      sourceSessionId: "alpha",
    });
    await insertMemory({
      scope,
      content: "Auth middleware protects dashboard routes.",
      sourceSessionId: "alpha",
    });
    await insertMemory({
      scope,
      content: "Dashboard routes require auth middleware.",
      sourceSessionId: "beta",
    });

    const evidence = await retrieveEvidence(
      "auth middleware evidence across sessions",
      scope,
      { topN: 2 },
    );
    const joined = evidence.map((item) => item.content).join("\n");

    expect(joined).toContain("Auth");
    expect(joined).toContain("Dashboard routes require auth middleware");
  });

  it("expands compressed memories with relevant source episode excerpts", async () => {
    const scope = testScope(scopes);
    const episodeId = await insertEpisode({
      scope,
      content: [
        "user: After the service appointment, the GPS system was not functioning correctly.",
        "assistant: You may need to contact the service center.",
        "user: The repair was finished two days later.",
      ].join("\n"),
    });
    await insertMemory({
      scope,
      content: "The car had a GPS issue after the service appointment.",
      sourceSessionId: "car-session",
      sourceEpisode: episodeId,
    });

    const evidence = await retrieveEvidence(
      "what was not functioning correctly after the service appointment",
      scope,
      { topN: 3, composeAnswer: false },
    );
    const joined = evidence.map((item) => item.content).join("\n");

    expect(joined).toContain("Source episode excerpt");
    expect(joined).toContain("GPS system was not functioning correctly");
  });

  it("uses larger adaptive k for temporal and multi-session questions", () => {
    expect(classifyQuestion("what package manager do we use")).toBe("single_fact");
    expect(classifyQuestion("how many days between launch and migration")).toBe(
      "temporal_difference",
    );
    expect(classifyQuestion("compare auth decisions across sessions")).toBe("multi_session");
    expect(adaptiveKFor("temporal_difference")).toBeGreaterThan(adaptiveKFor("single_fact"));
    expect(adaptiveKFor("multi_session")).toBeGreaterThan(adaptiveKFor("single_fact"));
  });
});

async function insertMemory(input: {
  scope: string;
  content: string;
  sourceSessionId: string;
  sourceEpisode?: string;
  eventDate?: string;
}): Promise<void> {
  const sql = getSqlClient();
  await sql`
    insert into memories (type, scope, content, status, source_episode, attrs)
    values (
      'semantic',
      ${input.scope},
      ${input.content},
      'active',
      ${input.sourceEpisode ?? null},
      ${sql.json({
        observation: {
          sourceSessionId: input.sourceSessionId,
          ...(input.eventDate
            ? {
                eventDate: input.eventDate,
                temporalRefs: [
                  {
                    text: input.eventDate.slice(0, 10),
                    kind: "explicit_date",
                    resolvedDate: input.eventDate,
                  },
                ],
              }
            : {}),
        },
      } as never)}
    )
  `;
}

async function insertEpisode(input: {
  scope: string;
  content: string;
}): Promise<string> {
  const sql = getSqlClient();
  const [row] = await sql<Array<{ id: string }>>`
    insert into episodes (scope, kind, content, source, occurred_at)
    values (${input.scope}, 'message', ${input.content}, 'test', now())
    returning id::text as id
  `;
  return row.id;
}

function testScope(scopes: string[]): string {
  const scope = `test:${crypto.randomUUID()}`;
  scopes.push(scope);
  return scope;
}
