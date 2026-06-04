import * as z from "zod/v4";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { getSqlClient, closeDb } from "../src/db/client.js";
import { config } from "../src/lib/config.js";
import { getLLM } from "../src/providers/llm.js";
import { retrieve } from "../src/read/retrieve.js";
import { remember } from "../src/write/remember.js";

export interface BenchmarkProbe {
  question: string;
  expectedKeywords: string[];
  expectedAnswer?: string;
  k?: number;
}

export interface BenchmarkItem {
  id: string;
  sessions: string[];
  probes: BenchmarkProbe[];
}

export interface EvalOptions {
  items?: BenchmarkItem[];
  modes?: EvalMode[];
  scratchPrefix?: string;
  datasetName?: string;
  contextWindowSessions?: number;
  requireHostedJudge?: boolean;
  requireReportable?: boolean;
  minReportableProbes?: number;
}

export interface EvalModeResult {
  mode: EvalMode;
  dataset: string;
  reportable: boolean;
  items: number;
  probes: number;
  recallAtK: number;
  answerAccuracy: number;
  p50ContextChars: number;
  p95ContextChars: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export type EvalMode = "with-memory" | "context-baseline" | "empty-baseline";

export interface EvalReport {
  generatedAt: string;
  dataset: string;
  modes: EvalMode[];
  items: number;
  probes: number;
  reportable: boolean;
  minReportableProbes: number;
  results: EvalModeResult[];
}

export interface EvalOutput {
  markdown: string;
  jsonPath: string;
  markdownPath: string;
}

interface ProbeResult {
  recalled: boolean;
  correct: boolean;
  contextChars: number;
  latencyMs: number;
}

const DEFAULT_K = 5;
const DEFAULT_CONTEXT_WINDOW_SESSIONS = 5;
const DEFAULT_MIN_REPORTABLE_PROBES = 50;
const DEFAULT_DATASET_DIR = path.join(process.cwd(), "eval", "datasets");
const DEFAULT_RESULTS_DIR = path.join(process.cwd(), "eval", "results");

const judgeSchema = z.object({
  correct: z.boolean(),
  rationale: z.string().optional(),
});

export const codingBenchmark: BenchmarkItem[] = [
  {
    id: "package-manager-decision",
    sessions: [
      "The repository package scripts are run with pnpm.",
      "CI should use pnpm install before running tests.",
    ],
    probes: [
      {
        question: "Which package manager should run repository scripts?",
        expectedKeywords: ["pnpm"],
      },
    ],
  },
  {
    id: "test-runner-choice",
    sessions: [
      "Unit tests use Vitest.",
      "CI runs npm test -- --run before release.",
    ],
    probes: [
      {
        question: "Which test runner does the project use?",
        expectedKeywords: ["Vitest"],
      },
    ],
  },
  {
    id: "auth-dependency-chain",
    sessions: [
      "auth.ts calls verifyToken.",
      "verifyToken depends on jwtlib.",
      "The login route delegates token checks to auth.ts.",
    ],
    probes: [
      {
        question: "What dependency does verifyToken depend on?",
        expectedKeywords: ["jwtlib"],
      },
    ],
  },
  {
    id: "token-library-change",
    sessions: [
      "The first auth prototype used jsonwebtoken.",
      "We switched auth token verification to jose for Edge compatibility.",
    ],
    probes: [
      {
        question: "Which token library should auth use now?",
        expectedKeywords: ["jose"],
      },
    ],
  },
  {
    id: "migration-tooling",
    sessions: [
      "Database schema changes are managed by drizzle-kit migrations.",
      "The local store uses PostgreSQL for persistence.",
    ],
    probes: [
      {
        question: "What tool handles schema migrations?",
        expectedKeywords: ["drizzle-kit"],
      },
    ],
  },
  {
    id: "database-choice",
    sessions: [
      "The memory engine stores durable state in PostgreSQL.",
      "Local development uses postgres://memory_engine:memory_engine@localhost:5432/memory_engine.",
    ],
    probes: [
      {
        question: "Which database stores durable memory state?",
        expectedKeywords: ["postgres"],
      },
    ],
  },
  {
    id: "repo-grounding",
    sessions: [
      "Every code-derived memory should carry repo refs and anchors.",
      "Staleness is detected by comparing anchored file commits against the latest file commit.",
    ],
    probes: [
      {
        question: "How does the system detect stale code memories?",
        expectedKeywords: ["anchored", "commit"],
      },
    ],
  },
  {
    id: "graph-builder-boundary",
    sessions: [
      "Graphify-style use-case graph building is outsourced.",
      "This repo owns repo-grounded memory, graph persistence, retrieval, and validation.",
    ],
    probes: [
      {
        question: "Who owns Graphify-style use-case graph building?",
        expectedKeywords: ["outsourced"],
      },
    ],
  },
];

export async function runEval(options: EvalOptions = {}): Promise<EvalModeResult[]> {
  const items = options.items ?? codingBenchmark;
  const modes = options.modes ?? ["context-baseline", "with-memory"];
  const scratchPrefix = options.scratchPrefix ?? `eval:${Date.now()}`;
  const dataset = options.datasetName ?? "coding-smoke";
  const minReportableProbes = options.minReportableProbes ?? DEFAULT_MIN_REPORTABLE_PROBES;
  const probeCount = countProbes(items);
  const reportable = probeCount >= minReportableProbes;

  if (options.requireReportable && !reportable) {
    throw new Error(
      `Eval dataset has ${probeCount} probes; reportable runs require at least ${minReportableProbes}.`,
    );
  }

  if (options.requireHostedJudge && config.llmProvider !== "hosted") {
    throw new Error("Reportable evals require LLM_PROVIDER=hosted so judging uses a real hosted LLM.");
  }

  const results: EvalModeResult[] = [];

  for (const mode of modes) {
    const probeResults: ProbeResult[] = [];

    for (const item of items) {
      const scope = `${scratchPrefix}:${mode}:${item.id}`;
      await resetScratchScope(scope);

      if (mode === "with-memory") {
        for (const session of item.sessions) {
          await remember({ text: session, scope });
        }
      }

      for (const probe of item.probes) {
        probeResults.push(await runProbe(scope, item, probe, mode, options));
      }

      await resetScratchScope(scope);
    }

    results.push(summarizeMode(mode, dataset, reportable, items.length, probeResults));
  }

  return results;
}

export async function loadLoCoMoDatasets(
  datasetDir = DEFAULT_DATASET_DIR,
): Promise<BenchmarkItem[]> {
  const entries = await readdir(datasetDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(datasetDir, entry.name))
    .sort();
  const items: BenchmarkItem[] = [];

  for (const file of files) {
    const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    items.push(...normalizeDatasetItems(raw, path.basename(file, ".json")));
  }

  return items;
}

export function createEvalReport(
  results: EvalModeResult[],
  options: {
    dataset?: string;
    minReportableProbes?: number;
    generatedAt?: Date;
  } = {},
): EvalReport {
  const probes = results[0]?.probes ?? 0;
  const minReportableProbes = options.minReportableProbes ?? DEFAULT_MIN_REPORTABLE_PROBES;

  return {
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    dataset: options.dataset ?? results[0]?.dataset ?? "unknown",
    modes: results.map((result) => result.mode),
    items: results[0]?.items ?? 0,
    probes,
    reportable: probes >= minReportableProbes,
    minReportableProbes,
    results,
  };
}

export async function writeEvalOutputs(
  report: EvalReport,
  resultsDir = DEFAULT_RESULTS_DIR,
): Promise<EvalOutput> {
  await mkdir(resultsDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const base = `${safeFileName(report.dataset)}-${stamp}`;
  const jsonPath = path.join(resultsDir, `${base}.json`);
  const markdownPath = path.join(resultsDir, `${base}.md`);
  const markdown = formatResultsTable(report.results);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, `${markdown}\n`);

  return { markdown, jsonPath, markdownPath };
}

export function formatResultsTable(results: EvalModeResult[]): string {
  const lines = [
    "| Mode | Dataset | Reportable | Items | Probes | Recall@k | Answer accuracy | p50 context | p95 context | p50 latency | p95 latency |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const result of results) {
    lines.push(
      `| ${result.mode} | ${result.dataset} | ${result.reportable ? "yes" : "no"} | ${result.items} | ${result.probes} | ${percent(result.recallAtK)} | ${percent(result.answerAccuracy)} | ${result.p50ContextChars} chars | ${result.p95ContextChars} chars | ${Math.round(result.p50LatencyMs)}ms | ${Math.round(result.p95LatencyMs)}ms |`,
    );
  }

  return lines.join("\n");
}

async function runProbe(
  scope: string,
  item: BenchmarkItem,
  probe: BenchmarkProbe,
  mode: EvalMode,
  options: EvalOptions,
): Promise<ProbeResult> {
  const started = performance.now();
  const context = await contextForProbe(scope, item, probe, mode, options);
  const latencyMs = performance.now() - started;
  const recalled = containsAllKeywords(context, probe.expectedKeywords);
  const judgment = await judgeAnswer(
    probe.question,
    context,
    probe.expectedKeywords,
    probe.expectedAnswer,
  );

  return {
    recalled,
    correct: judgment.correct,
    contextChars: context.length,
    latencyMs,
  };
}

async function contextForProbe(
  scope: string,
  item: BenchmarkItem,
  probe: BenchmarkProbe,
  mode: EvalMode,
  options: EvalOptions,
): Promise<string> {
  if (mode === "empty-baseline") {
    return "";
  }

  if (mode === "context-baseline") {
    return recentHistoryContext(item.sessions, options.contextWindowSessions);
  }

  const docs = await retrieve({ query: probe.question, scope, topN: probe.k ?? DEFAULT_K });
  return docs.map((doc) => doc.content).join("\n");
}

async function judgeAnswer(
  question: string,
  context: string,
  expectedKeywords: string[],
  expectedAnswer?: string,
): Promise<{ correct: boolean }> {
  const judgment = await getLLM().json(
    "You are an evaluation judge for memory retrieval. Decide if the retrieved context answers the question.",
    [
      `Question: ${question}`,
      "Retrieved context:",
      context || "(empty)",
      expectedAnswer ? `Expected answer: ${expectedAnswer}` : undefined,
      expectedKeywords.length > 0
        ? `Expected answer keywords: ${JSON.stringify(expectedKeywords)}`
        : undefined,
      expectedKeywords.length === 0 ? "Expected answer keywords: []" : undefined,
    ].join("\n"),
    judgeSchema,
  );

  return { correct: judgment.correct };
}

function summarizeMode(
  mode: EvalMode,
  dataset: string,
  reportable: boolean,
  items: number,
  probeResults: ProbeResult[],
): EvalModeResult {
  const probes = probeResults.length;
  const recalled = probeResults.filter((result) => result.recalled).length;
  const correct = probeResults.filter((result) => result.correct).length;
  const latencies = probeResults.map((result) => result.latencyMs);
  const contextSizes = probeResults.map((result) => result.contextChars);

  return {
    mode,
    dataset,
    reportable,
    items,
    probes,
    recallAtK: probes === 0 ? 0 : recalled / probes,
    answerAccuracy: probes === 0 ? 0 : correct / probes,
    p50ContextChars: Math.round(percentile(contextSizes, 0.5)),
    p95ContextChars: Math.round(percentile(contextSizes, 0.95)),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
  };
}

function normalizeDatasetItems(raw: unknown, datasetName: string): BenchmarkItem[] {
  const records = Array.isArray(raw)
    ? raw
    : objectValue(raw, "items", "data", "examples", "conversations") ?? [];

  if (!Array.isArray(records)) {
    throw new Error(`Dataset ${datasetName} must be a JSON array or object with items/data/examples.`);
  }

  return records.map((record, index) => normalizeDatasetItem(record, `${datasetName}-${index + 1}`));
}

function normalizeDatasetItem(raw: unknown, fallbackId: string): BenchmarkItem {
  const id = stringValue(raw, "id", "uid", "question_id", "conversation_id") ?? fallbackId;
  const sessions = normalizeSessions(
    objectValue(
      raw,
      "sessions",
      "session_history",
      "conversation",
      "conversations",
      "messages",
      "history",
    ),
  );
  const probes = normalizeProbes(
    objectValue(raw, "probes", "questions", "qas", "qa", "question"),
  );

  if (sessions.length === 0) {
    throw new Error(`Dataset item ${id} has no session history.`);
  }

  if (probes.length === 0) {
    throw new Error(`Dataset item ${id} has no probes/questions.`);
  }

  return { id, sessions, probes };
}

function normalizeSessions(raw: unknown): string[] {
  if (typeof raw === "string") {
    return [raw];
  }

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }

