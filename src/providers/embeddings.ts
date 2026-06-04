import { config } from "../lib/config.js";

export interface Embeddings {
  readonly semantic: boolean;
  embed(texts: string[]): Promise<number[][]>;
}

interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[] }>;
}

const BATCH_SIZE = 100;
const LOCAL_DIMENSIONS = 256;

export class HostedEmbeddings implements Embeddings {
  readonly semantic = true;

  constructor(
    private readonly apiKey = config.embeddingsApiKey,
    private readonly model = config.embeddingsModel,
    private readonly baseUrl = config.embeddingsBaseUrl,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error("EMBEDDINGS_API_KEY is required for hosted embeddings");
    }

    const embeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
        }),
      });

      if (!response.ok) {
        throw new Error(`Embeddings request failed: ${response.status} ${response.statusText}`);
      }

      const payload = (await response.json()) as EmbeddingsResponse;
      const batchEmbeddings = payload.data?.map((item) => item.embedding);

      if (!batchEmbeddings || batchEmbeddings.some((item) => !item)) {
        throw new Error("Embeddings response did not include embeddings for every input");
      }

      embeddings.push(...(batchEmbeddings as number[][]));
    }

    return embeddings;
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
