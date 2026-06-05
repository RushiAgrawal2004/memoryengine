#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { closeDb, checkDatabase } from "./db/client.js";
import { getPgvectorDoctorReport } from "./db/embedding-vectors.js";
import { assessReadiness, ReadinessCheck } from "./health/readiness.js";
import { searchMemories } from "./db/memories.js";
import { config } from "./lib/config.js";
import { startHttpServer } from "./index.js";
import { activateMemory } from "./memory/activate.js";
import { remember } from "./write/remember.js";

const args = process.argv.slice(2);
const command = args[0] ?? "start";
const execFileAsync = promisify(execFile);

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
      await runConnect(args[1]);
      return;
    case "hook-test":
      await runHookTest();
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

async function runHookTest(): Promise<void> {
  const scope = valueAfter("--scope");
  const cwd = valueAfter("--cwd") ?? process.cwd();
  const text = valueAfter("--text") ?? "Codex hook test: verified automatic capture path.";
  const response = await fetch(`http://localhost:${config.port}/hook/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope, cwd, text }),
    signal: AbortSignal.timeout(5000),
  });
  const responseText = await response.text();
  const payload = parseJsonResponse(responseText) ?? {
    captured: false,
    status: response.status,
    error: responseText || "non-json response",
    hint: "Restart memoryengine so the running daemon has /hook/capture.",
  };

  console.log(JSON.stringify(payload, null, 2));
}

async function runConnect(agent: string | undefined): Promise<void> {
  if ((agent ?? "codex") === "git") {
    await installGitHook();
    return;
  }

  printConnect(agent);
}

function printConnect(agent: string | undefined): void {
  const target = agent ?? "codex";
  const nodePath = slashPath(process.execPath);
  const root = packageRoot();
  const serverPath = `${slashPath(root)}/dist/src/index.js`;
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
    console.log("Optional Codex hook commands for automatic capture after memory.activate:");
    console.log(`session-start: node ${slashPath(root)}/hooks/codex/session-start.mjs`);
    console.log(`post-tool-use: node ${slashPath(root)}/hooks/codex/post-tool-use.mjs`);
    console.log(`stop: node ${slashPath(root)}/hooks/codex/stop.mjs`);
    console.log("");
    console.log("After adding the config, start a chat with:");
    console.log('Activate memory for this project with task "build a simple todo list web app". Search memory first. Automatic hooks can capture tool activity after activation.');
  }

  if (target === "claude-code") {
    console.log("");
    console.log("Claude Code hook command examples:");
    console.log(`node ${slashPath(root)}/hooks/claude-code/session-start.mjs`);
    console.log(`node ${slashPath(root)}/hooks/claude-code/post-tool-use.mjs`);
    console.log(`node ${slashPath(root)}/hooks/claude-code/stop.mjs`);
  }
}

async function installGitHook(): Promise<void> {
  const cwd = valueAfter("--cwd") ?? process.cwd();
  const root = packageRoot();
  const source = path.join(root, "hooks", "git", "post-commit");
  const hookPath = (await git(["rev-parse", "--git-path", "hooks/post-commit"], cwd)).trim();
  const destination = path.resolve(cwd, hookPath);

  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o755).catch(() => undefined);

  console.log(`Installed Memory Engine git post-commit hook: ${destination}`);
  console.log(`It posts changed files to http://localhost:${config.port}/hook/git/post-commit`);
  console.log("Set MEMORY_ENGINE_URL if your daemon uses a different URL.");
}

function packageRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return process.cwd();
    }
    current = parent;
  }
}

function slashPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function parseJsonResponse(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function runDoctor(): Promise<void> {
  const strict = args.includes("--strict");
  const db = await checkDatabase();
  const serverRunning = await isHttpServerRunning();
  const pgvector = db ? await getPgvectorDoctorReport() : undefined;
  const readiness = assessReadiness({
    databaseOk: db,
    serverRunning,
    config,
    pgvector,
  });

  console.log(`database: ${db ? "ok" : "failed"}`);
  console.log(`server: ${serverRunning ? "running" : "not running"} at http://localhost:${config.port}`);
  console.log(`viewer: http://localhost:${config.port}/viewer`);
  console.log(`embeddings provider: ${config.embeddingsProvider}`);
  console.log(`embeddings local fallback: ${config.embeddingsLocal ? "enabled" : "disabled"}`);
  console.log(`llm provider: ${config.llmProvider}`);
  console.log(`rerank provider: ${config.rerankProvider}`);
  console.log(`readiness: ${readiness.label}`);

  if (!pgvector) {
    printReadiness(readiness);
    if (strict && !readiness.ready) {
      process.exitCode = 1;
    }
    return;
  }

  console.log(`pgvector extension: ${pgvector.extensionInstalled ? "present" : "missing"}`);
  console.log(`pgvector local JS fallback: ${pgvector.localFallbackEnabled ? "enabled" : "disabled"}`);
  console.log("vectorization:");
  for (const table of pgvector.tables) {
    console.log(
      `- ${table.table}: ${table.vectorEmbeddings}/${table.totalRows} vectorized (${table.vectorizedPercent}%), `
      + `missing=${table.missingVectors}, column=${table.vectorColumn ? "yes" : "no"}, `
      + `hnsw=${table.hnswIndex ? "yes" : "no"}`,
    );
  }

  if (pgvector.memoryQueryPlan.length > 0) {
    console.log(
      `memory vector recall plan uses index: ${pgvector.memoryQueryPlanUsesIndex ? "yes" : "no"}`,
    );
    console.log("memory vector recall plan:");
    for (const line of pgvector.memoryQueryPlan) {
      console.log(`  ${line}`);
    }
  } else {
    console.log("memory vector recall plan: unavailable until memories.embedding_vector has rows");
  }

  printReadiness(readiness);
  if (strict && !readiness.ready) {
    process.exitCode = 1;
  }
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
  memoryengine connect git
  memoryengine hook-test --scope "project:my-app"
  memoryengine doctor
  memoryengine doctor --strict

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

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
}

function printReadiness(report: ReturnType<typeof assessReadiness>): void {
  console.log("readiness checks:");
  for (const item of report.checks) {
    console.log(`- ${readinessIcon(item)} ${item.name}: ${item.message}`);
  }
}

function readinessIcon(item: ReadinessCheck): string {
  if (item.severity === "pass") {
    return "PASS";
  }

  if (item.severity === "warn") {
    return "WARN";
  }

  return "FAIL";
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
