import * as z from "zod/v4";
import { getSqlClient } from "../db/client.js";
import { getEmbeddings } from "../providers/embeddings.js";
import { getLLM } from "../providers/llm.js";
import { Entity } from "./entities.js";

export interface GraphRelationWrite {
  scope: string;
  src: Entity;
  dst: Entity;
  relation: string;
  fact: string;
  tValid?: string;
  sourceEpisode?: string;
}

export interface WrittenEdge {
  id: string;
  invalidatedEdgeId?: string;
}

interface ExistingEdge {
  id: string;
  fact: string;
}

const contradictionSchema = z.object({
  contradicts: z.boolean(),
  targetId: z.string().optional(),
});

export async function writeEdge(input: GraphRelationWrite): Promise<WrittenEdge> {
  const sql = getSqlClient();
  const existingEdges = await sql<ExistingEdge[]>`
    select id, fact
    from edges
    where scope = ${input.scope}
      and src = ${input.src.id}
      and relation = ${input.relation}
      and t_expired is null
  `;

  const contradiction = existingEdges.length > 0
    ? await getLLM().json(
        "You are an edge contradiction decider. Decide whether the new fact contradicts one existing graph edge.",
        [
          `New fact: ${input.fact}`,
          "Existing edges:",
          JSON.stringify(existingEdges),
          "Return JSON with contradicts and optional targetId.",
        ].join("\n"),
        contradictionSchema,
      )
    : { contradicts: false };

  const [embedding] = await getEmbeddings().embed([input.fact]);

  return sql.begin(async (tx) => {
    if (contradiction.contradicts && contradiction.targetId) {
      await tx`
        update edges
        set t_invalid = now(),
            t_expired = now()
        where id = ${contradiction.targetId}
          and scope = ${input.scope}
          and t_expired is null
      `;
    }

    const [created] = await tx<Array<{ id: string }>>`
      insert into edges (
        scope,
        src,
        dst,
        relation,
        fact,
        embedding,
        t_valid,
        source_episode
      )
      values (
        ${input.scope},
        ${input.src.id},
        ${input.dst.id},
        ${input.relation},
        ${input.fact},
        ${tx.json(embedding)},
        ${input.tValid ? new Date(input.tValid) : null},
        ${input.sourceEpisode ?? null}
      )
      returning id
    `;

    return {
      id: created.id,
      invalidatedEdgeId: contradiction.targetId,
    };
  });
}
