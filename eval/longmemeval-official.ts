import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { config } from "../src/lib/config.js";
import { answerQuestion } from "../src/read/answer.js";
import { retrieve } from "../src/read/retrieve.js";
import { remember } from "../src/write/remember.js";
import { loadLongMemEvalDatasets } from "./harness.js";

export interface LongMemEvalOfficialOptions {
  file?: string;
  limit?: number;
  splitName?: string;
  out?: string;
  allowLocal?: boolean;
  scratchPrefix?: string;
}

export interface LongMemEvalOfficialOutput {
  official: boolean;
  splitName: string;
  items: number;
  hypothesesPath: string;
  debugPath: string;
}

interface DebugRow {
  question_id: string;
  question_type?: string;
  retrieved_memory_ids: string[];
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

  return {
    official,
    splitName,
    items: debug.length,
    hypothesesPath,
    debugPath,
  };
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
