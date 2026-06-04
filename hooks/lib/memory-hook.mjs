import { readFile } from "node:fs/promises";

const DEFAULT_BASE_URL = "http://localhost:3777";
const CAPTURE_TIMEOUT_MS = 1500;
const SEARCH_TIMEOUT_MS = Number.parseInt(process.env.MEMORY_ENGINE_SEARCH_TIMEOUT_MS ?? "50", 10);

export async function readHookInput() {
  const stdin = await readFile(0, "utf8").catch(() => "");
  if (!stdin.trim()) {
    return {};
  }

  try {
    return JSON.parse(stdin);
  } catch {
    return { raw: stdin };
  }
}

export function taskFrom(input) {
  return firstString(
    process.env.MEMORY_ENGINE_TASK,
    input.task,
    input.prompt,
    input.message,
    input.userPrompt,
    input.currentTask,
    input.transcript?.at?.(-1)?.content,
    input.raw,
  );
}

export function scopeFrom(input) {
  return firstString(
    process.env.MEMORY_ENGINE_SCOPE,
    input.scope,
    input.projectScope,
    input.cwd ? `project:${lastPathPart(input.cwd)}` : undefined,
    process.cwd() ? `project:${lastPathPart(process.cwd())}` : undefined,
  );
}

export async function printSessionRecall(agentName) {
  const input = await readHookInput();
  const query = taskFrom(input);
  if (!query) {
    return;
  }

  const payload = await postJson("/search", {
    query,
    scope: scopeFrom(input),
    limit: 5,
  }, SEARCH_TIMEOUT_MS).catch(() => undefined);

  if (!payload?.results?.length) {
    return;
  }

  console.log(`\nRelevant memory for ${agentName}:`);
  for (const result of payload.results.slice(0, 5)) {
    console.log(`- ${result.content}`);
  }
  console.log("");
}

export async function captureHookEvent(agentName, eventName) {
  const input = await readHookInput();
  const text = formatEvent(agentName, eventName, input);
  if (!text) {
    return;
  }

  void postJson("/hook/capture", {
    text,
    scope: scopeFrom(input),
    cwd: firstString(input.cwd, input.workspace, input.workspaceFolder),
    sessionId: sessionIdFrom(input),
  }, CAPTURE_TIMEOUT_MS).catch(() => undefined);

  setTimeout(() => process.exit(0), 500).unref();
}

function sessionIdFrom(input) {
  return firstString(
    process.env.MEMORY_ENGINE_SESSION_ID,
    input.sessionId,
    input.session_id,
    input.memorySessionId,
  );
}

function formatEvent(agentName, eventName, input) {
  const tool = firstString(input.tool_name, input.toolName, input.name, input.tool);
  const command = firstString(input.command, input.args?.command, input.input?.command);
  const status = firstString(input.status, input.result?.status);
  const output = firstString(
    input.output,
    input.result?.output,
    input.result?.content,
    input.observation,
    input.raw,
  );

  const parts = [
    `${agentName} ${eventName}`,
    tool ? `tool: ${tool}` : undefined,
    command ? `command: ${command}` : undefined,
    status ? `status: ${status}` : undefined,
    output ? `output: ${truncate(output, 4000)}` : undefined,
  ].filter(Boolean);

  return parts.join("\n");
}

async function postJson(path, body, timeoutMs) {
  const baseUrl = process.env.MEMORY_ENGINE_URL ?? DEFAULT_BASE_URL;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`memory hook request failed: ${response.status}`);
  }

  return response.json();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function lastPathPart(value) {
  return value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "unknown";
}
