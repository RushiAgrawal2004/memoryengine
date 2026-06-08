import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { promisify } from "node:util";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { config } from "../src/lib/config.js";
import { answerQuestion } from "../src/read/answer.js";
import { retrieve } from "../src/read/retrieve.js";
import { remember } from "../src/write/remember.js";
import { writeLongMemEvalDiagnostics } from "./longmemeval-diagnostics.js";
import { loadLongMemEvalDatasets } from "./harness.js";

const execFileAsync = promisify(execFile);

export interface LongMemEvalOfficialOptions {
  file?: string;
  limit?: number;
  splitName?: string;
  out?: string;
  allowLocal?: boolean;
  scratchPrefix?: string;
  officialJudge?: boolean;
  judgeModel?: string;
  longMemEvalRepo?: string;
  pythonCommand?: string;
}

export interface LongMemEvalOfficialOutput {
  official: boolean;
  splitName: string;
  items: number;
  hypothesesPath: string;
  debugPath: string;
  errorsPath: string;
  diagnosticsPath: string;
  officialJudge?: OfficialJudgeResult;
}

export interface OfficialJudgeCommand {
  command: string;
  args: string[];
  cwd: string;
  expectedLogPath: string;
}

export interface OfficialJudgeMetrics {
  overallAccuracy?: number;
  total?: number;
  correct?: number;
  perCategory: Array<{
    category: string;
    accuracy: number;
    total: number;
    correct: number;
  }>;
}

export interface OfficialJudgeResult {
  model: string;
  datasetPath: string;
  command: OfficialJudgeCommand;
  logPath: string;
  stdoutPath: string;
  stderrPath: string;
  summaryPath: string;
  metrics: OfficialJudgeMetrics;
}

interface DebugRow {
  question_id: string;
  question_type?: string;
  retrieved_memory_ids: string[];
  evidence_summaries: string[];
  source_session_ids: string[];
  context_chars: number;
  latency_ms: number;
  hypothesis: string;
  gold_answer?: string;
  local_run: boolean;
}

const DEFAULT_DATASET_DIR = path.join(process.cwd(), "eval", "datasets");
const DEFAULT_OUT_DIR = path.join(process.cwd(), "eval", "results", "longmemeval-official");

export async function runLongMemEvalOfficial(
  options: LongMemEvalOfficialOptions = {},
): Promise<LongMemEvalOfficialOutput> {
  const splitName = options.splitName ?? "longmemeval";
  const outDir = options.out ?? path.join(DEFAULT_OUT_DIR, `${splitName}-${Date.now()}`);
  const official = isOfficialProviderRun();

  if (!official && !options.allowLocal) {
    throw new Error(
      "LongMemEval official runs require hosted LLM and embeddings. Pass --allow-local for non-official development runs.",
    );
  }

  const items = (await loadLongMemEvalDatasets(options.file ?? DEFAULT_DATASET_DIR))
    .slice(0, options.limit);
  await mkdir(outDir, { recursive: true });

  const hypotheses: string[] = [];
  const debug: DebugRow[] = [];
  const scratchPrefix = options.scratchPrefix ?? `longmemeval-official:${Date.now()}`;

  for (const item of items) {
    const scope = `${scratchPrefix}:${item.id}`;
    await resetScratchScope(scope);
    try {
      for (const session of item.sessions) {
        await remember({ text: session, scope });
      }

      const probe = item.probes[0];
      if (!probe) {
        continue;
      }

      const started = performance.now();
      const memories = await retrieve({
        query: probe.question,
        scope,
        topN: probe.k ?? 5,
      });
      const evidence = memories.map((memory) => memory.content);
      const evidenceDetails = await evidenceDetailsForDebug(memories.map((memory) => memory.id));
      const hypothesis = await answerQuestion({
        question: probe.question,
        evidence,
      });
      const latencyMs = performance.now() - started;

      hypotheses.push(JSON.stringify({
        question_id: item.id,
        hypothesis,
      }));
      debug.push({
        question_id: item.id,
        ...(probe.questionType ? { question_type: probe.questionType } : {}),
        retrieved_memory_ids: memories.map((memory) => memory.id),
        evidence_summaries: memories.map((memory) => summarizeEvidence(memory.content)),
        source_session_ids: sourceSessionIdsForDebug(memories.map((memory) => memory.content), evidenceDetails),
        context_chars: evidence.join("\n").length,
        latency_ms: Math.round(latencyMs),
        hypothesis,
        ...(probe.expectedAnswer ? { gold_answer: probe.expectedAnswer } : {}),
        local_run: !official,
      });
    } finally {
      await resetScratchScope(scope);
    }
  }

  const hypothesesPath = path.join(outDir, "hypotheses.jsonl");
  const debugPath = path.join(outDir, "debug.json");
  await writeFile(hypothesesPath, `${hypotheses.join("\n")}${hypotheses.length ? "\n" : ""}`);
  await writeFile(debugPath, `${JSON.stringify({
    official,
    splitName,
    provider: {
      embeddings: config.embeddingsProvider,
      llm: config.llmProvider,
      reranker: config.rerankProvider,
    },
    items: debug,
  }, null, 2)}\n`);

  const officialJudge = options.officialJudge
    ? await runOfficialLongMemEvalJudge({
        longMemEvalRepo: options.longMemEvalRepo ?? process.env.LONGMEMEVAL_REPO,
        model: options.judgeModel ?? process.env.LONGMEMEVAL_JUDGE_MODEL ?? "gpt-4o",
        datasetPath: options.file ?? DEFAULT_DATASET_DIR,
        hypothesesPath,
        outDir,
        pythonCommand: options.pythonCommand ?? process.env.PYTHON ?? "python",
      })
    : undefined;
  const diagnostics = await writeLongMemEvalDiagnostics({
    debugPath,
    officialLog: officialJudge ? await readFile(officialJudge.logPath, "utf8").catch(() => undefined) : undefined,
    outDir,
  });

  return {
    official,
    splitName,
    items: debug.length,
    hypothesesPath,
    debugPath,
    errorsPath: diagnostics.errorsPath,
    diagnosticsPath: diagnostics.markdownPath,
    ...(officialJudge ? { officialJudge } : {}),
  };
}

