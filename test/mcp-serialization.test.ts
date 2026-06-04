import { describe, expect, it } from "vitest";
import { ActivateMemoryResult } from "../src/memory/activate.js";
import { serializeActivateResult } from "../src/mcp/server.js";

describe("MCP serialization", () => {
  it("serializes activation dates before structured output validation", () => {
    const startedAt = new Date("2026-06-04T08:30:00.000Z");
    const endedAt = new Date("2026-06-04T08:45:00.000Z");
    const result: ActivateMemoryResult = {
      activated: true,
      scope: "project:test",
      session: {
        id: "session-1",
        scope: "project:test",
        title: "build todo app",
        task: "build todo app",
        agent: "codex",
        status: "active",
        repoRef: null,
        startedAt,
        endedAt,
      },
      query: "todo",
      memories: [
        {
          id: "memory-1",
          type: "semantic",
          scope: "project:test",
          content: "The todo app persists tasks in localStorage.",
          rank: 1,
          createdAt: "2026-06-04 08:00:00+00",
        },
      ],
      dashboardUrl: "http://localhost:3777/viewer",
      instructions: [],
    };

    const serialized = serializeActivateResult(result);
    const session = serialized.session as { startedAt: unknown; endedAt: unknown };
    const memories = serialized.memories as Array<{ createdAt: unknown }>;

    expect(session.startedAt).toBe(startedAt.toISOString());
    expect(session.endedAt).toBe(endedAt.toISOString());
    expect(memories[0]?.createdAt).toBe("2026-06-04 08:00:00+00");
    expect(JSON.stringify(serialized)).toContain(startedAt.toISOString());
  });
});
