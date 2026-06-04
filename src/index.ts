import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { checkDatabase } from "./db/client.js";
import { saveMemory, searchMemories } from "./db/memories.js";
import { getLatestActiveMemorySession } from "./db/sessions.js";
import { config } from "./lib/config.js";
import { activateMemory } from "./memory/activate.js";
import { resolveMemoryScope } from "./memory/scope.js";
import { runStdioServer } from "./mcp/server.js";
import { registerViewerRoutes } from "./viewer/routes.js";
import { MemorySessionInvalidError, MemorySessionRequiredError, remember } from "./write/remember.js";

export function createApp(options: { checkDatabase?: () => Promise<boolean> } = {}) {
  const app = new Hono();
  const dbHealth = options.checkDatabase ?? checkDatabase;

  app.get("/health", async (c) => {
    const db = await dbHealth();

    return c.json({
      ok: db,
      db,
    });
  });

  app.post("/save", async (c) => {
    const body = await c.req.json<{
      content?: unknown;
      type?: unknown;
      scope?: unknown;
    }>();

    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }

    const result = await saveMemory({
      content: body.content,
      type: typeof body.type === "string" ? body.type : undefined,
      scope: typeof body.scope === "string" ? body.scope : undefined,
    });

    return c.json(result);
  });

  app.post("/search", async (c) => {
    const body = await c.req.json<{
      query?: unknown;
      scope?: unknown;
      limit?: unknown;
      asOf?: unknown;
    }>();

    if (typeof body.query !== "string" || !body.query.trim()) {
      return c.json({ error: "query is required" }, 400);
    }

    const results = await searchMemories({
      query: body.query,
      scope: typeof body.scope === "string" ? body.scope : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
      asOf: typeof body.asOf === "string" ? new Date(body.asOf) : undefined,
    });

    return c.json({ results });
  });

  app.post("/activate", async (c) => {
    const body: {
      task?: unknown;
      scope?: unknown;
      cwd?: unknown;
      limit?: unknown;
      agent?: unknown;
    } = await c.req.json().catch(() => ({}));

    const result = await activateMemory({
      task: typeof body.task === "string" ? body.task : undefined,
      scope: typeof body.scope === "string" ? body.scope : undefined,
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
      agent: typeof body.agent === "string" ? body.agent : undefined,
    });

    return c.json(result);
  });

  app.post("/remember", async (c) => {
    const body = await c.req.json<{
      text?: unknown;
      scope?: unknown;
      sessionId?: unknown;
    }>();

    if (typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "text is required" }, 400);
    }

    try {
      const result = await remember({
        text: body.text,
        scope: typeof body.scope === "string" ? body.scope : undefined,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        requireSession: true,
      });

      return c.json(result);
    } catch (error) {
      if (
        error instanceof MemorySessionRequiredError ||
        error instanceof MemorySessionInvalidError
      ) {
        return c.json({ error: error.message, code: error.code }, 400);
      }
      throw error;
    }
  });

  app.post("/hook/capture", async (c) => {
    const body: {
      text?: unknown;
      scope?: unknown;
      cwd?: unknown;
      sessionId?: unknown;
    } = await c.req.json().catch(() => ({}));

    if (typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "text is required" }, 400);
    }

    const requestedScope = typeof body.scope === "string" ? body.scope : undefined;
    const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
    const scope = await resolveMemoryScope(requestedScope, cwd);
    const sessionId = typeof body.sessionId === "string"
      ? body.sessionId
      : (await getLatestActiveMemorySession(scope))?.id;

    if (!sessionId) {
      return c.json({ captured: false, reason: "no_active_session", scope }, 202);
    }

    try {
      const result = await remember({
        text: body.text,
        scope,
        sessionId,
        requireSession: true,
      });

      return c.json({ captured: true, ...result });
    } catch (error) {
      if (
        error instanceof MemorySessionRequiredError ||
        error instanceof MemorySessionInvalidError
      ) {
        return c.json({ captured: false, error: error.message, code: error.code }, 400);
      }
      throw error;
    }
  });

  registerViewerRoutes(app);

  return app;
}

export function startHttpServer(): void {
  const server = serve(
    {
      fetch: createApp().fetch,
      port: config.port,
    },
    (info) => {
      console.log(`memory-engine listening on http://localhost:${info.port}`);
      console.log(`viewer available at http://localhost:${info.port}/viewer`);
    },
  );
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`memory-engine is already using port ${config.port}.`);
      console.error(`If it is already running, open http://localhost:${config.port}/viewer`);
      console.error(`Or run with another port: $env:PORT=3778; memoryengine`);
      process.exit(1);
    }

    throw error;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--stdio")) {
    runStdioServer().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  } else {
    startHttpServer();
  }
}