async function evidenceDetailsForDebug(memoryIds: string[]): Promise<Map<string, {
  sourceSessionId?: string;
  sourceSession?: string;
}>> {
  if (memoryIds.length === 0) {
    return new Map();
  }

  const sql = getSqlClient();
  const rows = await sql<Array<{
    id: string;
    sourceSession: string | null;
    sourceSessionId: string | null;
  }>>`
    select
      id,
      source_session::text as "sourceSession",
      attrs->'observation'->>'sourceSessionId' as "sourceSessionId"
    from memories
    where id in ${sql(memoryIds)}
  `;

  return new Map(rows.map((row) => [
    row.id,
    {
      ...(row.sourceSessionId ? { sourceSessionId: row.sourceSessionId } : {}),
      ...(row.sourceSession ? { sourceSession: row.sourceSession } : {}),
    },
  ]));
}

function sourceSessionIdsForDebug(
  evidence: string[],
  details: Map<string, { sourceSessionId?: string; sourceSession?: string }>,
): string[] {
  const fromDetails = [...details.values()]
    .map((detail) => detail.sourceSessionId ?? detail.sourceSession)
    .filter((value): value is string => Boolean(value));
  const fromContent = evidence
    .flatMap((item) => [
      item.match(/\bLongMemEval session_id:\s*([^\s]+)/i)?.[1],
      item.match(/^session\s+([^:\s]+)\b/i)?.[1],
      item.match(/\bsession[_\s-]?id:\s*([a-z0-9_.-]+)/i)?.[1],
    ])
    .filter((value): value is string => Boolean(value));

  return [...new Set([...fromDetails, ...fromContent])].sort();
}

function summarizeEvidence(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 220 ? `${cleaned.slice(0, 217)}...` : cleaned;
}

export function buildOfficialJudgeCommand(input: {
  longMemEvalRepo: string;
  model: string;
  hypothesesPath: string;
  datasetPath: string;
  pythonCommand?: string;
}): OfficialJudgeCommand {
  const repo = path.resolve(input.longMemEvalRepo);
  const hypothesesPath = path.resolve(input.hypothesesPath);
  const datasetPath = path.resolve(input.datasetPath);

  return {
    command: input.pythonCommand ?? "python",
    args: ["evaluate_qa.py", input.model, hypothesesPath, datasetPath],
    cwd: path.join(repo, "src", "evaluation"),
    expectedLogPath: `${hypothesesPath}.log`,
  };
}

export function parseOfficialJudgeLog(
  logText: string,
  datasetRows: Array<{ question_id?: string; question_type?: string }> = [],
): OfficialJudgeMetrics {
  const typeById = new Map(
    datasetRows
      .filter((row) => row.question_id && row.question_type)
      .map((row) => [row.question_id as string, row.question_type as string]),
  );
  const scoredRows: Array<{ category: string; correct: boolean }> = [];

  for (const line of logText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const row = JSON.parse(trimmed) as {
        question_id?: string;
        question_type?: string;
        autoeval_label?: unknown;
      };
      const label = labelToBoolean(row.autoeval_label);
      if (label === undefined) {
        continue;
      }

      scoredRows.push({
        category: row.question_type
          ?? (row.question_id ? typeById.get(row.question_id) : undefined)
          ?? "unknown",
        correct: label,
      });
    } catch {
      continue;
    }
  }

  const categoryCounts = new Map<string, { total: number; correct: number }>();
  for (const row of scoredRows) {
    const current = categoryCounts.get(row.category) ?? { total: 0, correct: 0 };
    current.total += 1;
    current.correct += row.correct ? 1 : 0;
    categoryCounts.set(row.category, current);
  }

  const total = scoredRows.length;
  const correct = scoredRows.filter((row) => row.correct).length;
  const stdoutAccuracy = parsePrintedAccuracy(logText);

  return {
    overallAccuracy: total > 0 ? correct / total : stdoutAccuracy,
    ...(total > 0 ? { total, correct } : {}),
    perCategory: [...categoryCounts.entries()]
      .map(([category, counts]) => ({
        category,
        accuracy: counts.correct / counts.total,
        total: counts.total,
        correct: counts.correct,
      }))
      .sort((a, b) => a.category.localeCompare(b.category)),
  };
}

