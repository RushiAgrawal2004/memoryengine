import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedEmbeddings, LocalEmbeddings } from "../src/providers/embeddings.js";

describe("hosted embeddings provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks hosted embeddings as semantic and local embeddings as non-semantic", () => {
    expect(new HostedEmbeddings("test-key").semantic).toBe(true);
    expect(new LocalEmbeddings().semantic).toBe(false);
  });

  it("calls the configured hosted embeddings endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        data: [
          { embedding: [0.1, 0.2, 0.3] },
          { embedding: [0.4, 0.5, 0.6] },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const embeddings = new HostedEmbeddings(
      "test-key",
      "test-model",
      "https://embeddings.example.test/v1",
    );
    const vectors = await embeddings.embed(["one", "two"]);

    expect(vectors).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://embeddings.example.test/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-key",
        }),
      }),
    );
  });

  it.skipIf(!process.env.RUN_HOSTED_SMOKE || !process.env.EMBEDDINGS_API_KEY)(
    "reaches the real hosted embeddings provider when explicitly enabled",
    async () => {
      const embeddings = new HostedEmbeddings();
      const vectors = await embeddings.embed(["hosted embeddings smoke test"]);

      expect(vectors[0]?.length).toBeGreaterThan(0);
    },
  );
});
