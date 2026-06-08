import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { LocalEmbeddings, setEmbeddingsForTest } from "../src/providers/embeddings.js";
import { NoopReranker, setRerankerForTest } from "../src/providers/rerank.js";
import { retrieve } from "../src/read/retrieve.js";
import { normalizeTemporalText } from "../src/time/normalize.js";

describe("temporal memory normalization and retrieval", () => {
  const scopes: string[] = [];

  beforeEach(() => {
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
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("resolves relative dates and durations using occurred_at", () => {
    const occurredAt = new Date("2026-06-08T12:00:00.000Z");
    const normalized = normalizeTemporalText(
      "Yesterday we changed auth. Two months ago we used npm. The migration took two and a half weeks after the launch.",
      occurredAt,
    );

    expect(normalized.mentionedAt).toBe("2026-06-08T12:00:00.000Z");
    expect(normalized.temporalRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "yesterday",
          kind: "relative_date",
          resolvedDate: "2026-06-07T12:00:00.000Z",
        }),
        expect.objectContaining({
          text: "Two months ago",
          kind: "relative_date",
          resolvedDate: "2026-04-09T12:00:00.000Z",
          unit: "month",
          amount: 2,
        }),
        expect.objectContaining({
          text: "after the launch",
          kind: "event_relation",
          direction: "after",
          eventText: "launch",
        }),
        expect.objectContaining({
          text: "two and a half weeks",
          kind: "duration",
          amount: 2.5,
          unit: "week",
          days: 17.5,
        }),
      ]),
    );
  });

  it("retrieves two dated events for a days-between question", async () => {
    const scope = testScope(scopes);
    await insertTemporalMemory({
      scope,
      content: "The launch happened on June 1, 2026.",
      eventDate: "2026-06-01T00:00:00.000Z",
    });
    await insertTemporalMemory({
      scope,
      content: "The migration happened on June 10, 2026.",
      eventDate: "2026-06-10T00:00:00.000Z",
    });

    const results = await retrieve({
      scope,
      query: "how many days between launch and migration",
      topN: 2,
    });

    expect(results.map((result) => result.content)).toEqual(
      expect.arrayContaining([
        "The launch happened on June 1, 2026.",
        "The migration happened on June 10, 2026.",
      ]),
    );
  });

  it("returns the latest dated fact first when temporal facts conflict", async () => {
    const scope = testScope(scopes);
    await insertTemporalMemory({
      scope,
      content: "The package manager was npm.",
      eventDate: "2026-04-01T00:00:00.000Z",
    });
    await insertTemporalMemory({
      scope,
      content: "The package manager is pnpm.",
      eventDate: "2026-06-01T00:00:00.000Z",
    });

    const [latest] = await retrieve({
      scope,
      query: "latest package manager",
      topN: 1,
    });

    expect(latest?.content).toBe("The package manager is pnpm.");
  });
});

async function insertTemporalMemory(input: {
  scope: string;
  content: string;
  eventDate: string;
}): Promise<void> {
  const sql = getSqlClient();
  await sql`
    insert into memories (type, scope, content, status, attrs)
    values (
      'semantic',
      ${input.scope},
      ${input.content},
      'active',
      ${sql.json({
        observation: {
          eventDate: input.eventDate,
          mentionedAt: "2026-06-08T12:00:00.000Z",
          temporalRefs: [
            {
              text: input.eventDate.slice(0, 10),
              kind: "explicit_date",
              resolvedDate: input.eventDate,
            },
          ],
        },
      } as never)}
    )
  `;
}

function testScope(scopes: string[]): string {
  const scope = `test:${crypto.randomUUID()}`;
  scopes.push(scope);
  return scope;
}
