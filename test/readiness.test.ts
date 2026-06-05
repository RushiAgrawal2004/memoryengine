import { describe, expect, it } from "vitest";
import { PgvectorDoctorReport } from "../src/db/embedding-vectors.js";
import { Config } from "../src/lib/config.js";
import { assessReadiness } from "../src/health/readiness.js";

describe("assessReadiness", () => {
  it("marks a fully configured setup production-ready", () => {
    const report = assessReadiness({
      databaseOk: true,
      serverRunning: true,
      config: readyConfig(),
      pgvector: readyPgvector(),
    });

    expect(report.ready).toBe(true);
    expect(report.label).toBe("production-ready");
    expect(report.failures).toEqual([]);
  });

  it("marks heuristic/local setups as development-only", () => {
    const report = assessReadiness({
      databaseOk: true,
      serverRunning: false,
      config: {
        ...readyConfig(),
        embeddingsProvider: "local",
        embeddingsApiKey: undefined,
        embeddingsLocal: true,
        llmProvider: "local",
        llmApiKey: undefined,
        rerankProvider: "none",
      },
      pgvector: {
        ...readyPgvector(),
        extensionInstalled: false,
        tables: readyPgvector().tables.map((table) => ({
          ...table,
          vectorColumn: false,
          hnswIndex: false,
          vectorEmbeddings: 0,
          vectorizedPercent: 0,
          missingVectors: table.totalRows,
        })),
      },
    });

    expect(report.ready).toBe(false);
    expect(report.label).toBe("development-only");
    expect(report.failures.map((failure) => failure.name)).toEqual(
      expect.arrayContaining([
        "hosted llm",
        "semantic embeddings",
        "local embedding fallback",
        "pgvector extension",
        "pgvector columns",
        "hnsw indexes",
        "vector backfill",
        "reranker",
      ]),
    );
    expect(report.warnings.map((warning) => warning.name)).toEqual(["server"]);
  });
});

function readyConfig(): Pick<
  Config,
  | "embeddingsProvider"
  | "embeddingsLocal"
  | "embeddingsApiKey"
  | "llmProvider"
  | "llmApiKey"
  | "rerankProvider"
  | "cohereApiKey"
> {
  return {
    embeddingsProvider: "hosted",
    embeddingsLocal: false,
    embeddingsApiKey: "embedding-key",
    llmProvider: "hosted",
    llmApiKey: "llm-key",
    rerankProvider: "cohere",
    cohereApiKey: "cohere-key",
  };
}

function readyPgvector(): PgvectorDoctorReport {
  return {
    extensionInstalled: true,
    localFallbackEnabled: false,
    tables: ["memories", "entities", "edges"].map((table) => ({
      table: table as "memories" | "entities" | "edges",
      totalRows: 10,
      jsonEmbeddings: 10,
      vectorEmbeddings: 10,
      missingVectors: 0,
      vectorColumn: true,
      hnswIndex: true,
      vectorizedPercent: 100,
    })),
    memoryQueryPlan: ["Index Scan using memories_embedding_vector_hnsw_idx"],
    memoryQueryPlanUsesIndex: true,
  };
}
