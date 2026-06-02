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
  async rerank(_query: string, docs: string[], topN: number): Promise<RerankResult[]> {
    return docs.slice(0, topN).map((_doc, index) => ({
      index,
      score: 1 / (index + 1),
    }));
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
