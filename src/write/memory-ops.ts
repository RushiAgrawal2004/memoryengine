import * as z from "zod/v4";
import { getSqlClient } from "../db/client.js";
import { syncMemoryVector } from "../db/embedding-vectors.js";
import type { Anchor } from "../db/schema.js";
import { saveTrace } from "../db/traces.js";
import { config } from "../lib/config.js";
import { getEmbeddings } from "../providers/embeddings.js";
import { getLLM } from "../providers/llm.js";
import { writeGraph } from "../graph/write.js";
import { currentRepoRef, projectScope } from "../grounding/git.js";
import { hashSymbolInFile } from "../grounding/symbols.js";
import { rrf } from "../read/fuse.js";
import { ftsRecall, RecallResult, vectorRecall } from "../read/recall.js";
import { ExtractedEntity, ExtractedFact, ExtractedRelation } from "./extract.js";

const memoryOperationSchema = z.object({
  op: z.enum(["ADD", "UPDATE", "INVALIDATE", "NOOP"]),
  targetId: z.string().optional(),
  content: z.string().min(1),
  rationale: z.string().optional(),
});
const batchMemoryOperationSchema = z.array(
  memoryOperationSchema.extend({
    factIndex: z.number().int().nonnegative(),
  }),
);

export type MemoryOperation = z.infer<typeof memoryOperationSchema>;

export interface IngestFactsContext {
  scope?: string;
  sourceEpisode?: string;
  sourceSession?: string;
  entities?: ExtractedEntity[];
  relations?: ExtractedRelation[];
  decisionLogger?: (event: MemoryOperationDecisionEvent) => void;
}

export interface AppliedMemoryOperation extends MemoryOperation {
  fact: string;
  memoryId?: string;
}

export interface MemoryOperationDecisionEvent {
  fact: string;
  candidates: Array<{ id: string; content: string }>;
  decision: MemoryOperation;
}

const DEFAULT_SCOPE = "global";

export async function ingestFacts(
  facts: ExtractedFact[],
  ctx: IngestFactsContext = {},
): Promise<AppliedMemoryOperation[]> {
  const repoRef = await currentRepoRef();
  const scope = ctx.scope ?? (repoRef ? await projectScope() : DEFAULT_SCOPE);
  const anchors = await anchorsFromContext({
    entities: ctx.entities ?? [],
    relations: ctx.relations ?? [],
    commit: repoRef?.commit,
  });
  const limitedFacts = facts.slice(0, config.maxOpsPerRemember);
  const decisionSlots: Array<AppliedMemoryOperation | undefined> = [];
  const pending: Array<{
    factIndex: number;
    fact: ExtractedFact;
    candidates: Array<{ id: string; content: string }>;
  }> = [];

  if (facts.length > limitedFacts.length) {
    console.warn(
      `[memory-engine] MAX_OPS_PER_REMEMBER exceeded: processing ${limitedFacts.length} of ${facts.length} extracted facts`,
    );
  }

  for (let factIndex = 0; factIndex < limitedFacts.length; factIndex += 1) {
    const fact = limitedFacts[factIndex];
    const localNoop = await findLocalNoopCandidate(fact.fact, scope);
    const similar = await recallMemoryCandidates(fact.fact, scope, 5);
    const candidates = similar.map((memory) => ({
      id: memory.id,
      content: memory.content,
    }));
    if (localNoop && !candidates.some((candidate) => candidate.id === localNoop.id)) {
      candidates.unshift({ id: localNoop.id, content: localNoop.content });
    }

    if (localNoop) {
      const decision: MemoryOperation = {
        op: "NOOP",
        targetId: localNoop.id,
        content: localNoop.content,
        rationale: localNoop.rationale,
      };
      await recordDecision({ scope, fact: fact.fact, candidates, decision, ctx });
      decisionSlots[factIndex] = { ...decision, fact: fact.fact };
      continue;
    }

    pending.push({ factIndex, fact, candidates });
  }

  if (pending.length > 0) {
    const batchDecisions = await decideMemoryOpsBatch(pending);
    const byIndex = new Map(batchDecisions.map((decision) => [decision.factIndex, decision]));
    const rawDecisions: MemoryOperationDecisionEvent[] = [];

    for (const item of pending) {
      const batchDecision = byIndex.get(item.factIndex);
      const decision: MemoryOperation = batchDecision
        ? {
            op: batchDecision.op,
            targetId: batchDecision.targetId,
            content: batchDecision.content,
            rationale: batchDecision.rationale,
          }
        : {
            op: "ADD",
            content: item.fact.fact,
            rationale: "LLM batch response omitted this fact; defaulted to ADD.",
          };

      rawDecisions.push({
        fact: item.fact.fact,
        candidates: item.candidates,
        decision,
      });
    }

    for (const item of collapseDuplicateInvalidations(rawDecisions)) {
      await recordDecision({ scope, ...item, ctx });
      const factIndex = pending.find((pendingItem) => pendingItem.fact.fact === item.fact)?.factIndex;
      if (factIndex !== undefined) {
        decisionSlots[factIndex] = { ...item.decision, fact: item.fact };
      }
    }
  }

  const decisions = decisionSlots.filter((decision): decision is AppliedMemoryOperation =>
    Boolean(decision),
  );

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
        if (decision.targetId) {
          await tx`
            update memories
            set
              confidence = least(confidence + 0.05, 1.0),
              last_used_at = now()
            where id = ${decision.targetId}
              and scope = ${scope}
              and status = 'active'
          `;
        }
        results.push({ ...decision, memoryId: decision.targetId });
        continue;
      }

      const embedding = embeddings[embeddingIndex];
      embeddingIndex += 1;

      if (decision.op === "ADD") {
        const [row] = await tx<Array<{ id: string }>>`
          insert into memories (
            type,
            scope,
            content,
            embedding,
            source_episode,
            source_session,
            repo_ref,
            anchors
          )
          values (
            'semantic',
            ${scope},
            ${decision.content},
            ${tx.json(embedding)},
            ${ctx.sourceEpisode ?? null},
            ${ctx.sourceSession ?? null},
            ${repoRef ? tx.json(repoRef as never) : null},
            ${anchors.length > 0 ? tx.json(anchors as never) : null}
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
            repo_ref = ${repoRef ? tx.json(repoRef as never) : null},
            anchors = ${anchors.length > 0 ? tx.json(anchors as never) : null},
            source_session = coalesce(${ctx.sourceSession ?? null}, source_session),
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
            source_session,
            repo_ref,
          anchors,
          supersedes
        )
        values (
          'semantic',
          ${scope},
          ${decision.content},
          ${tx.json(embedding)},
          ${ctx.sourceEpisode ?? null},
          ${ctx.sourceSession ?? null},
          ${repoRef ? tx.json(repoRef as never) : null},
          ${anchors.length > 0 ? tx.json(anchors as never) : null},
          ${decision.targetId}
        )
        returning id
      `;
      results.push({ ...decision, memoryId: row.id });
    }

    return results;
  });

  embeddingIndex = 0;
  for (const decision of decisions) {
    if (decision.op === "NOOP") {
      continue;
    }

    const appliedDecision = applied.find((item) => item.fact === decision.fact);
    const memoryId = appliedDecision?.memoryId;
    const embedding = embeddings[embeddingIndex];
    embeddingIndex += 1;

    if (memoryId && embedding) {
      await syncMemoryVector(memoryId, embedding);
    }
  }

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

