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

    if (lowerSystem.includes("edge contradiction")) {
      return schema.parse(edgeContradictionPayload(user));
    }

    if (lowerSystem.includes("revalidate") || lowerSystem.includes("re-validation")) {
      return schema.parse(revalidatePayload(user));
    }

    if (lowerSystem.includes("evaluation judge")) {
      return schema.parse(evaluationJudgePayload(user));
    }

    if (lowerSystem.includes("memory operation")) {
      return schema.parse(memoryOpPayload(user));
    }

    return schema.parse({});
  }

  async chat(system: string, user: string): Promise<string> {
    if (system.toLowerCase().includes("summarize")) {
      return summarizeEpisodes(user);
    }

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
  const sentences = text
    .split(/(?:[;\n]+|(?<=[a-z0-9_)])\.(?=\s|$))/i)
    .map((item) => item.trim())
    .filter(Boolean);
  const facts = sentences.map((fact) => ({
      fact,
      temporalRefs: temporalRefsFor(fact, occurredAt),
    }));
  const entities = new Map<string, { kind: string; name: string }>();
  const relations: Array<{
    srcName: string;
    srcKind?: string;
    relation: string;
    dstName: string;
    dstKind?: string;
    fact: string;
  }> = [];

  for (const sentence of sentences) {
    const relation = relationFor(sentence);
    if (!relation) {
      continue;
    }

    entities.set(`${relation.srcKind}:${relation.srcName}`, {
      kind: relation.srcKind,
      name: relation.srcName,
    });
    entities.set(`${relation.dstKind}:${relation.dstName}`, {
      kind: relation.dstKind,
      name: relation.dstName,
    });
    relations.push(relation);

  }

  return { facts, entities: [...entities.values()], relations };
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

function edgeContradictionPayload(user: string): unknown {
  const fact = valueAfter(user, "New fact:");
  const existingJson = valueBetween(user, "Existing edges:", "Return");
  const existing = safeJsonParse<Array<{ id: string; fact: string }>>(existingJson, []);

  const contradiction = existing.find((edge) => contradicts(edge.fact, fact));

  return {
    contradicts: Boolean(contradiction),
    targetId: contradiction?.id,
  };
}

function revalidatePayload(user: string): unknown {
  const memory = valueAfter(user, "Memory:");
  const fileContent = valueAfter(user, "Current file content:");

  if (fileContent.toLowerCase().includes(memory.toLowerCase())) {
    return { op: "NOOP", content: memory };
  }

  return { op: "INVALIDATE", content: memory };
}

function evaluationJudgePayload(user: string): unknown {
  const context = valueBetween(user, "Retrieved context:", "Expected answer keywords:");
  const keywordsJson = valueAfter(user, "Expected answer keywords:");
  const keywords = safeJsonParse<string[]>(keywordsJson, []);
  const contextLower = context.toLowerCase();
  const missing = keywords.filter((keyword) => !contextLower.includes(keyword.toLowerCase()));

  return {
    correct: missing.length === 0,
    rationale: missing.length === 0
      ? "Retrieved context contains the expected answer keywords."
      : `Missing expected keywords: ${missing.join(", ")}`,
  };
}

function summarizeEpisodes(user: string): string {
  const text = valueAfter(user, "Episodes:");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean);

  const clusters = new Map<string, string[]>();
  for (const line of lines) {
    const key = summaryKey(line);
    const list = clusters.get(key) ?? [];
    list.push(line);
    clusters.set(key, list);
  }

  return [...clusters.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(([key, cluster]) => `${key} appears across ${cluster.length} recent episodes`)
    .join("\n");
}

function relationFor(sentence: string):
  | {
      srcName: string;
      srcKind: string;
      relation: string;
      dstName: string;
      dstKind: string;
      fact: string;
    }
  | undefined {
  const normalized = sentence.trim();
  const calls = normalized.match(/^(.+?)\s+(?:no longer\s+)?calls\s+(.+?)(?:\s+instead)?$/i);
  if (calls) {
    return {
      srcName: calls[1].trim(),
      srcKind: kindFor(calls[1].trim()),
      relation: "calls",
      dstName: calls[2].trim(),
      dstKind: kindFor(calls[2].trim()),
      fact: normalized,
    };
  }

  const depends = normalized.match(/^(.+?)\s+depends\s+on\s+(.+)$/i);
  if (depends) {
    return {
      srcName: depends[1].trim(),
      srcKind: kindFor(depends[1].trim()),
      relation: "depends_on",
      dstName: depends[2].trim(),
      dstKind: kindFor(depends[2].trim()),
      fact: normalized,
    };
  }

  return undefined;
}

function kindFor(name: string): string {
  if (/\.[cm]?[jt]sx?$|\.py$|\.go$|\.rs$|\.ts$/i.test(name)) {
    return "file";
  }

  if (/lib|pkg|package|jwt/i.test(name)) {
    return "dependency";
  }

  return "symbol";
}

function contradicts(oldFact: string, newFact: string): boolean {
  const oldLower = oldFact.toLowerCase();
  const newLower = newFact.toLowerCase();
  if (newLower.includes("no longer") || newLower.includes("instead")) {
    return true;
  }

  const oldRelation = relationFor(oldFact);
  const newRelation = relationFor(newFact);
  if (!oldRelation || !newRelation) {
    return false;
  }

  return oldRelation.srcName.toLowerCase() === newRelation.srcName.toLowerCase()
    && oldRelation.relation === newRelation.relation
    && oldRelation.dstName.toLowerCase() !== newRelation.dstName.toLowerCase();
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

function summaryKey(value: string): string {
  const tokenList = tokens(value).filter((token) => token.length > 2);
  return tokenList.slice(0, 4).join(" ") || value.slice(0, 80);
}
