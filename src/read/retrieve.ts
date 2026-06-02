import { ftsRecall, RecallResult, vectorRecall } from "./recall.js";
import { rrf } from "./fuse.js";
import { getReranker } from "../providers/rerank.js";

const RECALL_K = 30;
const RERANK_CANDIDATES = 20;
const DEFAULT_TOP_N = 5;

export async function retrieve(
  query: string,
  scope?: string,
  topN = DEFAULT_TOP_N,
): Promise<RecallResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const [vectorResults, ftsResults] = await Promise.all([
    vectorRecall(trimmed, scope, RECALL_K),
    ftsRecall(trimmed, scope, RECALL_K),
  ]);

  const fused = rrf([vectorResults, ftsResults])
    .slice(0, RERANK_CANDIDATES)
    .map((result) => result.item);

  if (fused.length === 0) {
    return [];
  }

  const reranked = await getReranker().rerank(
    trimmed,
    fused.map((result) => result.content),
    topN,
  );

  return reranked
    .map((result) => {
      const item = fused[result.index];
      return item ? { ...item, rank: result.score } : undefined;
    })
    .filter((item): item is RecallResult => Boolean(item));
}
