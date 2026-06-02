import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { saveMemory, searchMemories } from "../db/memories.js";

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
    async ({ query, scope, limit }) => {
      const structuredContent: Record<string, unknown> = {
        results: await searchMemories({ query, scope, limit }),
      };

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
