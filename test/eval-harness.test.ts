import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../src/db/client.js";
import { formatResultsTable, runEval } from "../eval/harness.js";

describe("eval harness", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("reports better accuracy with memory enabled", async () => {
    const results = await runEval({
      scratchPrefix: `test-eval:${crypto.randomUUID()}`,
    });
    const without = results.find((result) => result.mode === "without-memory");
    const withMemory = results.find((result) => result.mode === "with-memory");

    expect(without?.answerAccuracy).toBe(0);
    expect(withMemory?.answerAccuracy).toBeGreaterThan(without?.answerAccuracy ?? 0);
    expect(formatResultsTable(results)).toContain("| Mode | Items | Probes |");
  }, 20000);
});
