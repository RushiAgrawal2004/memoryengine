#!/usr/bin/env node
import { closeDb, checkDatabase } from "./db/client.js";
import { searchMemories } from "./db/memories.js";
import { config } from "./lib/config.js";
import { startHttpServer } from "./index.js";
import { activateMemory } from "./memory/activate.js";
import { remember } from "./write/remember.js";

const args = process.argv.slice(2);
const command = args[0] ?? "start";

async function main(): Promise<void> {
  switch (command) {
    case "start":
    case "serve":
      if (await isHttpServerRunning()) {
        console.log(`memory-engine is already running on http://localhost:${config.port}`);
        console.log(`viewer available at http://localhost:${config.port}/viewer`);
        return;
      }
      startHttpServer();
      return;
    case "demo":
      await runDemo();
      return;
    case "activate":
      await runActivate();
      return;
    case "connect":
      printConnect(args[1]);
      return;
    case "doctor":
      await runDoctor();
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

async function runDemo(): Promise<void> {
  const scope = valueAfter("--scope") ?? "project:memoryengine-demo";
  if (args.includes("--reset")) {
    await resetScope(scope);
  }

  const facts = [
    "This memory engine helps Codex and Claude remember project facts across chat sessions.",
    "A todo list app should support adding tasks, completing tasks, deleting tasks, filtering tasks, and localStorage persistence.",
    "Use memory.activate at the start of a chat window to load project memory.",
    "Use memory.remember after durable code decisions or implementation changes.",
  ];

  for (const fact of facts) {
    await remember({ scope, text: fact });
  }

  const results = await searchMemories({
    scope,
    query: "what should the todo app support",
    limit: 5,
  });

  console.log(`Demo scope: ${scope}`);
  console.log("Recall results:");
  for (const result of results) {
    console.log(`- ${result.content}`);
  }
  console.log(`Viewer: http://localhost:${config.port}/viewer`);
}

async function runActivate(): Promise<void> {
  const positionalTask = args.slice(1).join(" ");
  const task = valueAfter("--task") ?? (positionalTask ? positionalTask : undefined);
  const scope = valueAfter("--scope");
  const agent = valueAfter("--agent") ?? "cli";
  const result = await activateMemory({ task, scope, agent });

  console.log(JSON.stringify(result, null, 2));
}

function printConnect(agent: string | undefined): void {
  const target = agent ?? "codex";
  const nodePath = process.execPath.replaceAll("\\", "/");
  const serverPath = `${process.cwd().replaceAll("\\", "/")}/dist/src/index.js`;
  const mcpConfig = {
    mcpServers: {
      "memory-engine": {
        command: nodePath,
        args: [serverPath, "--stdio"],
        env: {
          DATABASE_URL: config.databaseUrl ?? "postgres://memory_engine:memory_engine@localhost:5432/memory_engine",
        },
      },
    },
  };

  console.log(`Memory Engine MCP config for ${target}:`);
  console.log(JSON.stringify(mcpConfig, null, 2));

  if (target === "codex") {
    console.log("");
    console.log("After adding the config, start a chat with:");
    console.log('Activate memory for this project with task "build a simple todo list web app". Search memory first. While building, remember durable decisions and completed changes.');
  }

  if (target === "claude-code") {
    console.log("");
    console.log("Claude Code hook command examples:");
    console.log(`node ${process.cwd().replaceAll("\\", "/")}/hooks/claude-code/session-start.mjs`);
    console.log(`node ${process.cwd().replaceAll("\\", "/")}/hooks/claude-code/post-tool-use.mjs`);
    console.log(`node ${process.cwd().replaceAll("\\", "/")}/hooks/claude-code/stop.mjs`);
  }
}

async function runDoctor(): Promise<void> {
  const db = await checkDatabase();
  const serverRunning = await isHttpServerRunning();
  console.log(`database: ${db ? "ok" : "failed"}`);
  console.log(`server: ${serverRunning ? "running" : "not running"} at http://localhost:${config.port}`);
  console.log(`viewer: http://localhost:${config.port}/viewer`);
  console.log(`embeddings provider: ${config.embeddingsProvider}`);
  console.log(`llm provider: ${config.llmProvider}`);
  console.log(`rerank provider: ${config.rerankProvider}`);
}

async function isHttpServerRunning(): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${config.port}/health`, {
      signal: AbortSignal.timeout(750),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function printHelp(): void {
  console.log(`memoryengine

Usage:
  memoryengine                 Start the HTTP server on PORT, default 3777
  memoryengine start           Start the HTTP server
  memoryengine demo --reset    Seed sample memories and prove recall
  memoryengine activate --task "build todo app"
  memoryengine connect codex
  memoryengine connect claude-code
  memoryengine doctor

Local install:
  npm run build
  npm install -g .
`);
}

async function resetScope(scope: string): Promise<void> {
  const sql = (await import("./db/client.js")).getSqlClient();
  await sql`delete from edges where scope = ${scope}`;
  await sql`delete from entities where scope = ${scope}`;
  await sql`delete from memories where scope = ${scope}`;
  await sql`delete from episodes where scope = ${scope}`;
}

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

main()
  .finally(async () => {
    if (!["start", "serve"].includes(command)) {
      await closeDb();
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
