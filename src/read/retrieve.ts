import { performance } from "node:perf_hooks";
import { ftsRecall, graphRecall, RecallResult, vectorRecall } from "./recall.js";
import { rrf } from "./fuse.js";
import { getReranker } from "../providers/rerank.js";
import { saveTrace } from "../db/traces.js";

const RECALL_K = 30;
const RERANK_CANDIDATES = 20;
const DEFAULT_TOP_N = 5;

export async function retrieve(
  input: string | { query: string; scope?: string; topN?: number; asOf?: Date },
  scope?: string,
  topN = DEFAULT_TOP_N,
): Promise<RecallResult[]> {
  const query = typeof input === "string" ? input : input.query;
  const resolvedScope = typeof input === "string" ? scope : input.scope;
  const resolvedTopN = typeof input === "string" ? topN : input.topN ?? DEFAULT_TOP_N;
  const asOf = typeof input === "string" ? undefined : input.asOf;
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const started = performance.now();

  const [vectorResults, ftsResults, graphResults] = await Promise.all([
    vectorRecall(trimmed, resolvedScope, RECALL_K, asOf),
    ftsRecall(trimmed, resolvedScope, RECALL_K, asOf),
    graphRecall(trimmed, resolvedScope, RECALL_K, asOf),
  ]);

  const fusedRanked = rrf([vectorResults, ftsResults, graphResults]);
  const fused = fusedRanked
    .slice(0, RERANK_CANDIDATES)
    .map((result) => result.item);

  if (fused.length === 0) {
    await saveRetrieveTrace({
      query: trimmed,
      scope: resolvedScope,
      started,
      vectorResults,
      ftsResults,
      graphResults,
      rrfResults: fusedRanked,
      reranked: [],
      fused,
      finalResults: [],
    });
    return [];
  }

  const reranked = await getReranker().rerank(
    trimmed,
    fused.map((result) => result.content),
    resolvedTopN,
  );

  const finalResults = reranked
    .map((result) => {
      const item = fused[result.index];
      return item ? { ...item, rank: result.score } : undefined;
    })
    .filter((item): item is RecallResult => Boolean(item));

  await saveRetrieveTrace({
    query: trimmed,
    scope: resolvedScope,
    started,
    vectorResults,
    ftsResults,
    graphResults,
    rrfResults: fusedRanked,
    reranked,
    fused,
    finalResults,
  });

  return finalResults;
}

interface RetrieveTraceInput {
  query: string;
  scope?: string;
  started: number;
  vectorResults: RecallResult[];
  ftsResults: RecallResult[];
  graphResults: RecallResult[];
  rrfResults: Array<{ item: RecallResult; score: number }>;
  reranked: Array<{ index: number; score: number }>;
  fused: RecallResult[];
  finalResults: RecallResult[];
}

async function saveRetrieveTrace(input: RetrieveTraceInput): Promise<void> {
  const latencyMs = performance.now() - input.started;

  await saveTrace({
    kind: "retrieve",
    scope: input.scope,
    query: input.query,
    latencyMs,
    payload: {
      query: input.query,
      sources: {
        vector: traceHits(input.vectorResults),
        fts: traceHits(input.ftsResults),
        graph: traceHits(input.graphResults),
      },
      postRrf: input.rrfResults.map((result, index) => ({
        rank: index + 1,
        id: result.item.id,
        score: result.score,
        content: result.item.content,
      })),
      postRerank: input.reranked.map((result, index) => ({
        rank: index + 1,
        id: input.fused[result.index]?.id,
        score: result.score,
        content: input.fused[result.index]?.content,
      })),
      finalSelectedIds: input.finalResults.map((result) => result.id),
      totalLatencyMs: latencyMs,
    },
  });
}

function traceHits(results: RecallResult[]): Array<{
  id: string;
  score: number;
  content: string;
}> {
  return results.map((result) => ({
    id: result.id,
    score: result.rank,
    content: result.content,
  }));
}
