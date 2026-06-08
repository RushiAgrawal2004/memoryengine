import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LongMemEvalDebugFile {
  items: LongMemEvalDebugItem[];
}

export interface LongMemEvalDebugItem {
  question_id: string;
  question_type?: string;
  retrieved_memory_ids?: string[];
  evidence_summaries?: string[];
  source_session_ids?: string[];
  context_chars: number;
  latency_ms: number;
  hypothesis: string;
  gold_answer?: string;
}

export interface JudgeLabel {
  question_id: string;
  correct: boolean;
}

export interface LongMemEvalErrorRow {
  question_id: string;
  question_type?: string;
  correct?: boolean;
  gold_answer?: string;
  hypothesis: string;
  retrieved_evidence_summaries: string[];
  source_session_ids: string[];
  context_chars: number;
  latency_ms: number;
  failure_bucket_guess?: FailureBucket;
}

export type FailureBucket =
  | "retrieval_miss"
  | "answer_miss"
  | "temporal_calc"
  | "stale_update"
  | "abstention";

export interface DiagnosticsOutput {
  errorsPath: string;
  markdownPath: string;
  markdown: string;
}

interface CategorySummary {
  questionType: string;
  rows: LongMemEvalErrorRow[];
  accuracy?: number;
  recall: number;
  p50Latency: number;
  p95Latency: number;
  suggestedNextFix: string;
}

export async function writeLongMemEvalDiagnostics(input: {
  debugPath: string;
  officialLog?: string;
  outDir: string;
}): Promise<DiagnosticsOutput> {
  const debug = JSON.parse(await readFile(input.debugPath, "utf8")) as LongMemEvalDebugFile;
  const labels = input.officialLog ? parseJudgeLabels(input.officialLog) : [];
  const errors = buildErrorRows(debug.items ?? [], labels);
  const markdown = formatDiagnosticsReport(errors);
  const errorsPath = path.join(input.outDir, "errors.json");
  const markdownPath = path.join(input.outDir, "diagnostics.md");

  await mkdir(input.outDir, { recursive: true });
  await writeFile(errorsPath, `${JSON.stringify(errors, null, 2)}\n`);
  await writeFile(markdownPath, `${markdown}\n`);

  return { errorsPath, markdownPath, markdown };
}

export function parseJudgeLabels(logText: string): JudgeLabel[] {
  const labels: JudgeLabel[] = [];

  for (const line of logText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const row = JSON.parse(trimmed) as {
        question_id?: string;
        autoeval_label?: unknown;
      };
      const correct = labelToBoolean(row.autoeval_label);
      if (row.question_id && correct !== undefined) {
        labels.push({ question_id: row.question_id, correct });
      }
    } catch {
      continue;
    }
  }

  return labels;
}

export function buildErrorRows(
  debugItems: LongMemEvalDebugItem[],
  labels: JudgeLabel[] = [],
): LongMemEvalErrorRow[] {
  const correctById = new Map(labels.map((label) => [label.question_id, label.correct]));

  return debugItems.map((item) => {
    const correct = correctById.get(item.question_id);
    const row: LongMemEvalErrorRow = {
      question_id: item.question_id,
      ...(item.question_type ? { question_type: item.question_type } : {}),
      ...(correct !== undefined ? { correct } : {}),
      ...(item.gold_answer ? { gold_answer: item.gold_answer } : {}),
      hypothesis: item.hypothesis,
      retrieved_evidence_summaries: item.evidence_summaries ?? [],
      source_session_ids: item.source_session_ids ?? [],
      context_chars: item.context_chars,
      latency_ms: item.latency_ms,
    };
    const bucket = correct === false ? guessFailureBucket(item) : undefined;
    return bucket ? { ...row, failure_bucket_guess: bucket } : row;
  });
}