async function decideMemoryOpsBatch(
  pending: Array<{
    factIndex: number;
    fact: ExtractedFact;
    candidates: Array<{ id: string; content: string }>;
  }>,
): Promise<z.infer<typeof batchMemoryOperationSchema>> {
  return getLLM().json(
    [
      "You are a memory operation decider for a coding-agent memory store.",
      "Choose exactly one operation for each new fact.",
      "ADD only when none of the candidate memories already represent the same subject/fact.",
      "NOOP when the new fact is merely a restatement of an existing active memory.",
      "UPDATE when the new fact keeps the same fact true but improves, clarifies, or adds useful detail.",
      "INVALIDATE when the new fact contradicts, replaces, reverses, or says the project moved away from an existing memory.",
      "For UPDATE, INVALIDATE, and NOOP, include targetId from the relevant candidate.",
      "For INVALIDATE, content must be the new replacement memory that should supersede the old one.",
      "Never create a duplicate ADD for a paraphrase of an existing memory.",
      "Include a short rationale explaining why each operation was chosen.",
      "Return one JSON array item per input fact, preserving factIndex.",
    ].join(" "),
    [
      "Facts with candidates:",
      JSON.stringify(
        pending.map((item) => ({
          factIndex: item.factIndex,
          fact: item.fact.fact,
          candidates: item.candidates,
        })),
      ),
      "Return JSON array items with factIndex, op, optional targetId, content, and rationale.",
    ].join("\n"),
    batchMemoryOperationSchema,
  );
}

async function recordDecision(input: {
  scope: string;
  fact: string;
  candidates: Array<{ id: string; content: string }>;
  decision: MemoryOperation;
  ctx: IngestFactsContext;
}): Promise<void> {
  input.ctx.decisionLogger?.({
    fact: input.fact,
    candidates: input.candidates,
    decision: input.decision,
  });
  await saveTrace({
    kind: "ingest",
    scope: input.scope,
    query: input.fact,
    payload: {
      fact: input.fact,
      candidateMemories: input.candidates,
      chosenOp: input.decision.op,
      targetId: input.decision.targetId,
      content: input.decision.content,
      rationale: input.decision.rationale ?? null,
    },
  });
}

function collapseDuplicateInvalidations(
  events: MemoryOperationDecisionEvent[],
): MemoryOperationDecisionEvent[] {
  const lastInvalidationByTarget = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.decision.op === "INVALIDATE" && event.decision.targetId) {
      lastInvalidationByTarget.set(event.decision.targetId, index);
    }
  });

  return events.filter((event, index) => {
    if (event.decision.op !== "INVALIDATE" || !event.decision.targetId) {
      return true;
    }

    return lastInvalidationByTarget.get(event.decision.targetId) === index;
  });
}

