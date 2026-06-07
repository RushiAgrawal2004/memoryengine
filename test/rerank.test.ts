import { describe, expect, it } from "vitest";
import { NoopReranker } from "../src/providers/rerank.js";

describe("local lexical reranker", () => {
  it("prefers the candidate with stronger lexical overlap", async () => {
    const reranker = new NoopReranker();
    const results = await reranker.rerank(
      "first issue new car service",
      [
        "The detailer had good online reviews.",
        "The first issue after the new car service was the GPS system failing.",
      ],
      1,
    );

    expect(results).toEqual([{ index: 1, score: expect.any(Number) }]);
  });
});