export function formatDiagnosticsReport(rows: LongMemEvalErrorRow[]): string {
  const summaries = summarizeByQuestionType(rows);
  const lines = [
    "# LongMemEval Diagnostics",
    "",
    "| Question type | Items | Accuracy | Recall | p50 latency | p95 latency | Suggested next fix |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];

  for (const summary of summaries) {
    lines.push(
      `| ${summary.questionType} | ${summary.rows.length} | ${formatOptionalPercent(summary.accuracy)} | ${formatPercent(summary.recall)} | ${Math.round(summary.p50Latency)}ms | ${Math.round(summary.p95Latency)}ms | ${summary.suggestedNextFix} |`,
    );
  }

  for (const summary of summaries) {
    const failures = summary.rows
      .filter((row) => row.correct === false)
      .slice(0, 10);
    if (failures.length === 0) {
      continue;
    }

    lines.push("", `## ${summary.questionType} Failures`, "");
    for (const row of failures) {
      lines.push(
        `- ${row.question_id}: ${row.failure_bucket_guess ?? "answer_miss"}; hypothesis=${quote(row.hypothesis)}; gold=${quote(row.gold_answer ?? "")}`,
      );
    }
  }

  return lines.join("\n");
}

function summarizeByQuestionType(rows: LongMemEvalErrorRow[]): CategorySummary[] {
  const byType = new Map<string, LongMemEvalErrorRow[]>();
  for (const row of rows) {
    const type = row.question_type ?? "unknown";
    byType.set(type, [...(byType.get(type) ?? []), row]);
  }

  return [...byType.entries()]
    .map(([questionType, typeRows]) => {
      const judged = typeRows.filter((row) => row.correct !== undefined);
      const recalled = typeRows.filter((row) => row.retrieved_evidence_summaries.length > 0).length;
      const latencies = typeRows.map((row) => row.latency_ms);
      return {
        questionType,
        rows: typeRows,
        accuracy: judged.length > 0
          ? judged.filter((row) => row.correct).length / judged.length
          : undefined,
        recall: typeRows.length === 0 ? 0 : recalled / typeRows.length,
        p50Latency: percentile(latencies, 0.5),
        p95Latency: percentile(latencies, 0.95),
        suggestedNextFix: suggestedNextFix(typeRows),
      };
    })
    .sort((a, b) => a.questionType.localeCompare(b.questionType));
}

function guessFailureBucket(item: LongMemEvalDebugItem): FailureBucket {
  const type = item.question_type?.toLowerCase() ?? "";
  const hypothesis = item.hypothesis.toLowerCase();
  const evidenceCount = item.evidence_summaries?.length ?? item.retrieved_memory_ids?.length ?? 0;

  if (evidenceCount === 0 || item.context_chars === 0) {
    return "retrieval_miss";
  }
  if (type.includes("temporal")) {
    return "temporal_calc";
  }
  if (type.includes("knowledge-update")) {
    return "stale_update";
  }
  if (/\b(?:i don't know|unknown|insufficient|not enough)\b/.test(hypothesis)) {
    return "abstention";
  }
  return "answer_miss";
}

function suggestedNextFix(rows: LongMemEvalErrorRow[]): string {
  const counts = new Map<FailureBucket, number>();
  for (const row of rows) {
    if (row.failure_bucket_guess) {
      counts.set(row.failure_bucket_guess, (counts.get(row.failure_bucket_guess) ?? 0) + 1);
    }
  }

  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  switch (top) {
    case "retrieval_miss":
      return "improve recall or adaptive k";
    case "temporal_calc":
      return "improve temporal evidence + answer math";
    case "stale_update":
      return "improve update invalidation";
    case "abstention":
      return "improve abstention threshold";
    case "answer_miss":
      return "improve answer composer";
    default:
      return "no dominant failure";
  }
}

function labelToBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value > 0;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "correct", "pass"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "incorrect", "wrong", "fail"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatOptionalPercent(value: number | undefined): string {
  return value === undefined ? "n/a" : formatPercent(value);
}

function quote(value: string): string {
  return JSON.stringify(value.length > 140 ? `${value.slice(0, 137)}...` : value);
}
