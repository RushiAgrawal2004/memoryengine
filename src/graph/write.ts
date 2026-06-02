import { ExtractedEntity, ExtractedRelation } from "../write/extract.js";
import { upsertEntity } from "./entities.js";
import { writeEdge, WrittenEdge } from "./edges.js";

export interface WriteGraphInput {
  scope: string;
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  sourceEpisode?: string;
}

export async function writeGraph(input: WriteGraphInput): Promise<WrittenEdge[]> {
  const byName = new Map<string, Awaited<ReturnType<typeof upsertEntity>>>();

  for (const entity of input.entities) {
    const created = await upsertEntity(input.scope, entity.kind, entity.name);
    byName.set(key(entity.kind, entity.name), created);
    byName.set(entity.name.toLowerCase(), created);
  }

  const edges: WrittenEdge[] = [];

  for (const relation of input.relations) {
    const src = byName.get(key(relation.srcKind ?? "symbol", relation.srcName))
      ?? byName.get(relation.srcName.toLowerCase())
      ?? await upsertEntity(input.scope, relation.srcKind ?? "symbol", relation.srcName);
    const dst = byName.get(key(relation.dstKind ?? "symbol", relation.dstName))
      ?? byName.get(relation.dstName.toLowerCase())
      ?? await upsertEntity(input.scope, relation.dstKind ?? "symbol", relation.dstName);

    byName.set(src.name.toLowerCase(), src);
    byName.set(dst.name.toLowerCase(), dst);

    edges.push(await writeEdge({
      scope: input.scope,
      src,
      dst,
      relation: relation.relation,
      fact: relation.fact,
      tValid: relation.tValid,
      sourceEpisode: input.sourceEpisode,
    }));
  }

  return edges;
}

function key(kind: string, name: string): string {
  return `${kind}:${name}`.toLowerCase();
}
