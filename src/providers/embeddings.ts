import { config } from "../lib/config.js";

export interface Embeddings {
  readonly semantic: boolean;
  embed(texts: string[]): Promise<number[][]>;
}

interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[] }>;
}

interface HostedEmbeddingsOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

const BATCH_SIZE = 100;
const LOCAL_DIMENSIONS = 256;

export class HostedEmbeddings implements Embeddings {
  readonly semantic = true;

  constructor(
    private readonly apiKey = config.embeddingsApiKey,
    private readonly model = config.embeddingsModel,
    private readonly baseUrl = config.embeddingsBaseUrl,
    private readonly options: HostedEmbeddingsOptions = {},
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error("EMBEDDINGS_API_KEY is required for hosted embeddings");
    }

    const embeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      embeddings.push(...await this.embedBatch(batch));
    }

    return embeddings;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    const maxRetries = this.options.maxRetries ?? 2;
    const retryDelayMs = this.options.retryDelayMs ?? 500;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          signal: requestSignal(this.options.timeoutMs ?? 30_000),
          body: JSON.stringify({
            model: this.model,
            input: batch,
          }),
        });

        if (!response.ok) {
          const errorText = await safeResponseText(response);
          lastError = new Error(
            [
              `Embeddings request failed: ${response.status} ${response.statusText}`,
              errorText ? errorText.slice(0, 500) : undefined,
            ].filter(Boolean).join(" - "),
          );

          if (attempt < maxRetries && isTransientStatus(response.status)) {
            await sleep(retryDelayFor(response, errorText, retryDelayMs * 2 ** attempt));
            continue;
          }

          throw lastError;
        }

        const payload = (await response.json()) as EmbeddingsResponse;
        const batchEmbeddings = payload.data?.map((item) => item.embedding);

        if (!batchEmbeddings || batchEmbeddings.length !== batch.length) {
          throw new Error("Embeddings response count did not match input count");
        }

        if (batchEmbeddings.some((item) => !isNumericVector(item))) {
          throw new Error("Embeddings response included a missing or invalid embedding vector");
        }

        return batchEmbeddings as number[][];
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries && isTransientError(lastError)) {
          await sleep(retryDelayMs * 2 ** attempt);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError ?? new Error("Embeddings request failed");
  }
}

export class LocalEmbeddings implements Embeddings {
  readonly semantic = false;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => normalize(vectorize(text)));
  }
}

let embeddings: Embeddings | undefined;

export function getEmbeddings(): Embeddings {
  if (embeddings) {
    return embeddings;
  }

  embeddings = config.embeddingsProvider === "hosted"
    ? new HostedEmbeddings()
    : new LocalEmbeddings();

  return embeddings;
}

export function setEmbeddingsForTest(next: Embeddings | undefined): void {
  embeddings = next;
}

function vectorize(text: string): number[] {
  const vector = Array.from({ length: LOCAL_DIMENSIONS }, () => 0);
  for (const token of tokenize(text)) {
    const normalized = normalizeToken(token);
    vector[indexFor(normalized)] += 1;
  }

  return vector;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function normalizeToken(token: string): string {
  const synonyms: Record<string, string> = {
    dependency: "package_manager",
    dependencies: "package_manager",
    manager: "package_manager",
    npm: "package_manager",
    package: "package_manager",
    packages: "package_manager",
    pnpm: "package_manager",
    yarn: "package_manager",
    database: "database",
    db: "database",
    postgres: "database",
    postgresql: "database",
    sql: "database",
    auth: "authentication",
    authentication: "authentication",
    token: "authentication",
    tokens: "authentication",
    migration: "migration",
    migrations: "migration",
    drizzle: "migration",
    drizzlekit: "migration",
    persisted: "storage",
    persistence: "storage",
    stored: "storage",
    storage: "storage",
  };

  return synonyms[token] ?? token;
}

function indexFor(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash) % LOCAL_DIMENSIONS;
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

function isNumericVector(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

async function safeResponseText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

function requestSignal(timeoutMs: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isTransientError(error: Error): boolean {
  return error.name === "AbortError"
    || error.name === "TimeoutError"
    || /(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed)/i.test(error.message);
}

function retryDelayFor(response: Response, body: string | undefined, fallbackMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  const headerDelay = retryAfter ? retryAfterMs(retryAfter) : undefined;
  if (headerDelay !== undefined) {
    return headerDelay;
  }

  const bodyDelay = body?.match(/retry in\s+(\d+(?:\.\d+)?)s/i)?.[1];
  if (bodyDelay) {
    return Math.ceil(Number.parseFloat(bodyDelay) * 1_000);
  }

  return fallbackMs;
}

function retryAfterMs(value: string): number | undefined {
  const seconds = Number.parseFloat(value);
  if (!Number.isNaN(seconds)) {
    return Math.ceil(seconds * 1_000);
  }

  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