      const direct = stringValue(entry, "text", "content", "summary", "utterance");
      if (direct) {
        return direct;
      }

      const messages = objectValue(entry, "messages", "turns", "dialogue");
      return Array.isArray(messages) ? formatMessages(messages) : "";
    })
    .filter(Boolean);
}

function normalizeProbes(raw: unknown): BenchmarkProbe[] {
  const records = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const probes: BenchmarkProbe[] = [];

  for (const entry of records) {
    if (typeof entry === "string") {
      probes.push({ question: entry, expectedKeywords: [] });
      continue;
    }

    const question = stringValue(entry, "question", "query", "q", "prompt");
    if (!question) {
      continue;
    }

    const expectedAnswer = stringValue(entry, "answer", "expected_answer", "target", "gold");
    const keywords = stringArrayValue(entry, "expectedKeywords", "expected_keywords", "keywords")
      ?? (expectedAnswer ? keywordsFromAnswer(expectedAnswer) : []);

    probes.push({
      question,
      ...(expectedAnswer ? { expectedAnswer } : {}),
      expectedKeywords: keywords,
      ...(numberValue(entry, "k", "top_k") ? { k: numberValue(entry, "k", "top_k") } : {}),
    });
  }

  return probes;
}

function formatMessages(messages: unknown[]): string {
  return messages
    .map((message) => {
      if (typeof message === "string") {
        return message;
      }
      const speaker = stringValue(message, "speaker", "role", "name") ?? "speaker";
      const text = stringValue(message, "text", "content", "utterance", "message") ?? "";
      return text ? `${speaker}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function recentHistoryContext(sessions: string[], windowSessions = DEFAULT_CONTEXT_WINDOW_SESSIONS): string {
  return sessions.slice(-windowSessions).join("\n");
}

function countProbes(items: BenchmarkItem[]): number {
  return items.reduce((sum, item) => sum + item.probes.length, 0);
}

function keywordsFromAnswer(answer: string): string[] {
  const tokens = answer
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_.-]*/g) ?? [];
  const stopwords = new Set(["the", "and", "for", "that", "with", "this", "from", "was", "were"]);
  return [...new Set(tokens.filter((token) => token.length > 2 && !stopwords.has(token)))].slice(0, 8);
}

function objectValue(raw: unknown, ...keys: string[]): unknown {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const object = raw as Record<string, unknown>;
  return keys.map((key) => object[key]).find((value) => value !== undefined);
}

function stringValue(raw: unknown, ...keys: string[]): string | undefined {
  const value = objectValue(raw, ...keys);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(raw: unknown, ...keys: string[]): string[] | undefined {
  const value = objectValue(raw, ...keys);
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function numberValue(raw: unknown, ...keys: string[]): number | undefined {
  const value = objectValue(raw, ...keys);
  return typeof value === "number" ? value : undefined;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "eval";
}

async function resetScratchScope(scope: string): Promise<void> {
  const sql = getSqlClient();
  await sql`delete from edges where scope = ${scope}`;
  await sql`delete from entities where scope = ${scope}`;
  await sql`delete from memories where scope = ${scope}`;
  await sql`delete from episodes where scope = ${scope}`;
}

function containsAllKeywords(value: string, keywords: string[]): boolean {
  const lower = value.toLowerCase();
  return keywords.every((keyword) => lower.includes(keyword.toLowerCase()));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

if (process.argv[1]?.endsWith("harness.ts") || process.argv[1]?.endsWith("harness.js")) {
  const args = process.argv.slice(2);
  const datasetDir = valueAfter(args, "--datasets") ?? DEFAULT_DATASET_DIR;
  const resultsDir = valueAfter(args, "--results") ?? DEFAULT_RESULTS_DIR;
  const datasetName = valueAfter(args, "--dataset-name") ?? "locomo";

  loadLoCoMoDatasets(datasetDir)
    .then((items) => items.length > 0 ? items : codingBenchmark)
    .then((items) => runEval({
      items,
      datasetName: items === codingBenchmark ? "coding-smoke" : datasetName,
      requireHostedJudge: items !== codingBenchmark,
      requireReportable: items !== codingBenchmark,
    }))
    .then(async (results) => {
      const report = createEvalReport(results, { dataset: results[0]?.dataset });
      const output = await writeEvalOutputs(report, resultsDir);
      console.log(output.markdown);
      console.log(`\nJSON results: ${output.jsonPath}`);
      console.log(`Markdown results: ${output.markdownPath}`);
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
