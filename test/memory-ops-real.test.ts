import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { LocalEmbeddings, setEmbeddingsForTest } from "../src/providers/embeddings.js";
import { HostedLLM, setLLMForTest } from "../src/providers/llm.js";
import { extractEpisode } from "../src/write/extract.js";
import { AppliedMemoryOperation, ingestFacts } from "../src/write/memory-ops.js";

const hasHostedLLM = process.env.LLM_PROVIDER === "hosted" && Boolean(process.env.LLM_API_KEY);

describe.skipIf(!hasHostedLLM)("real hosted LLM memory operations", () => {
  const scopes: string[] = [];

  afterEach(async () => {
    setLLMForTest(undefined);
    setEmbeddingsForTest(undefined);
    const sql = getSqlClient();

    for (const scope of scopes.splice(0)) {
      await sql`delete from edges where scope = ${scope}`;
      await sql`delete from entities where scope = ${scope}`;
      await sql`delete from memories where scope = ${scope}`;
      await sql`delete from episodes where scope = ${scope}`;
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it(
    "handles contradiction, restatement, and unrelated additions from messy episodes",
    async () => {
      setLLMForTest(new HostedLLM());
      setEmbeddingsForTest(new LocalEmbeddings());
      const scope = testScope();

      await ingestRealEpisode(
        scope,
        [
          "Messy setup note after pairing: ignore the old scratch commands in the terminal.",
          "For this repo, the package manager we use is npm.",
          "If someone asks how to install dependencies, tell them npm install.",
        ].join(" "),
      );
      const originalNpm = (await memoriesForScope(scope)).find((row) =>
        row.status === "active" && mentions(row.content, "npm")
      );
      expect(originalNpm).toBeTruthy();

      const contradictionOps = await ingestRealEpisode(
        scope,
        [
          "Correction from standup, because I said it badly earlier:",
          "we no longer use npm here; actually we moved the package manager to pnpm last week.",
          "pnpm is the current package-manager choice for this repo.",
        ].join(" "),
      );
      const afterContradiction = await memoriesForScope(scope);
      const invalidatedNpm = afterContradiction.find((row) => row.id === originalNpm?.id);
      const pnpmReplacement = afterContradiction.find((row) =>
        row.supersedes === originalNpm?.id && mentions(row.content, "pnpm")
      );

      expect(contradictionOps.some((operation) => operation.op === "INVALIDATE")).toBe(true);
      expect(invalidatedNpm?.status).toBe("invalid");
      expect(invalidatedNpm?.tInvalid).not.toBeNull();
      expect(pnpmReplacement?.status).toBe("active");

      const activePnpmBeforeRestatement = countActivePnpm(await memoriesForScope(scope));
      const restatementOps = await ingestRealEpisode(
        scope,
        [
          "No architecture change here, just restating the dependency setup in different words.",
          "The repo's JavaScript package manager remains pnpm.",
          "This is the same package-manager decision as before, not a new choice.",
        ].join(" "),
      );
      const duplicatePnpmAdds = restatementOps.filter((operation) =>
        operation.op === "ADD" && mentions(`${operation.fact} ${operation.content}`, "pnpm")
      );

      expect(duplicatePnpmAdds).toEqual([]);
      expect(countActivePnpm(await memoriesForScope(scope))).toBe(activePnpmBeforeRestatement);

      const unrelatedOps = await ingestRealEpisode(
        scope,
        [
          "Different topic from today's work:",
          "auth token validation lives in src/auth.ts.",
          "The exported verifyToken function performs the check before protected routes run.",
        ].join(" "),
      );
      const finalRows = await memoriesForScope(scope);

      expect(unrelatedOps.some((operation) => operation.op === "ADD")).toBe(true);
      expect(
        finalRows.some((row) =>
          row.status === "active"
          && (mentions(row.content, "src/auth.ts") || mentions(row.content, "verifyToken"))
        ),
      ).toBe(true);
    },
    180_000,
  );

  async function ingestRealEpisode(
    scope: string,
    text: string,
  ): Promise<AppliedMemoryOperation[]> {
    const extracted = await extractEpisode(text, new Date("2026-06-04T12:00:00.000Z"));
    console.info(
      `[real-llm extract] ${JSON.stringify({
        scope,
        facts: extracted.facts.map((fact) => fact.fact),
        entities: extracted.entities,
        relations: extracted.relations,
      })}`,
    );

    return ingestFacts(extracted.facts, {
      scope,
      entities: extracted.entities,
      relations: extracted.relations,
      decisionLogger: (event) => {
        console.info(
          `[real-llm memory-op] ${JSON.stringify({
            fact: event.fact,
            candidates: event.candidates,
            decision: event.decision,
          })}`,
        );
      },
    });
  }

  function testScope(): string {
    const scope = `test:real-memory-ops:${crypto.randomUUID()}`;
    scopes.push(scope);
    return scope;
  }
});

interface MemoryRow {
  id: string;
  content: string;
  status: string;
  supersedes: string | null;
  tInvalid: string | null;
}

async function memoriesForScope(scope: string): Promise<MemoryRow[]> {
  return getSqlClient()<MemoryRow[]>`
    select
      id,
      content,
      status,
      supersedes,
      t_invalid::text as "tInvalid"
    from memories
    where scope = ${scope}
    order by created_at asc
  `;
}

function countActivePnpm(rows: MemoryRow[]): number {
  return rows.filter((row) => row.status === "active" && mentions(row.content, "pnpm")).length;
}

function mentions(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle.toLowerCase());
}
