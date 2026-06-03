import * as z from "zod/v4";
import { performance } from "node:perf_hooks";
import { getSqlClient, closeDb } from "../src/db/client.js";
import { getLLM } from "../src/providers/llm.js";
import { retrieve } from "../src/read/retrieve.js";
import { remember } from "../src/write/remember.js";

export interface BenchmarkProbe {
  question: string;
  expectedKeywords: string[];
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
}

export interface EvalModeResult {
  mode: EvalMode;
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

interface ProbeResult {
  recalled: boolean;
  correct: boolean;
  contextChars: number;
  latencyMs: number;
}

const DEFAULT_K = 5;

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
        probeResults.push(await runProbe(scope, item, probe, mode));
      }

      await resetScratchScope(scope);
    }

    results.push(summarizeMode(mode, items.length, probeResults));
  }

  return results;
}

export function formatResultsTable(results: EvalModeResult[]): string {
  const lines = [
    "| Mode | Items | Probes | Recall/coverage | Answer accuracy | p50 context | p95 context | p50 latency | p95 latency |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const result of results) {
    lines.push(
      `| ${result.mode} | ${result.items} | ${result.probes} | ${percent(result.recallAtK)} | ${percent(result.answerAccuracy)} | ${result.p50ContextChars} chars | ${result.p95ContextChars} chars | ${Math.round(result.p50LatencyMs)}ms | ${Math.round(result.p95LatencyMs)}ms |`,
    );
  }

  return lines.join("\n");
}

async function runProbe(
  scope: string,
  item: BenchmarkItem,
  probe: BenchmarkProbe,
  mode: EvalMode,
): Promise<ProbeResult> {
  const started = performance.now();
  const context = await contextForProbe(scope, item, probe, mode);
  const latencyMs = performance.now() - started;
  const recalled = containsAllKeywords(context, probe.expectedKeywords);
  const judgment = await judgeAnswer(probe.question, context, probe.expectedKeywords);

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
): Promise<string> {
  if (mode === "empty-baseline") {
    return "";
  }

  if (mode === "context-baseline") {
    return item.sessions.join("\n");
  }

  const docs = await retrieve({ query: probe.question, scope, topN: probe.k ?? DEFAULT_K });
  return docs.map((doc) => doc.content).join("\n");
}

async function judgeAnswer(
  question: string,
  context: string,
  expectedKeywords: string[],
): Promise<{ correct: boolean }> {
  const judgment = await getLLM().json(
    "You are an evaluation judge for memory retrieval. Decide if the retrieved context answers the question.",
    [
      `Question: ${question}`,
      "Retrieved context:",
      context || "(empty)",
      `Expected answer keywords: ${JSON.stringify(expectedKeywords)}`,
    ].join("\n"),
    judgeSchema,
  );

  return { correct: judgment.correct };
}

function summarizeMode(
  mode: EvalMode,
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
  runEval()
    .then((results) => {
      console.log(formatResultsTable(results));
    })
    .finally(async () => {
      await closeDb();
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
