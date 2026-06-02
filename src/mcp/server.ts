import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { saveMemory, searchMemories } from "../db/memories.js";
import { flagStaleMemories } from "../grounding/staleness.js";
import { remember } from "../write/remember.js";

export function createMemoryMcpServer(): McpServer {
  const server = new McpServer({
    name: "repo-grounded-memory-engine",
    version: "0.1.0",
  });

  server.registerTool(
    "memory.save",
    {
      description: "Save a memory for later retrieval.",
      inputSchema: {
        content: z.string().min(1),
        type: z.string().optional(),
        scope: z.string().optional(),
      },
      outputSchema: {
        id: z.string(),
      },
    },
    async ({ content, type, scope }) => {
      const saved = await saveMemory({ content, type, scope });
      const structuredContent: Record<string, unknown> = { id: saved.id };

      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "memory.search",
    {
      description: "Search active memories with PostgreSQL full-text search.",
      inputSchema: {
        query: z.string().min(1),
        scope: z.string().optional(),
        limit: z.number().int().positive().max(50).optional(),
        asOf: z.string().optional(),
      },
      outputSchema: {
        results: z.array(
          z.object({
            id: z.string(),
            type: z.string(),
            scope: z.string(),
            content: z.string(),
            rank: z.number(),
            createdAt: z.string(),
          }),
        ),
      },
    },
    async ({ query, scope, limit, asOf }) => {
      const structuredContent: Record<string, unknown> = {
        results: await searchMemories({
          query,
          scope,
          limit,
          asOf: asOf ? new Date(asOf) : undefined,
        }),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "memory.remember",
    {
      description: "Capture an episode, extract facts, and apply intelligent memory operations.",
      inputSchema: {
        text: z.string().min(1),
        scope: z.string().optional(),
      },
      outputSchema: {
        episodeId: z.string(),
        facts: z.array(z.string()),
        operations: z.array(
          z.object({
            fact: z.string(),
            op: z.enum(["ADD", "UPDATE", "INVALIDATE", "NOOP"]),
            targetId: z.string().optional(),
            content: z.string(),
            memoryId: z.string().optional(),
          }),
        ),
        graph: z.object({
          entities: z.number(),
          relations: z.number(),
        }),
      },
    },
    async ({ text, scope }) => {
      const result = await remember({ text, scope });
      const structuredContent: Record<string, unknown> = { ...result };

      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "memory.audit",
    {
      description: "Audit memory status and flag stale repo-anchored memories.",
      inputSchema: {
        scope: z.string().min(1),
      },
      outputSchema: {
        active: z.number(),
        invalid: z.number(),
        needsRevalidation: z.number(),
        newlyFlagged: z.number(),
      },
    },
    async ({ scope }) => {
      const audit = await flagStaleMemories(scope);
      const structuredContent: Record<string, unknown> = { ...audit };

      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  return server;
}

export async function runStdioServer(): Promise<void> {
  const server = createMemoryMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  runStdioServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
