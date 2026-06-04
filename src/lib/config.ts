import dotenv from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  databaseUrl?: string;
  port: number;
  embeddingsProvider: string;
  embeddingsLocal: boolean;
  embeddingsApiKey?: string;
  embeddingsModel: string;
  embeddingsBaseUrl: string;
  llmProvider: string;
  llmApiKey?: string;
  llmModel: string;
  llmBaseUrl: string;
  rerankProvider: string;
  cohereApiKey?: string;
  rerankModel: string;
  consolidateCron: string;
  reflectEpisodeLimit: number;
  decayDays: number;
  decayFloor: number;
}

const DEFAULT_PORT = 3777;
const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDINGS_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_LLM_MODEL = "gpt-4o-mini";
const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_RERANK_MODEL = "rerank-v3.5";
const DEFAULT_CONSOLIDATE_CRON = "*/30 * * * *";
const DEFAULT_REFLECT_EPISODE_LIMIT = 100;
const DEFAULT_DECAY_DAYS = 30;
const DEFAULT_DECAY_FLOOR = 0.2;

loadEnvFiles();

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawPort = env.PORT;
  const port = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_PORT;

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, received: ${rawPort}`);
  }

  return {
    databaseUrl: env.DATABASE_URL,
    port,
    embeddingsProvider: env.EMBEDDINGS_PROVIDER ?? "local",
    embeddingsLocal: env.EMBEDDINGS_LOCAL === "1",
    embeddingsApiKey: env.EMBEDDINGS_API_KEY,
    embeddingsModel: env.EMBEDDINGS_MODEL ?? DEFAULT_EMBEDDINGS_MODEL,
    embeddingsBaseUrl: env.EMBEDDINGS_BASE_URL ?? DEFAULT_EMBEDDINGS_BASE_URL,
    llmProvider: env.LLM_PROVIDER ?? "local",
    llmApiKey: env.LLM_API_KEY,
    llmModel: env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
    llmBaseUrl: env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL,
    rerankProvider: env.RERANK_PROVIDER ?? "none",
    cohereApiKey: env.COHERE_API_KEY,
    rerankModel: env.RERANK_MODEL ?? DEFAULT_RERANK_MODEL,
    consolidateCron: env.CONSOLIDATE_CRON ?? DEFAULT_CONSOLIDATE_CRON,
    reflectEpisodeLimit: parsePositiveInt(
      env.REFLECT_EPISODE_LIMIT,
      DEFAULT_REFLECT_EPISODE_LIMIT,
      "REFLECT_EPISODE_LIMIT",
    ),
    decayDays: parsePositiveInt(env.DECAY_DAYS, DEFAULT_DECAY_DAYS, "DECAY_DAYS"),
    decayFloor: parseFloatWithDefault(env.DECAY_FLOOR, DEFAULT_DECAY_FLOOR, "DECAY_FLOOR"),
  };
}

export const config = loadConfig();

function loadEnvFiles(): void {
  const cwdEnv = path.join(process.cwd(), ".env");
  if (existsSync(cwdEnv)) {
    dotenv.config({ path: cwdEnv, override: false });
  }

  const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (!packageRoot) {
    return;
  }

  const packageEnv = path.join(packageRoot, ".env");
  if (packageEnv !== cwdEnv && existsSync(packageEnv)) {
    dotenv.config({ path: packageEnv, override: false });
  }
}

function findPackageRoot(start: string): string | undefined {
  let current = start;

  while (true) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received: ${raw}`);
  }

  return parsed;
}

function parseFloatWithDefault(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be a number, received: ${raw}`);
  }

  return parsed;
}
