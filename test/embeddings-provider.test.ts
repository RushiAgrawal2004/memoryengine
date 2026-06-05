import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedEmbeddings } from "../src/providers/embeddings.js";

describe("HostedEmbeddings", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("batches up to 100 inputs per request", async () => {
    const fetch = mockEmbeddingResponses([
      embeddingsResponse(100, 0),
      embeddingsResponse(5, 100),
    ]);
    const embeddings = await hosted().embed(Array.from({ length: 105 }, (_, index) => `text ${index}`));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(embeddings).toHaveLength(105);
    expect(requestInputs(fetch, 0)).toHaveLength(100);
    expect(requestInputs(fetch, 1)).toHaveLength(5);
  });

  it("retries transient provider failures and honors retry hints", async () => {
    const fetch = mockEmbeddingResponses([
      new Response("quota exceeded; please retry in 0.001s", {
        status: 429,
        statusText: "Too Many Requests",
      }),
      embeddingsResponse(1),
    ]);

    const embeddings = await hosted({ maxRetries: 1 }).embed(["retry me"]);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(embeddings).toEqual([[0.1, 0.2, 0.3]]);
  });

  it("rejects mismatched embedding counts", async () => {
    mockEmbeddingResponses([embeddingsResponse(1)]);

    await expect(hosted().embed(["one", "two"])).rejects.toThrow(
      "Embeddings response count did not match input count",
    );
  });

  it("rejects invalid embedding vectors", async () => {
    mockEmbeddingResponses([
      Response.json({ data: [{ embedding: [] }] }),
    ]);

    await expect(hosted().embed(["bad vector"])).rejects.toThrow(
      "Embeddings response included a missing or invalid embedding vector",
    );
  });
});

function hosted(options: ConstructorParameters<typeof HostedEmbeddings>[3] = {}): HostedEmbeddings {
  return new HostedEmbeddings("test-key", "test-model", "https://embeddings.example/v1", {
    retryDelayMs: 0,
    timeoutMs: 1_000,
    ...options,
  });
}

function embeddingsResponse(count: number, offset = 0): Response {
  return Response.json({
    data: Array.from({ length: count }, (_, index) => ({
      embedding: [offset + index + 0.1, offset + index + 0.2, offset + index + 0.3],
    })),
  });
}

function mockEmbeddingResponses(responses: Response[]): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected fetch call");
    }

    return response;
  });
  globalThis.fetch = fetch as unknown as typeof fetch;
  return fetch;
}

function requestInputs(fetch: ReturnType<typeof vi.fn>, callIndex: number): unknown[] {
  const body = JSON.parse(String(fetch.mock.calls[callIndex]?.[1]?.body)) as { input: unknown[] };
  return body.input;
}
