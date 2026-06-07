import { config } from "../lib/config.js";

export interface Reranker {
  rerank(query: string, docs: string[], topN: number): Promise<RerankResult[]>;
}

export interface RerankResult {
  index: number;
  score: number;
}

interface CohereRerankResponse {
  results?: Array<{
    index: number;
    relevance_score: number;
  }>;
}

export class CohereReranker implements Reranker {
  constructor(
    private readonly apiKey = config.cohereApiKey,
    private readonly model = config.rerankModel,
  ) {}

  async rerank(query: string, docs: string[], topN: number): Promise<RerankResult[]> {
    if (!this.apiKey) {
      throw new Error("COHERE_API_KEY is required for Cohere reranking");
    }

    const response = await fetch("https://api.cohere.com/v2/rerank", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: docs,
        top_n: topN,
      }),
    });

    if (!response.ok) {
      throw new Error(`Cohere rerank failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as CohereRerankResponse;

    return (payload.results ?? []).map((result) => ({
      index: result.index,
      score: result.relevance_score,
    }));
  }
}

export class NoopReranker implements Reranker {
  async rerank(query: string, docs: string[], topN: number): Promise<RerankResult[]> {
    const queryTokens = meaningfulTokens(query);
    return docs
      .map((doc, index) => ({
        index,
        score: lexicalScore(queryTokens, meaningfulTokens(doc), index),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, topN);
  }
}

let reranker: Reranker | undefined;

export function getReranker(): Reranker {
  if (reranker) {
    return reranker;
  }

  reranker = config.rerankProvider === "cohere"
    ? new CohereReranker()
    : new NoopReranker();

  return reranker;
}

export function setRerankerForTest(next: Reranker | undefined): void {
  reranker = next;
}

function lexicalScore(queryTokens: string[], docTokens: string[], index: number): number {
  if (queryTokens.length === 0 || docTokens.length === 0) {
    return 1 / (index + 1_000);
  }

  const docSet = new Set(docTokens);
  const shared = new Set(queryTokens.filter((token) => docSet.has(token))).size;
  const recall = shared / queryTokens.length;
  const precision = shared / docSet.size;
  const originalRankPrior = 1 / ((index + 1) * 1_000);

  return recall * 0.75 + precision * 0.25 + originalRankPrior;
}

function meaningfulTokens(value: string): string[] {
  const stopwords = new Set([
    "a",
    "about",
    "after",
    "an",
    "and",
    "are",
    "as",
    "be",
    "by",
    "did",
    "do",
    "does",
    "for",
    "from",
    "had",
    "has",
    "have",
    "how",
    "i",
    "in",
    "is",
    "it",
    "my",
    "of",
    "on",
    "or",
    "the",
    "this",
    "to",
    "was",
    "were",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "with",
  ]);

  return [...new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9_.-]+/g)
      ?.filter((token) => token.length > 2 && !stopwords.has(token)) ?? [],
  )];
}
