import * as z from "zod/v4";
import { getSqlClient } from "../db/client.js";
import { getEmbeddings } from "../providers/embeddings.js";
import { getLLM } from "../providers/llm.js";
import { writeGraph } from "../graph/write.js";
import { retrieve } from "../read/retrieve.js";
import { ExtractedEntity, ExtractedFact, ExtractedRelation } from "./extract.js";

const memoryOperationSchema = z.object({
  op: z.enum(["ADD", "UPDATE", "INVALIDATE", "NOOP"]),
  targetId: z.string().optional(),
  content: z.string().min(1),
});

export type MemoryOperation = z.infer<typeof memoryOperationSchema>;

export interface IngestFactsContext {
  scope?: string;
  sourceEpisode?: string;
  entities?: ExtractedEntity[];
  relations?: ExtractedRelation[];
}

export interface AppliedMemoryOperation extends MemoryOperation {
  fact: string;
  memoryId?: string;
}

const DEFAULT_SCOPE = "global";

export async function ingestFacts(
  facts: ExtractedFact[],
  ctx: IngestFactsContext = {},
): Promise<AppliedMemoryOperation[]> {
  const scope = ctx.scope ?? DEFAULT_SCOPE;
  const decisions: AppliedMemoryOperation[] = [];

  for (const fact of facts) {
    const similar = await retrieve(fact.fact, scope, 5);
    const decision = await getLLM().json(
      "You are a memory operation decider. Choose one memory operation for the new fact: ADD, UPDATE, INVALIDATE, or NOOP.",
      [
        `Fact: ${fact.fact}`,
        "Existing memories:",
        JSON.stringify(
          similar.map((memory) => ({
            id: memory.id,
            content: memory.content,
          })),
        ),
        "Return JSON with op, optional targetId, and content.",
      ].join("\n"),
      memoryOperationSchema,
    );

    decisions.push({ ...decision, fact: fact.fact });
  }

  const embeddings = await getEmbeddings().embed(
    decisions
      .filter((decision) => decision.op !== "NOOP")
      .map((decision) => decision.content),
  );
  let embeddingIndex = 0;

  const sql = getSqlClient();
  const applied = await sql.begin(async (tx) => {
    const results: AppliedMemoryOperation[] = [];

    for (const decision of decisions) {
      if (decision.op === "NOOP") {
        results.push(decision);
        continue;
      }

      const embedding = embeddings[embeddingIndex];
      embeddingIndex += 1;

      if (decision.op === "ADD") {
        const [row] = await tx<Array<{ id: string }>>`
          insert into memories (type, scope, content, embedding, source_episode)
          values (
            'semantic',
            ${scope},
            ${decision.content},
            ${tx.json(embedding)},
            ${ctx.sourceEpisode ?? null}
          )
          returning id
        `;
        results.push({ ...decision, memoryId: row.id });
        continue;
      }

      if (!decision.targetId) {
        throw new Error(`${decision.op} requires targetId`);
      }

      if (decision.op === "UPDATE") {
        await tx`
          update memories
          set
            content = ${decision.content},
            embedding = ${tx.json(embedding)},
            confidence = least(confidence + 0.1, 1.0),
            last_used_at = now()
          where id = ${decision.targetId}
            and scope = ${scope}
            and status = 'active'
        `;
        results.push({ ...decision, memoryId: decision.targetId });
        continue;
      }

      await tx`
        update memories
        set
          status = 'invalid',
          t_invalid = now(),
          t_expired = now(),
          last_used_at = now()
        where id = ${decision.targetId}
          and scope = ${scope}
          and status = 'active'
      `;

      const [row] = await tx<Array<{ id: string }>>`
        insert into memories (
          type,
          scope,
          content,
          embedding,
          source_episode,
          supersedes
        )
        values (
          'semantic',
          ${scope},
          ${decision.content},
          ${tx.json(embedding)},
          ${ctx.sourceEpisode ?? null},
          ${decision.targetId}
        )
        returning id
      `;
      results.push({ ...decision, memoryId: row.id });
    }

    return results;
  });

  if (ctx.entities?.length || ctx.relations?.length) {
    await writeGraph({
      scope,
      entities: ctx.entities ?? [],
      relations: ctx.relations ?? [],
      sourceEpisode: ctx.sourceEpisode,
    });
  }

  return applied;
}
