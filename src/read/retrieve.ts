import { ftsRecall, graphRecall, RecallResult, vectorRecall } from "./recall.js";
import { rrf } from "./fuse.js";
import { getReranker } from "../providers/rerank.js";

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

  const [vectorResults, ftsResults, graphResults] = await Promise.all([
    vectorRecall(trimmed, resolvedScope, RECALL_K, asOf),
    ftsRecall(trimmed, resolvedScope, RECALL_K, asOf),
    graphRecall(trimmed, resolvedScope, RECALL_K, asOf),
  ]);

  const fused = rrf([vectorResults, ftsResults, graphResults])
    .slice(0, RERANK_CANDIDATES)
    .map((result) => result.item);

  if (fused.length === 0) {
    return [];
  }

  const reranked = await getReranker().rerank(
    trimmed,
    fused.map((result) => result.content),
    resolvedTopN,
  );

  return reranked
    .map((result) => {
      const item = fused[result.index];
      return item ? { ...item, rank: result.score } : undefined;
    })
    .filter((item): item is RecallResult => Boolean(item));
}
