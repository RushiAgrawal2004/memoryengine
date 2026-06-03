import { describe, expect, it } from "vitest";
import { vectorLiteral } from "../src/db/embedding-vectors.js";

describe("pgvector helpers", () => {
  it("formats embeddings as pgvector literals and sanitizes non-finite numbers", () => {
    expect(vectorLiteral([0.1, Number.NaN, Number.POSITIVE_INFINITY, -0.2])).toBe(
      "[0.1,0,0,-0.2]",
    );
  });
});
