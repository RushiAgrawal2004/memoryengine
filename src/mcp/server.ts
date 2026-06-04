import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { saveMemory, searchMemories } from "../db/memories.js";
import { flagStaleMemories } from "../grounding/staleness.js";
import { activateMemory } from "../memory/activate.js";
import { remember } from "../write/remember.js";

export function createMemoryMcpServer(): McpServer {
  const server = new McpServer({
    name: "repo-grounded-memory-engine",
    version: "0.1.0",
  });

  server.registerTool(
    "memory.activate",
    {
      description: "Activate memory for the current chat/project and return relevant project context plus session instructions.",
      inputSchema: {
        task: z.string().optional(),
        scope: z.string().optional(),
        cwd: z.string().optional(),
        agent: z.string().optional(),
        limit: z.number().int().positive().max(20).optional(),
      },
      outputSchema: {
        activated: z.boolean(),
        scope: z.string(),
        session: z.object({
          id: z.string(),
          scope: z.string(),
          title: z.string().nullable(),
          task: z.string().nullable(),
          agent: z.string().nullable(),
          status: z.string(),
          repoRef: z.object({
            repo: z.string(),
            branch: z.string(),
            commit: z.string(),
          }).nullable(),
          startedAt: z.string(),
          endedAt: z.string().nullable(),
        }),
        repo: z.object({
          repo: z.string(),
          branch: z.string(),
          commit: z.string(),
        }).optional(),
        query: z.string(),
        memories: z.array(
          z.object({
            id: z.string(),
            type: z.string(),
            scope: z.string(),
            content: z.string(),
            rank: z.number(),
            createdAt: z.string(),
          }),
        ),
        dashboardUrl: z.string(),
        instructions: z.array(z.string()),
      },
    },
    async ({ task, scope, cwd, agent, limit }) => {
      const result = await activateMemory({ task, scope, cwd, agent, limit });
      const structuredContent: Record<string, unknown> = { ...result };

      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

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
      description: "Capture an episode for the activated chat session, extract facts, and apply intelligent memory operations.",
      inputSchema: {
        text: z.string().min(1),
        scope: z.string().optional(),
        sessionId: z.string().min(1),
      },
      outputSchema: {
        episodeId: z.string(),
        sessionId: z.string(),
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
    async ({ text, scope, sessionId }) => {
      const result = await remember({ text, scope, sessionId, requireSession: true });
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
