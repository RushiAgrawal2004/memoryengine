import * as z from "zod/v4";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedLLM, LocalHeuristicLLM } from "../src/providers/llm.js";

const extractionSchema = z.object({
  facts: z.array(z.object({
    fact: z.string(),
    temporalRefs: z.array(z.object({
      text: z.string(),
      resolvedDate: z.string(),
    })).default([]),
  })),
  entities: z.array(z.object({
    kind: z.string(),
    name: z.string(),
  })).default([]),
  relations: z.array(z.object({
    srcName: z.string(),
    relation: z.string(),
    dstName: z.string(),
    fact: z.string(),
  })).default([]),
});

const batchOpsSchema = z.array(z.object({
  factIndex: z.number(),
  op: z.enum(["ADD", "UPDATE", "INVALIDATE", "NOOP"]),
  content: z.string(),
  targetId: z.string().optional(),
  rationale: z.string().optional(),
}));

describe("HostedLLM", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("repairs top-level fact arrays into the extraction object shape", async () => {
    mockLLMResponses([
      llmResponse(JSON.stringify([
        { fact: "The repo uses pnpm", temporalRefs: [] },
        "Auth logic lives in src/auth.ts",
      ])),
    ]);

    const output = await hosted().json("Extract facts", "Episode text: messy", extractionSchema);

    expect(output).toEqual({
      facts: [
        { fact: "The repo uses pnpm", temporalRefs: [] },
        { fact: "Auth logic lives in src/auth.ts", temporalRefs: [] },
      ],
      entities: [],
      relations: [],
    });
  });

  it("parses JSON from common markdown fences or surrounding prose", async () => {
    mockLLMResponses([
      llmResponse([
        "Sure, here is the JSON:",
        "```json",
        JSON.stringify({ facts: [{ fact: "Use Vitest for tests" }] }),
        "```",
      ].join("\n")),
    ]);

    const output = await hosted().json("Extract facts", "Episode text: tests", extractionSchema);

    expect(output.facts).toEqual([{ fact: "Use Vitest for tests", temporalRefs: [] }]);
  });

  it("uses json_object response format only for object schemas", async () => {
    const fetch = mockLLMResponses([
      llmResponse(JSON.stringify({ facts: [] })),
      llmResponse(JSON.stringify([{ factIndex: 0, op: "ADD", content: "new fact" }])),
    ]);
    const llm = hosted();

    await llm.json("Extract facts", "Episode text: empty", extractionSchema);
    await llm.json("Decide memory operations", "Facts with candidates: []", batchOpsSchema);

    const objectBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    const arrayBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(objectBody.response_format).toEqual({ type: "json_object" });
    expect(arrayBody.response_format).toBeUndefined();
  });

  it("repairs ordered batch operation arrays when the model omits factIndex", async () => {
    mockLLMResponses([
      llmResponse(JSON.stringify([
        { op: "ADD", content: "first fact" },
        { op: "NOOP", targetId: "memory-1", content: "second fact" },
      ])),
    ]);

    const output = await hosted().json(
      "Decide memory operations",
      "Facts with candidates: []",
      batchOpsSchema,
    );

    expect(output).toEqual([
      { factIndex: 0, op: "ADD", content: "first fact" },
      { factIndex: 1, op: "NOOP", targetId: "memory-1", content: "second fact" },
    ]);
  });

  it("retries transient provider failures before returning content", async () => {
    const fetch = mockLLMResponses([
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
      llmResponse(JSON.stringify({ facts: [{ fact: "Retry succeeded" }] })),
    ]);

    const output = await hosted({ maxRetries: 1 }).json(
      "Extract facts",
      "Episode text: retry",
      extractionSchema,
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(output.facts[0]?.fact).toBe("Retry succeeded");
  });

  it("honors provider retry hints from 429 response bodies", async () => {
    const fetch = mockLLMResponses([
      new Response("quota exceeded; please retry in 0.001s", {
        status: 429,
        statusText: "Too Many Requests",
      }),
      llmResponse(JSON.stringify({ facts: [{ fact: "Quota retry succeeded" }] })),
    ]);

    const output = await hosted({ maxRetries: 1 }).json(
      "Extract facts",
      "Episode text: retry hint",
      extractionSchema,
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(output.facts[0]?.fact).toBe("Quota retry succeeded");
  });
});

describe("LocalHeuristicLLM", () => {
  it("extracts role-prefixed chat memories from user turns without assistant boilerplate", async () => {
    const output = await new LocalHeuristicLLM().json(
      "Extract atomic facts",
      [
        "Occurred at: 2026-06-07T00:00:00.000Z",
        "Episode text:",
        "LongMemEval session_id: session-1",
        "LongMemEval session_date: 2026/06/07 (Sun) 10:00",
        "user: I switched the project package manager to pnpm after npm caused lockfile drift.",
        "assistant: Here are ten generic steps you can follow when choosing a package manager.",
        "1. Read documentation.",
        "2. Compare tools.",
        "user: The dashboard should keep trace logs visible for debugging memory decisions.",
      ].join("\n"),
      extractionSchema,
    );

    expect(output.facts.map((fact) => fact.fact)).toEqual([
      "session session-1 at 2026/06/07 (Sun) 10:00: user said I switched the project package manager to pnpm after npm caused lockfile drift.",
      "session session-1 at 2026/06/07 (Sun) 10:00: user said The dashboard should keep trace logs visible for debugging memory decisions.",
    ]);
  });
});

function hosted(options: ConstructorParameters<typeof HostedLLM>[3] = {}): HostedLLM {
  return new HostedLLM("test-key", "test-model", "https://llm.example/v1", {
    retryDelayMs: 0,
    timeoutMs: 1_000,
    ...options,
  });
}

function llmResponse(content: string): Response {
  return Response.json({
    choices: [
      {
        message: {
          content,
        },
      },
    ],
  });
}

function mockLLMResponses(responses: Response[]): ReturnType<typeof vi.fn> {
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
