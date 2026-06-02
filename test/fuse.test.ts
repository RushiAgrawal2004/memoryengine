import { describe, expect, it } from "vitest";
import { rrf } from "../src/read/fuse.js";

describe("rrf", () => {
  it("surfaces documents ranked high in either list", () => {
    const fused = rrf([
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [{ id: "c" }, { id: "d" }, { id: "e" }],
    ]);

    expect(fused.slice(0, 2).map((result) => result.item.id)).toContain("a");
    expect(fused.slice(0, 2).map((result) => result.item.id)).toContain("c");
  });
});
