import type { PgvectorDoctorReport } from "../db/embedding-vectors.js";
import type { Config } from "../lib/config.js";
import type { ReadinessCheck, ReadinessSeverity } from "./readiness.js";

export interface SmokeCheckResult {
  name: "hosted embedding smoke" | "hosted llm json smoke";
  severity: ReadinessSeverity;
  message: string;
}

export interface EvalReadinessInput {
  databaseOk: boolean;
  config: Pick<
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
  >;
  pgvector?: PgvectorDoctorReport;
  rerankerExplicitlyDisabled: boolean;
  smokeRequested: boolean;
  smokeChecks?: SmokeCheckResult[];
}

export interface EvalReadinessReport {
  ready: boolean;
  label: "official-eval-ready" | "not-official-ready";
  checks: ReadinessCheck[];
  failures: ReadinessCheck[];
  warnings: ReadinessCheck[];
}

const placeholderPatterns = [
  /^$/,
  /placeholder/i,
  /replace/i,
  /change[-_ ]?me/i,
  /your[-_ ]?/i,
  /dummy/i,
  /example/i,
  /test[-_ ]?key/i,
  /^sk-?$/i,
  /^x+$/i,
  /^\*+$/,
  /^\.{3}$/,
];

export function isPlaceholderSecret(value: string | undefined): boolean {
  const normalized = (value ?? "").trim();
  return placeholderPatterns.some((pattern) => pattern.test(normalized));
}

export function assessEvalReadiness(input: EvalReadinessInput): EvalReadinessReport {
  const checks: ReadinessCheck[] = [
    check(
      "database",
      input.databaseOk,
      "DATABASE_URL connects successfully.",
      "DATABASE_URL is missing or cannot connect.",
    ),
    check(
      "pgvector extension",
      Boolean(input.pgvector?.extensionInstalled),
      "pgvector extension is available.",
      "pgvector extension is not available; official eval should use pgvector-backed recall.",
    ),
    check(
      "vector columns",
      Boolean(input.pgvector?.tables.every((table) => table.vectorColumn)),
      "embedding_vector columns are available on memories, entities, and edges.",
      "One or more embedding_vector columns are missing.",
    ),
    check(
      "hosted embeddings",
      input.config.embeddingsProvider === "hosted"
        && !isPlaceholderSecret(input.config.embeddingsApiKey),
      `Hosted embeddings are configured with ${input.config.embeddingsModel}.`,
      "Set EMBEDDINGS_PROVIDER=hosted and a real EMBEDDINGS_API_KEY.",
    ),
    check(
      "hosted llm",
      input.config.llmProvider === "hosted" && !isPlaceholderSecret(input.config.llmApiKey),
      `Hosted LLM is configured with ${input.config.llmModel}.`,
      "Set LLM_PROVIDER=hosted and a real LLM_API_KEY.",
    ),
    rerankerCheck(input),
    smokeStatusCheck(input),
    ...(input.smokeChecks ?? []),
  ];
  const failures = checks.filter((item) => item.severity === "fail");
  const warnings = checks.filter((item) => item.severity === "warn");

  return {
    ready: failures.length === 0,
    label: failures.length === 0 ? "official-eval-ready" : "not-official-ready",
    checks,
    failures,
    warnings,
  };
}

export function formatEvalReadiness(report: EvalReadinessReport): string[] {
  return [
    `eval readiness: ${report.label}`,
    "eval readiness checks:",
    ...report.checks.map((item) =>
      `- ${readinessIcon(item)} ${item.name}: ${item.message}`
    ),
  ];
}

function rerankerCheck(input: EvalReadinessInput): ReadinessCheck {
  if (input.config.rerankProvider === "none") {
    return {
      name: "reranker",
      severity: input.rerankerExplicitlyDisabled ? "pass" : "warn",
      message: input.rerankerExplicitlyDisabled
        ? "Reranker is explicitly disabled with RERANK_PROVIDER=none."
        : "Reranker defaults to none; set RERANK_PROVIDER=none explicitly or configure a reranker.",
    };
  }

  if (
    input.config.rerankProvider === "cohere"
    && !isPlaceholderSecret(input.config.cohereApiKey)
  ) {
    return {
      name: "reranker",
      severity: "pass",
      message: `Cohere reranker is configured with ${input.config.rerankModel}.`,
    };
  }

  return {
    name: "reranker",
    severity: "fail",
    message: "Configure COHERE_API_KEY or set RERANK_PROVIDER=none explicitly.",
  };
}

function smokeStatusCheck(input: EvalReadinessInput): ReadinessCheck {
  if (input.smokeRequested) {
    return {
      name: "paid smoke gate",
      severity: "pass",
      message: "Paid hosted smoke checks were requested with --smoke.",
    };
  }

  return {
    name: "paid smoke gate",
    severity: "warn",
    message: "Hosted smoke calls were skipped. Pass --smoke to verify real provider calls.",
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

function readinessIcon(item: ReadinessCheck): string {
  if (item.severity === "pass") {
    return "PASS";
  }

  if (item.severity === "warn") {
    return "WARN";
  }

  return "FAIL";
}