async function runOfficialLongMemEvalJudge(input: {
  longMemEvalRepo?: string;
  model: string;
  datasetPath: string;
  hypothesesPath: string;
  outDir: string;
  pythonCommand: string;
}): Promise<OfficialJudgeResult> {
  if (!input.longMemEvalRepo) {
    throw new Error("LONGMEMEVAL_REPO is required when --official-judge is passed.");
  }

  const command = buildOfficialJudgeCommand({
    longMemEvalRepo: input.longMemEvalRepo,
    model: input.model,
    hypothesesPath: input.hypothesesPath,
    datasetPath: input.datasetPath,
    pythonCommand: input.pythonCommand,
  });
  const stdoutPath = path.join(input.outDir, "official-judge.stdout.txt");
  const stderrPath = path.join(input.outDir, "official-judge.stderr.txt");
  const logPath = path.join(input.outDir, "official-judge.log");
  const summaryPath = path.join(input.outDir, "official-judge.json");

  const { stdout, stderr } = await execFileAsync(command.command, command.args, {
    cwd: command.cwd,
    maxBuffer: 1024 * 1024 * 64,
    env: process.env,
  });

  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);

  const officialLog = await readFile(command.expectedLogPath, "utf8")
    .catch(() => [stdout, stderr].filter(Boolean).join("\n"));
  await writeFile(logPath, officialLog);

  const datasetRows = await readDatasetRows(input.datasetPath);
  const metrics = parseOfficialJudgeLog(`${stdout}\n${officialLog}`, datasetRows);
  const result: OfficialJudgeResult = {
    model: input.model,
    datasetPath: path.resolve(input.datasetPath),
    command,
    logPath,
    stdoutPath,
    stderrPath,
    summaryPath,
    metrics,
  };

  await writeFile(summaryPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
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

function parsePrintedAccuracy(value: string): number | undefined {
  const match = value.match(/\b(?:overall\s+)?(?:accuracy|score)\s*[:=]\s*(\d+(?:\.\d+)?)\s*%?/i);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed > 1 ? parsed / 100 : parsed;
}

async function readDatasetRows(datasetPath: string): Promise<Array<{ question_id?: string; question_type?: string }>> {
  try {
    const raw = await readFile(datasetPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((row): row is { question_id?: string; question_type?: string } =>
          Boolean(row && typeof row === "object"),
        )
      : [];
  } catch {
    return [];
  }
}

function isOfficialProviderRun(): boolean {
  return config.llmProvider === "hosted" && config.embeddingsProvider === "hosted";
}

async function resetScratchScope(scope: string): Promise<void> {
  const sql = getSqlClient();
  await sql`delete from traces where scope = ${scope}`;
  await sql`delete from edges where scope = ${scope}`;
  await sql`delete from entities where scope = ${scope}`;
  await sql`delete from memories where scope = ${scope}`;
  await sql`delete from episodes where scope = ${scope}`;
  await sql`delete from chat_sessions where scope = ${scope}`;
}

if (process.argv[1]?.endsWith("longmemeval-official.ts") || process.argv[1]?.endsWith("longmemeval-official.js")) {
  const args = process.argv.slice(2);
  runLongMemEvalOfficial({
    file: valueAfter(args, "--file"),
    limit: numberAfter(args, "--limit"),
    splitName: valueAfter(args, "--split-name"),
    out: valueAfter(args, "--out"),
    allowLocal: args.includes("--allow-local"),
    officialJudge: args.includes("--official-judge"),
    judgeModel: valueAfter(args, "--judge-model"),
    longMemEvalRepo: valueAfter(args, "--longmemeval-repo"),
    pythonCommand: valueAfter(args, "--python"),
  })
    .then((output) => {
      console.log(JSON.stringify(output, null, 2));
      if (!output.official) {
        console.warn("[memory-engine] LongMemEval run is non-official because local/dev providers were allowed.");
      }
    })
    .finally(async () => {
      await closeDb();
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function numberAfter(args: string[], flag: string): number | undefined {
  const value = valueAfter(args, flag);
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}