async function findLocalNoopCandidate(
  fact: string,
  scope: string,
): Promise<{ id: string; content: string; rationale: string } | undefined> {
  const exact = await findExactActiveMemory(fact, scope);
  if (exact) {
    return {
      ...exact,
      rationale: "Short-circuited before LLM because fact exactly matches an active memory.",
    };
  }

  const embeddings = getEmbeddings();
  if (!embeddings.semantic) {
    return undefined;
  }

  const [nearest] = await vectorRecall(fact, scope, 1);
  if (nearest && nearest.rank >= config.simNoopThreshold) {
    return {
      id: nearest.id,
      content: nearest.content,
      rationale: `Short-circuited before LLM because similarity ${nearest.rank.toFixed(4)} >= SIM_NOOP_THRESHOLD ${config.simNoopThreshold}.`,
    };
  }

  return undefined;
}

async function findExactActiveMemory(
  fact: string,
  scope: string,
): Promise<{ id: string; content: string } | undefined> {
  const sql = getSqlClient();
  const [row] = await sql<Array<{ id: string; content: string }>>`
    select id, content
    from memories
    where scope = ${scope}
      and status = 'active'
      and lower(btrim(content)) = lower(btrim(${fact}))
    order by created_at desc
    limit 1
  `;

  return row;
}

async function recallMemoryCandidates(
  fact: string,
  scope: string,
  k: number,
): Promise<Array<{ id: string; content: string }>> {
  const [vectorResults, ftsResults, keywordResults] = await Promise.all([
    vectorRecall(fact, scope, k),
    ftsRecall(fact, scope, k),
    keywordMemoryRecall(fact, scope, k),
  ]);

  return rrf([vectorResults, ftsResults, keywordResults])
    .slice(0, k)
    .map((result) => ({
      id: result.item.id,
      content: result.item.content,
    }));
}

async function keywordMemoryRecall(
  fact: string,
  scope: string,
  k: number,
): Promise<RecallResult[]> {
  const sql = getSqlClient();
  const rows = await sql<Array<{
    id: string;
    type: string;
    scope: string;
    content: string;
    createdAt: string;
  }>>`
    select
      id,
      type,
      scope,
      content,
      created_at::text as "createdAt"
    from memories
    where status = 'active'
      and scope = ${scope}
    order by created_at desc
    limit 500
  `;
  const factTokens = meaningfulTokensForRecall(fact);

  return rows
    .map((row) => ({
      ...row,
      rank: tokenOverlapScore(factTokens, meaningfulTokensForRecall(row.content)),
    }))
    .filter((row) => row.rank > 0)
    .sort((a, b) => b.rank - a.rank || b.createdAt.localeCompare(a.createdAt))
    .slice(0, k);
}

function tokenOverlapScore(queryTokens: string[], contentTokens: string[]): number {
  if (queryTokens.length === 0 || contentTokens.length === 0) {
    return 0;
  }

  const contentSet = new Set(contentTokens);
  const shared = new Set(queryTokens.filter((token) => contentSet.has(token)));
  return shared.size / queryTokens.length;
}

function meaningfulTokensForRecall(value: string): string[] {
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "be",
    "for",
    "from",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "the",
    "this",
    "to",
    "use",
    "uses",
    "we",
  ]);

  return [...new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9_.-]+/g)
      ?.filter((token) => token.length > 2 && !stopwords.has(token)) ?? [],
  )];
}

async function anchorsFromContext(input: {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  commit: string | undefined;
}): Promise<Anchor[]> {
  const { entities, relations, commit } = input;
  if (!commit) {
    return [];
  }

  const anchors = new Map<string, Anchor>();
  const symbolFiles = symbolPathCandidates(relations);

  for (const entity of entities) {
    if (entity.kind === "file") {
      anchors.set(`file:${entity.name}`, {
        path: entity.name,
        commit,
      });
    }

    if (entity.kind === "symbol") {
      const path = symbolFiles.get(entity.name.toLowerCase()) ?? "";
      const symbolData = path
        ? await hashSymbolInFile(path, entity.name)
        : undefined;
      anchors.set(`symbol:${entity.name}`, {
        path,
        symbol: entity.name,
        commit,
        ...(symbolData ?? {}),
      });
    }
  }

  return [...anchors.values()];
}

function symbolPathCandidates(relations: ExtractedRelation[]): Map<string, string> {
  const candidates = new Map<string, string>();

  for (const relation of relations) {
    const srcKind = relation.srcKind ?? kindForName(relation.srcName);
    const dstKind = relation.dstKind ?? kindForName(relation.dstName);

    if (srcKind === "file" && dstKind === "symbol") {
      candidates.set(relation.dstName.toLowerCase(), relation.srcName);
    }

    if (dstKind === "file" && srcKind === "symbol") {
      candidates.set(relation.srcName.toLowerCase(), relation.dstName);
    }
  }

  return candidates;
}

function kindForName(name: string): string {
  return /\.[cm]?[jt]sx?$|\.py$|\.go$|\.rs$/i.test(name) ? "file" : "symbol";
}
