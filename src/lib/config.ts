import "dotenv/config";

export interface Config {
  databaseUrl?: string;
  port: number;
  embeddingsProvider: string;
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
}

const DEFAULT_PORT = 3777;
const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDINGS_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_LLM_MODEL = "gpt-4o-mini";
const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_RERANK_MODEL = "rerank-v3.5";

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
  };
}

export const config = loadConfig();
