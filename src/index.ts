import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { checkDatabase } from "./db/client.js";
import { saveMemory, searchMemories } from "./db/memories.js";
import { config } from "./lib/config.js";
import { remember } from "./write/remember.js";

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

  app.post("/remember", async (c) => {
    const body = await c.req.json<{
      text?: unknown;
      scope?: unknown;
    }>();

    if (typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "text is required" }, 400);
    }

    const result = await remember({
      text: body.text,
      scope: typeof body.scope === "string" ? body.scope : undefined,
    });

    return c.json(result);
  });

  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  serve(
    {
      fetch: createApp().fetch,
      port: config.port,
    },
    (info) => {
      console.log(`memory-engine listening on http://localhost:${info.port}`);
    },
  );
}
