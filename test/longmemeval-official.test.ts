import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/db/client.js";
import {
  buildOfficialJudgeCommand,
  parseOfficialJudgeLog,
  runLongMemEvalOfficial,
} from "../eval/longmemeval-official.js";

describe("official LongMemEval runner", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("writes hypotheses JSONL and debug output for a LongMemEval-shaped fixture", async () => {
    const datasetDir = await makeTempDir("memoryengine-longmem-official-data-");
    const outDir = await makeTempDir("memoryengine-longmem-official-out-");
    const datasetPath = path.join(datasetDir, "longmemeval_fixture.json");

    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          question_id: "q-fixture",
          question_type: "single-session-user",
          question: "Which package manager does the project use?",
          answer: "pnpm",
          question_date: "2026/06/08 (Mon) 10:00",
          haystack_session_ids: ["s1"],
          haystack_dates: ["2026/06/08 (Mon) 09:00"],
          haystack_sessions: [
            [
              {
                role: "user",
                content: "By the way, the project uses pnpm for package scripts.",
                has_answer: true,
              },
              {
                role: "assistant",
                content: "Noted.",
              },
            ],
          ],
          answer_session_ids: ["s1"],
        },
      ]),
    );

    const output = await runLongMemEvalOfficial({
      file: datasetPath,
      splitName: "fixture",
      out: outDir,
      allowLocal: true,
      scratchPrefix: `test-longmem-official:${crypto.randomUUID()}`,
    });
    const hypotheses = await readFile(output.hypothesesPath, "utf8");
    const debug = JSON.parse(await readFile(output.debugPath, "utf8")) as {
      official: boolean;
      splitName: string;
      items: Array<{
        question_id: string;
        question_type: string;
        retrieved_memory_ids: string[];
        context_chars: number;
        hypothesis: string;
        gold_answer: string;
        local_run: boolean;
      }>;
    };

    expect(output.official).toBe(false);
    expect(output.items).toBe(1);
    expect(hypotheses.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      {
        question_id: "q-fixture",
        hypothesis: expect.any(String),
      },
    ]);
    expect(debug).toMatchObject({
      official: false,
      splitName: "fixture",
      items: [
        {
          question_id: "q-fixture",
          question_type: "single-session-user",
          gold_answer: "pnpm",
          local_run: true,
        },
      ],
    });
    expect(debug.items[0]?.retrieved_memory_ids.length).toBeGreaterThan(0);
    expect(debug.items[0]?.context_chars).toBeGreaterThan(0);
  }, 30000);

  it("constructs the official LongMemEval judge command", () => {
    const command = buildOfficialJudgeCommand({
      longMemEvalRepo: "C:/bench/LongMemEval",
      model: "gpt-4o",
      hypothesesPath: "E:/memoryengine/eval/results/run/hypotheses.jsonl",
      datasetPath: "E:/memoryengine/eval/datasets/longmemeval_s_cleaned.json",
      pythonCommand: "python3",
    });

    expect(command).toEqual({
      command: "python3",
      args: [
        "evaluate_qa.py",
        "gpt-4o",
        path.resolve("E:/memoryengine/eval/results/run/hypotheses.jsonl"),
        path.resolve("E:/memoryengine/eval/datasets/longmemeval_s_cleaned.json"),
      ],
      cwd: path.join(path.resolve("C:/bench/LongMemEval"), "src", "evaluation"),
      expectedLogPath: `${path.resolve("E:/memoryengine/eval/results/run/hypotheses.jsonl")}.log`,
    });
  });

  it("parses official judge JSONL logs into overall and per-category accuracy", () => {
    const metrics = parseOfficialJudgeLog(
      [
        '{"question_id":"q1","autoeval_label":true}',
        '{"question_id":"q2","autoeval_label":false}',
        '{"question_id":"q3","question_type":"temporal-reasoning","autoeval_label":"correct"}',
        "Overall accuracy: 66.7%",
      ].join("\n"),
      [
        { question_id: "q1", question_type: "single-session-user" },
        { question_id: "q2", question_type: "single-session-user" },
      ],
    );

    expect(metrics).toEqual({
      overallAccuracy: 2 / 3,
      total: 3,
      correct: 2,
      perCategory: [
        {
          category: "single-session-user",
          accuracy: 0.5,
          total: 2,
          correct: 1,
        },
        {
          category: "temporal-reasoning",
          accuracy: 1,
          total: 1,
          correct: 1,
        },
      ],
    });
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
});
