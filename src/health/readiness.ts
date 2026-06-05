import type { PgvectorDoctorReport } from "../db/embedding-vectors.js";
import type { Config } from "../lib/config.js";

export type ReadinessSeverity = "pass" | "warn" | "fail";

export interface ReadinessCheck {
  name: string;
  severity: ReadinessSeverity;
  message: string;
}

export interface ReadinessInput {
  databaseOk: boolean;
  serverRunning: boolean;
  config: Pick<
    Config,
    | "embeddingsProvider"
    | "embeddingsLocal"
    | "embeddingsApiKey"
    | "llmProvider"
    | "llmApiKey"
    | "rerankProvider"
    | "cohereApiKey"
  >;
  pgvector?: PgvectorDoctorReport;
}

export interface ReadinessReport {
  ready: boolean;
  label: "production-ready" | "development-only";
  checks: ReadinessCheck[];
  failures: ReadinessCheck[];
  warnings: ReadinessCheck[];
}

export function assessReadiness(input: ReadinessInput): ReadinessReport {
  const pgvector = input.pgvector;
  const checks: ReadinessCheck[] = [
    check(
      "database",
      input.databaseOk,
      "Postgres connection is working.",
      "Postgres connection is not working.",
    ),
    check(
      "hosted llm",
      input.config.llmProvider === "hosted" && Boolean(input.config.llmApiKey),
      "Hosted LLM is configured for extraction and memory-operation decisions.",
      "Hosted LLM is not configured; write quality is heuristic/dev-only.",
    ),
    check(
      "semantic embeddings",
      input.config.embeddingsProvider === "hosted" && Boolean(input.config.embeddingsApiKey),
      "Hosted semantic embeddings are configured.",
      "Hosted semantic embeddings are not configured; similarity quality is dev-only.",
    ),
    check(
      "local embedding fallback",
      !input.config.embeddingsLocal,
      "Local embedding fallback is disabled.",
      "Local embedding fallback is enabled; vector similarity may use non-semantic fallback data.",
    ),
    check(
      "pgvector extension",
      Boolean(input.pgvector?.extensionInstalled),
      "pgvector extension is present.",
      "pgvector extension is missing; vector recall cannot use Postgres indexes.",
    ),
    check(
      "pgvector columns",
      Boolean(pgvector?.tables.every((table) => table.vectorColumn)),
      "All embedding vector columns are present.",
      "One or more embedding vector columns are missing.",
    ),
    check(
      "hnsw indexes",
      Boolean(pgvector?.tables.every((table) => table.hnswIndex)),
      "All HNSW vector indexes are present.",
      "One or more HNSW vector indexes are missing.",
    ),
    check(
      "vector backfill",
      Boolean(pgvector?.tables.every((table) =>
        table.totalRows === 0 || table.vectorizedPercent === 100
      )),
      "Existing embedding rows are fully vectorized.",
      "Some existing embedding rows are not vectorized.",
    ),
    check(
      "reranker",
      input.config.rerankProvider !== "none"
        && (input.config.rerankProvider !== "cohere" || Boolean(input.config.cohereApiKey)),
      "Reranker is configured.",
      "Reranker is not configured; retrieval quality is not fully validated.",
    ),
    {
      name: "server",
      severity: input.serverRunning ? "pass" : "warn",
      message: input.serverRunning
        ? "HTTP server is reachable."
        : "HTTP server is not running. Start memoryengine before dashboard or hook tests.",
    },
  ];
  const failures = checks.filter((item) => item.severity === "fail");
  const warnings = checks.filter((item) => item.severity === "warn");

  return {
    ready: failures.length === 0,
    label: failures.length === 0 ? "production-ready" : "development-only",
    checks,
    failures,
    warnings,
  };
}

function check(
  name: string,
  condition: boolean,
  passMessage: string,
  failMessage: string,
): ReadinessCheck {
  return {
    name,
    severity: condition ? "pass" : "fail",
    message: condition ? passMessage : failMessage,
  };
}
