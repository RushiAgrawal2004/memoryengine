import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildErrorRows,
  formatDiagnosticsReport,
  parseJudgeLabels,
  writeLongMemEvalDiagnostics,
} from "../eval/longmemeval-diagnostics.js";

describe("LongMemEval diagnostics", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses fake judge logs and creates per-question error rows", () => {
    const labels = parseJudgeLabels([
      '{"question_id":"q1","autoeval_label":true}',
      '{"question_id":"q2","autoeval_label":false}',
      '{"question_id":"q3","autoeval_label":"incorrect"}',
    ].join("\n"));
    const rows = buildErrorRows([
      {
        question_id: "q1",
        question_type: "single-session-user",
        evidence_summaries: ["User said pnpm is the package manager."],
        source_session_ids: ["s1"],
        context_chars: 41,
        latency_ms: 5,
        hypothesis: "pnpm",
        gold_answer: "pnpm",
      },
      {
        question_id: "q2",
        question_type: "temporal-reasoning",
        evidence_summaries: ["Launch was May 1.", "Migration was May 20."],
        source_session_ids: ["s2", "s3"],
        context_chars: 50,
        latency_ms: 9,
        hypothesis: "18 days",
        gold_answer: "19 days",
      },
      {
        question_id: "q3",
        question_type: "knowledge-update",
        evidence_summaries: ["The old package manager was npm."],
        source_session_ids: ["s4"],
        context_chars: 36,
        latency_ms: 4,
        hypothesis: "npm",
        gold_answer: "pnpm",
      },
    ], labels);

    expect(rows).toMatchObject([
      {
        question_id: "q1",
        correct: true,
      },
      {
        question_id: "q2",
        correct: false,
        failure_bucket_guess: "temporal_calc",
      },
      {
        question_id: "q3",
        correct: false,
        failure_bucket_guess: "stale_update",
      },
    ]);
  });

  it("formats diagnostics markdown grouped by question type", () => {
    const markdown = formatDiagnosticsReport([
      {
        question_id: "q1",
        question_type: "single-session-user",
        correct: true,
        gold_answer: "pnpm",
        hypothesis: "pnpm",
        retrieved_evidence_summaries: ["User said pnpm."],
        source_session_ids: ["s1"],
        context_chars: 15,
        latency_ms: 2,
      },
      {
        question_id: "q2",
        question_type: "single-session-user",
        correct: false,
        gold_answer: "Vitest",
        hypothesis: "I don't know.",
        retrieved_evidence_summaries: [],
        source_session_ids: [],
        context_chars: 0,
        latency_ms: 6,
        failure_bucket_guess: "retrieval_miss",
      },
    ]);

    expect(markdown).toContain("| single-session-user | 2 | 50% | 50% |");
    expect(markdown).toContain("## single-session-user Failures");
    expect(markdown).toContain("q2: retrieval_miss");
  });

  it("writes errors.json and diagnostics.md from a debug file and judge log", async () => {
    const outDir = await makeTempDir("memoryengine-longmem-diag-");
    const debugPath = path.join(outDir, "debug.json");
    await writeFile(debugPath, JSON.stringify({
      items: [
        {
          question_id: "q1",
          question_type: "single-session-user",
          retrieved_memory_ids: ["m1"],
          evidence_summaries: ["The project uses pnpm."],
          source_session_ids: ["s1"],
          context_chars: 22,
          latency_ms: 3,
          hypothesis: "pnpm",
          gold_answer: "pnpm",
        },
      ],
    }));

    const output = await writeLongMemEvalDiagnostics({
      debugPath,
      officialLog: '{"question_id":"q1","autoeval_label":true}',
      outDir,
    });

    const errors = JSON.parse(await readFile(output.errorsPath, "utf8"));
    expect(errors).toEqual([
      expect.objectContaining({
        question_id: "q1",
        correct: true,
        retrieved_evidence_summaries: ["The project uses pnpm."],
        source_session_ids: ["s1"],
      }),
    ]);
    expect(await readFile(output.markdownPath, "utf8")).toContain("# LongMemEval Diagnostics");
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
});
