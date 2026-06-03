import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../src/db/client.js";
import { formatResultsTable, runEval } from "../eval/harness.js";

describe("eval harness", () => {
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
    expect(formatResultsTable(results)).toContain("Recall/coverage");
  }, 30000);
});
