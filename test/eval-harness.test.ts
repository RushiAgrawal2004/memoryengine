import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/db/client.js";
import {
  createEvalReport,
  formatResultsTable,
  loadLoCoMoDatasets,
  runEval,
  writeEvalOutputs,
} from "../eval/harness.js";

describe("eval harness", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("compares memory retrieval against a fair context baseline", async () => {
    const results = await runEval({
      scratchPrefix: `test-eval:${crypto.randomUUID()}`,
    });
    const baseline = results.find((result) => result.mode === "context-baseline");
    const withMemory = results.find((result) => result.mode === "with-memory");

    expect(baseline?.answerAccuracy).toBeGreaterThan(0);
    expect(withMemory?.answerAccuracy).toBeGreaterThan(0);
    expect(withMemory?.p50ContextChars ?? Number.POSITIVE_INFINITY).toBeLessThan(
      baseline?.p50ContextChars ?? 0,
    );
    expect(formatResultsTable(results)).toContain("Recall@k");
  }, 30000);

  it("loads LoCoMo-style datasets and writes markdown plus JSON results", async () => {
    const datasetDir = await makeTempDir("memoryengine-eval-datasets-");
    const resultsDir = await makeTempDir("memoryengine-eval-results-");

    await writeFile(
      path.join(datasetDir, "sample.json"),
      JSON.stringify({
        items: [
          {
            id: "conversation-1",
            sessions: [
              {
                messages: [
                  { speaker: "user", text: "Rushi prefers pnpm for this repo." },
                  { speaker: "assistant", text: "Noted for future setup commands." },
                ],
              },
            ],
            questions: [
              {
                question: "Which package manager does Rushi prefer?",
                answer: "pnpm",
              },
            ],
          },
        ],
      }),
    );

    const items = await loadLoCoMoDatasets(datasetDir);
    const results = await runEval({
      items,
      datasetName: "sample",
      modes: ["context-baseline"],
      scratchPrefix: `test-eval-dataset:${crypto.randomUUID()}`,
      minReportableProbes: 50,
    });
    const report = createEvalReport(results, {
      dataset: "sample",
      generatedAt: new Date("2026-06-04T00:00:00.000Z"),
    });
    const output = await writeEvalOutputs(report, resultsDir);
    const json = JSON.parse(await readFile(output.jsonPath, "utf8")) as typeof report;

    expect(items).toHaveLength(1);
    expect(items[0]?.sessions[0]).toContain("Rushi prefers pnpm");
    expect(items[0]?.probes[0]?.expectedKeywords).toContain("pnpm");
    expect(results[0]?.reportable).toBe(false);
    expect(output.markdown).toContain("| context-baseline | sample | no |");
    expect(json.dataset).toBe("sample");
    expect(await readFile(output.markdownPath, "utf8")).toContain("Recall@k");
  });

  it("requires at least 50 probes for reportable runs", async () => {
    await expect(
      runEval({
        items: [
          {
            id: "tiny",
            sessions: ["One useful fact: use pnpm."],
            probes: [{ question: "What package manager?", expectedKeywords: ["pnpm"] }],
          },
        ],
        modes: ["context-baseline"],
        requireReportable: true,
      }),
    ).rejects.toThrow("reportable runs require at least 50");
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
});
