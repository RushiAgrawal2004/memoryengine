import * as z from "zod/v4";
import { config } from "../lib/config.js";

export interface LLM {
  json<T>(system: string, user: string, schema: z.ZodType<T>): Promise<T>;
  chat(system: string, user: string): Promise<string>;
}

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export class HostedLLM implements LLM {
  constructor(
    private readonly apiKey = config.llmApiKey,
    private readonly model = config.llmModel,
    private readonly baseUrl = config.llmBaseUrl,
  ) {}

  async json<T>(system: string, user: string, schema: z.ZodType<T>): Promise<T> {
    const content = await this.chat(
      `${system}\nReturn only valid JSON matching the requested schema.`,
      user,
      true,
    );
    return schema.parse(JSON.parse(content));
  }

  async chat(system: string, user: string, jsonMode = false): Promise<string> {
    if (!this.apiKey) {
      throw new Error("LLM_API_KEY is required for hosted LLM calls");
    }

    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as ChatCompletionsResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LLM response did not include message content");
    }

    return content;
  }
}

export class LocalHeuristicLLM implements LLM {
  async json<T>(system: string, user: string, schema: z.ZodType<T>): Promise<T> {
    const lowerSystem = system.toLowerCase();

    if (lowerSystem.includes("extract")) {
      return schema.parse(extractFactsPayload(user));
    }

    if (lowerSystem.includes("memory operation")) {
      return schema.parse(memoryOpPayload(user));
    }

    return schema.parse({});
  }

  async chat(_system: string, user: string): Promise<string> {
    return user;
  }
}

let llm: LLM | undefined;

export function getLLM(): LLM {
  if (llm) {
    return llm;
  }

  llm = config.llmProvider === "hosted" ? new HostedLLM() : new LocalHeuristicLLM();
  return llm;
}

export function setLLMForTest(next: LLM | undefined): void {
  llm = next;
}

function extractFactsPayload(user: string): unknown {
  const text = valueAfter(user, "Episode text:");
  const occurredAt = new Date(valueAfter(user, "Occurred at:"));
  const facts = text
    .split(/[.;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((fact) => ({
      fact,
      temporalRefs: temporalRefsFor(fact, occurredAt),
    }));

  return { facts };
}

function memoryOpPayload(user: string): unknown {
  const fact = valueAfter(user, "Fact:");
  const existingJson = valueBetween(user, "Existing memories:", "Return");
  const existing = safeJsonParse<Array<{ id: string; content: string }>>(existingJson, []);
  const factLower = fact.toLowerCase();

  const packageManagerTarget = existing.find((memory) =>
    /\b(npm|pnpm|yarn)\b/i.test(memory.content)
  );

  if (/\bswitched\b|\bnow\b|\buse pnpm\b|\buses pnpm\b/i.test(fact) && packageManagerTarget) {
    return {
      op: "INVALIDATE",
      targetId: packageManagerTarget.id,
      content: fact,
    };
  }

  const exact = existing.find(
    (memory) => memory.content.trim().toLowerCase() === factLower.trim(),
  );
  if (exact) {
    return { op: "NOOP", targetId: exact.id, content: exact.content };
  }

  const updatable = existing.find((memory) => overlaps(memory.content, fact));
  if (updatable && !/\bswitched\b|\binstead\b|\breplaced\b/i.test(fact)) {
    return {
      op: "UPDATE",
      targetId: updatable.id,
      content: fact,
    };
  }

  return { op: "ADD", content: fact };
}

function valueAfter(text: string, marker: string): string {
  const index = text.indexOf(marker);
  if (index === -1) {
    return text.trim();
  }

  return text.slice(index + marker.length).split(/\n[A-Z][A-Za-z ]+:/)[0]?.trim() ?? "";
}

function valueBetween(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (startIndex === -1) {
    return "";
  }

  return text
    .slice(startIndex + start.length, endIndex === -1 ? undefined : endIndex)
    .trim();
}

function temporalRefsFor(text: string, occurredAt: Date): Array<{ text: string; resolvedDate: string }> {
  const refs: Array<{ text: string; resolvedDate: string }> = [];
  const lower = text.toLowerCase();

  if (lower.includes("yesterday")) {
    refs.push({ text: "yesterday", resolvedDate: daysAgo(occurredAt, 1) });
  }

  const weeksAgo = lower.match(/\b(\d+|one|two|three|four)\s+weeks?\s+ago\b/);
  if (weeksAgo) {
    refs.push({
      text: weeksAgo[0],
      resolvedDate: daysAgo(occurredAt, wordNumber(weeksAgo[1]) * 7),
    });
  }

  return refs;
}

function daysAgo(date: Date, days: number): string {
  const resolved = new Date(date);
  resolved.setUTCDate(resolved.getUTCDate() - days);
  return resolved.toISOString();
}

function wordNumber(value: string): number {
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };
  return words[value] ?? Number.parseInt(value, 10);
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function overlaps(a: string, b: string): boolean {
  const aTokens = new Set(tokens(a));
  return tokens(b).some((token) => aTokens.has(token));
}

function tokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}
