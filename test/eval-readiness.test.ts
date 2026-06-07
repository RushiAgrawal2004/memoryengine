import { describe, expect, it } from "vitest";
import { PgvectorDoctorReport } from "../src/db/embedding-vectors.js";
import {
  assessEvalReadiness,
  formatEvalReadiness,
  isPlaceholderSecret,
} from "../src/health/eval-readiness.js";
import { Config } from "../src/lib/config.js";

describe("eval readiness", () => {
  it("detects missing and placeholder provider keys", () => {
    expect(isPlaceholderSecret(undefined)).toBe(true);
    expect(isPlaceholderSecret("")).toBe(true);
    expect(isPlaceholderSecret("your_gemini_api_key")).toBe(true);
    expect(isPlaceholderSecret("replace-me")).toBe(true);
    expect(isPlaceholderSecret("placeholder")).toBe(true);
    expect(isPlaceholderSecret("test-key")).toBe(true);
    expect(isPlaceholderSecret("sk-real-looking-value-123")).toBe(false);
    expect(isPlaceholderSecret("AIza-real-looking-value-123")).toBe(false);
  });

  it("formats official eval checks with pass, warn, and fail statuses", () => {
    const report = assessEvalReadiness({
      databaseOk: true,
      config: {
        ...hostedConfig(),
        embeddingsApiKey: "your_embedding_key",
        llmApiKey: "placeholder",
        rerankProvider: "none",
        cohereApiKey: undefined,
      },
      pgvector: readyPgvector(),
      rerankerExplicitlyDisabled: true,
      smokeRequested: false,
    });

    const lines = formatEvalReadiness(report);

    expect(report.ready).toBe(false);
    expect(lines).toContain("eval readiness: not-official-ready");
    expect(lines).toContain(
      "- FAIL hosted embeddings: Set EMBEDDINGS_PROVIDER=hosted and a real EMBEDDINGS_API_KEY.",
    );
    expect(lines).toContain("- FAIL hosted llm: Set LLM_PROVIDER=hosted and a real LLM_API_KEY.");
    expect(lines).toContain(
      "- PASS reranker: Reranker is explicitly disabled with RERANK_PROVIDER=none.",
    );
    expect(lines).toContain(
      "- WARN paid smoke gate: Hosted smoke calls were skipped. Pass --smoke to verify real provider calls.",
    );
  });

  it("marks a real-provider eval setup ready when smoke checks pass", () => {
    const report = assessEvalReadiness({
      databaseOk: true,
      config: hostedConfig(),
      pgvector: readyPgvector(),
      rerankerExplicitlyDisabled: false,
      smokeRequested: true,
      smokeChecks: [
        {
          name: "hosted embedding smoke",
          severity: "pass",
          message: "Hosted embeddings smoke returned 1536 dimensions.",
        },
        {
          name: "hosted llm json smoke",
          severity: "pass",
          message: "Hosted LLM JSON smoke returned ok=true.",
        },
      ],
    });

    expect(report.ready).toBe(true);
    expect(formatEvalReadiness(report)[0]).toBe("eval readiness: official-eval-ready");
  });
});

function hostedConfig(): Pick<
  Config,
  | "embeddingsProvider"
  | "embeddingsApiKey"
  | "embeddingsModel"
  | "embeddingsBaseUrl"
  | "llmProvider"
  | "llmApiKey"
  | "llmModel"
  | "llmBaseUrl"
  | "rerankProvider"
  | "cohereApiKey"
  | "rerankModel"
> {
  return {
    embeddingsProvider: "hosted",
    embeddingsApiKey: "embedding-real-key",
    embeddingsModel: "text-embedding-3-small",
    embeddingsBaseUrl: "https://api.openai.com/v1",
    llmProvider: "hosted",
    llmApiKey: "llm-real-key",
    llmModel: "gpt-4o-mini",
    llmBaseUrl: "https://api.openai.com/v1",
    rerankProvider: "cohere",
    cohereApiKey: "cohere-real-key",
    rerankModel: "rerank-v3.5",
  };
}

function readyPgvector(): PgvectorDoctorReport {
  return {
    extensionInstalled: true,
    localFallbackEnabled: false,
    tables: ["memories", "entities", "edges"].map((table) => ({
      table: table as "memories" | "entities" | "edges",
      totalRows: 2,
      jsonEmbeddings: 2,
      vectorEmbeddings: 2,
      missingVectors: 0,
      vectorColumn: true,
      hnswIndex: true,
      vectorizedPercent: 100,
    })),
    memoryQueryPlan: ["Index Scan using memories_embedding_vector_hnsw_idx"],
    memoryQueryPlanUsesIndex: true,
  };
}
