import * as z from "zod/v4";
import { config } from "../lib/config.js";
import { normalizeTemporalText } from "../time/normalize.js";

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

interface JsonSchemaHint {
  type?: string;
  [key: string]: unknown;
}

interface HostedLLMOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export class HostedLLM implements LLM {
  constructor(
    private readonly apiKey = config.llmApiKey,
    private readonly model = config.llmModel,
    private readonly baseUrl = config.llmBaseUrl,
    private readonly options: HostedLLMOptions = {},
  ) {}

  async json<T>(system: string, user: string, schema: z.ZodType<T>): Promise<T> {
    const jsonSchema = jsonSchemaFor(schema);
    const content = await this.complete(
      [
        system,
        "Return only valid JSON matching the requested schema.",
        "Do not include markdown fences, prose, comments, or trailing commas.",
        `The top-level JSON value must be ${topLevelDescription(jsonSchema)}.`,
        `Schema: ${JSON.stringify(jsonSchema)}`,
      ].join("\n"),
      user,
      responseFormatFor(jsonSchema),
    );
    return parseAndValidateJson(content, schema);
  }

  async chat(system: string, user: string): Promise<string> {
    return this.complete(system, user);
  }

  private async complete(
    system: string,
    user: string,
    responseFormat?: Record<string, unknown>,
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error("LLM_API_KEY is required for hosted LLM calls");
    }

    const maxRetries = this.options.maxRetries ?? 2;
    const retryDelayMs = this.options.retryDelayMs ?? 500;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          signal: requestSignal(this.options.timeoutMs ?? 30_000),
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            ...(responseFormat ? { response_format: responseFormat } : {}),
          }),
        });

        if (!response.ok) {
          const errorText = await safeResponseText(response);
          const message = [
            `LLM request failed: ${response.status} ${response.statusText}`,
            errorText ? errorText.slice(0, 500) : undefined,
          ].filter(Boolean).join(" - ");
          lastError = new Error(message);

          if (attempt < maxRetries && isTransientStatus(response.status)) {
            await sleep(retryDelayFor(response, errorText, retryDelayMs * 2 ** attempt));
            continue;
          }

          throw lastError;
        }

        const payload = (await response.json()) as ChatCompletionsResponse;
        const content = payload.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error("LLM response did not include message content");
        }

        return content;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries && isTransientError(lastError)) {
          await sleep(retryDelayMs * 2 ** attempt);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError ?? new Error("LLM request failed");
  }
}

function jsonSchemaFor<T>(schema: z.ZodType<T>): JsonSchemaHint {
  try {
    return z.toJSONSchema(schema) as JsonSchemaHint;
  } catch {
    return {};
  }
}

function topLevelDescription(schema: JsonSchemaHint): string {
  return typeof schema.type === "string" ? `a JSON ${schema.type}` : "the schema shape";
}

function responseFormatFor(schema: JsonSchemaHint): Record<string, unknown> | undefined {
  return schema.type === "object" ? { type: "json_object" } : undefined;
}

function parseAndValidateJson<T>(content: string, schema: z.ZodType<T>): T {
  const parsed = parseJsonContent(content);
  const direct = schema.safeParse(parsed);
  if (direct.success) {
    return direct.data;
  }

  for (const repaired of repairJsonCandidates(parsed)) {
    const result = schema.safeParse(repaired);
    if (result.success) {
      return result.data;
    }
  }

  throw new Error(
    [
      "LLM JSON did not match schema.",
      `Issues: ${JSON.stringify(direct.error.issues.slice(0, 5))}`,
      `Received: ${JSON.stringify(parsed).slice(0, 1_000)}`,
    ].join(" "),
  );
}

function parseJsonContent(content: string): unknown {
  const stripped = stripMarkdownFence(content.trim());
  try {
    return JSON.parse(stripped);
  } catch {
    const embedded = extractBalancedJson(stripped);
    if (!embedded) {
      throw new Error(`LLM response was not valid JSON: ${stripped.slice(0, 500)}`);
    }

    try {
      return JSON.parse(embedded);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`LLM response contained malformed JSON: ${message}`);
    }
  }
}

function stripMarkdownFence(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? value;
}

function extractBalancedJson(value: string): string | undefined {
  const start = value.search(/[\[{]/);
  if (start === -1) {
    return undefined;
  }

  const opener = value[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === opener) {
      depth += 1;
    }

    if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function repairJsonCandidates(parsed: unknown): unknown[] {
  const candidates: unknown[] = [];

  if (Array.isArray(parsed)) {
    candidates.push(addMissingFactIndexes(parsed));
    candidates.push({
      facts: parsed.map(normalizeFactCandidate).filter(Boolean),
      entities: [],
      relations: [],
    });
    candidates.push({
      facts: [],
      entities: [],
      relations: parsed.map(normalizeRelationCandidate).filter(Boolean),
    });
    candidates.push({
      facts: [],
      entities: parsed.map(normalizeEntityCandidate).filter(Boolean),
      relations: [],
    });
    return candidates;
  }

  if (isRecord(parsed)) {
    if ("fact" in parsed || "content" in parsed || "text" in parsed) {
      candidates.push({
        facts: [normalizeFactCandidate(parsed)].filter(Boolean),
        entities: [],
        relations: [],
      });
    }

    if (Array.isArray(parsed.facts)) {
      candidates.push({
        ...parsed,
        facts: parsed.facts.map(normalizeFactCandidate).filter(Boolean),
        entities: Array.isArray(parsed.entities)
          ? parsed.entities.map(normalizeEntityCandidate).filter(Boolean)
          : [],
        relations: Array.isArray(parsed.relations)
          ? parsed.relations.map(normalizeRelationCandidate).filter(Boolean)
          : [],
      });
    }
  }

  return candidates;
}

function addMissingFactIndexes(values: unknown[]): unknown[] {
  return values.map((value, index) => {
    if (!isRecord(value) || "factIndex" in value) {
      return value;
    }

    return { factIndex: index, ...value };
  });
}

function normalizeFactCandidate(value: unknown): unknown {
  if (typeof value === "string") {
    return { fact: value, temporalRefs: [] };
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const fact = stringValue(value.fact) ?? stringValue(value.content) ?? stringValue(value.text);
  if (!fact) {
    return undefined;
  }

  return {
    ...value,
    fact,
    temporalRefs: Array.isArray(value.temporalRefs) ? value.temporalRefs : [],
  };
}

function normalizeEntityCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }

  const kind = stringValue(value.kind) ?? stringValue(value.type);
  const name = stringValue(value.name);
  return kind && name ? { ...value, kind, name } : undefined;
}

function normalizeRelationCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }

  const srcName = stringValue(value.srcName) ?? stringValue(value.source) ?? stringValue(value.src);
  const relation = stringValue(value.relation) ?? stringValue(value.type);
  const dstName = stringValue(value.dstName) ?? stringValue(value.target) ?? stringValue(value.dst);
  const fact = stringValue(value.fact) ?? [srcName, relation, dstName].filter(Boolean).join(" ");

  return srcName && relation && dstName && fact
    ? { ...value, srcName, relation, dstName, fact }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
      if (user.includes("Facts with candidates:")) {
        return schema.parse(memoryOpBatchPayload(user));
      }

      return schema.parse(memoryOpPayload(user));
    }

    return schema.parse({});
  }

  async chat(system: string, user: string): Promise<string> {
    if (system.toLowerCase().includes("summarize")) {
      return summarizeEpisodes(user);
    }

    if (system.toLowerCase().includes("answer a long-term memory question")) {
      return answerFromEvidence(user);
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
  const observations = observationCandidatesFor(text, occurredAt);
  const facts = observations.map((observation) => ({
    fact: observation.observationText,
    temporalRefs: observation.temporalRefs,
    sourceSessionId: observation.sourceSessionId,
    speaker: observation.speaker,
    observationText: observation.observationText,
    sessionDate: observation.sessionDate,
    mentionedDate: observation.mentionedDate,
    eventDate: observation.eventDate,
    mentionedAt: observation.mentionedAt,
    observationType: observation.observationType,
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

  for (const observation of observations) {
    const relation = relationFor(observation.observationText);
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

interface LocalObservation {
  sourceSessionId?: string;
  speaker?: string;
  observationText: string;
  sessionDate?: string;
  mentionedDate?: string;
  eventDate?: string;
  mentionedAt?: string;
  observationType?: "user_fact" | "preference" | "update" | "temporal_event" | "assistant_durable_info";
  temporalRefs: Array<{
    text: string;
    kind?: string;
    resolvedDate?: string;
    direction?: "before" | "after";
    eventText?: string;
    amount?: number;
    unit?: string;
    days?: number;
  }>;
}

function observationCandidatesFor(text: string, occurredAt: Date): LocalObservation[] {
  if (hasRolePrefixedTurns(text)) {
    return observationsFromRolePrefixedChat(text, occurredAt);
  }

  return splitFactSentences(text).map((observationText) =>
    enrichObservation({ observationText }, occurredAt)
  );
}

function hasRolePrefixedTurns(text: string): boolean {
  return /^(?:user|assistant|system|tool):\s*/im.test(text);
}

function observationsFromRolePrefixedChat(text: string, occurredAt: Date): LocalObservation[] {
  const turns = parseRolePrefixedTurns(text);
  if (turns.length === 0) {
    return [];
  }

  const sourceSessionId = metadataValue(text, "LongMemEval session_id")
    ?? metadataValue(text, "session_id")
    ?? metadataValue(text, "Session id");
  const sessionDate = metadataValue(text, "LongMemEval session_date")
    ?? metadataValue(text, "session_date")
    ?? metadataValue(text, "Session date");

  return turns.flatMap((turn) => {
    const content = compactWhitespace(stripEvalLabels(turn.content));
    if (!content) {
      return [];
    }

    if (turn.role === "assistant" && !isExplicitAssistantDurable(content)) {
      return [];
    }

    if (!["user", "assistant"].includes(turn.role)) {
      return [];
    }

    return splitRoleMemoryClauses(content, turn.role)
      .map((observationText) =>
        enrichObservation({
          sourceSessionId,
          speaker: turn.role,
          observationText,
          sessionDate,
          observationType: turn.role === "assistant" ? "assistant_durable_info" : undefined,
        }, occurredAt)
      );
  });
}

function parseRolePrefixedTurns(text: string): Array<{ role: string; content: string }> {
  const turns: Array<{ role: string; content: string }> = [];
  let current: { role: string; content: string[] } | undefined;

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(user|assistant|system|tool):\s*(.*)$/i);
    if (match) {
      if (current) {
        turns.push({ role: current.role, content: current.content.join("\n").trim() });
      }
      current = { role: match[1].toLowerCase(), content: [match[2] ?? ""] };
      continue;
    }

    if (current) {
      current.content.push(line);
    }
  }

  if (current) {
    turns.push({ role: current.role, content: current.content.join("\n").trim() });
  }

  return turns;
}

function splitFactSentences(text: string): string[] {
  return text
    .split(/(?:[;\n]+|(?<=[a-z0-9_)])\.(?=\s|$))/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitRoleMemoryClauses(text: string, role: string): string[] {
  if (role === "assistant" && isExplicitAssistantDurable(text)) {
    const durable = compactWhitespace(text.replace(
      /^(?:remember this|please remember|note this|durable note|memory note|save this)\s*:?\s*/i,
      "",
    ));
    return durable.length >= 12 ? [durable] : [];
  }

  const marked = text.replace(
    /\b(By the way|Also|Actually|I remember|I recently|I just|Speaking of|Remember this|Please remember|Note this)\b/g,
    "\n$1",
  );

  const chunks = marked
    .split(/\n+|(?<=[a-z0-9_)])\.(?=\s|$)/i)
    .map((item) => compactWhitespace(item))
    .map((item) => item.replace(/^(?:by the way|also|actually|remember this|please remember|note this),?\s+/i, ""))
    .filter((item) => item.length >= 12 && isDurableRoleClause(item, role));

  return chunks;
}

function isDurableRoleClause(text: string, role: string): boolean {
  if (role === "assistant") {
    return isExplicitAssistantDurable(text);
  }

  if (/^(?:can|could|would|do|does|did|will|should)\s+you\b/i.test(text)) {
    return false;
  }

  if (/\?$/u.test(text) && !/\b(?:i|we|my|our|project|repo|team|recently|remember|switched|use|uses|used)\b/i.test(text)) {
    return false;
  }

  return true;
}

function enrichObservation(
  input: Omit<LocalObservation, "temporalRefs" | "mentionedDate">,
  occurredAt: Date,
): LocalObservation {
  const temporal = normalizeTemporalText(input.observationText, occurredAt);
  const sessionDate = input.sessionDate ? parseSessionDate(input.sessionDate) : undefined;
  const eventDate = temporal.eventDate ?? sessionDate;
  return {
    ...input,
    observationType: input.observationType ?? observationTypeFor(input.observationText),
    mentionedDate: eventDate,
    eventDate,
    mentionedAt: temporal.mentionedAt ?? sessionDate,
    temporalRefs: temporal.temporalRefs,
  };
}

function parseSessionDate(value: string): string | undefined {
  const slash = value.trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (slash) {
    return isoDate(Number(slash[1]), Number(slash[2]) - 1, Number(slash[3]));
  }

  const dash = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (dash) {
    return isoDate(Number(dash[1]), Number(dash[2]) - 1, Number(dash[3]));
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function isoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month
    && date.getUTCDate() === day
    ? date.toISOString()
    : undefined;
}

function observationTypeFor(text: string): LocalObservation["observationType"] {
  if (/\b(?:prefer|preference|like to|want you to|please always|don't want|do not want)\b/i.test(text)) {
    return "preference";
  }

  if (/\b(?:actually|switched|moved|changed|now use|now uses|no longer|instead|replaced|migrated)\b/i.test(text)) {
    return "update";
  }

  if (/\b(?:yesterday|today|tomorrow|last week|last month|recently|\d+\s+weeks?\s+ago)\b/i.test(text)) {
    return "temporal_event";
  }

  return "user_fact";
}

function isExplicitAssistantDurable(text: string): boolean {
  return /^(?:remember this|please remember|note this|durable note|memory note|save this)\s*:?\s*/i
    .test(text);
}

function stripEvalLabels(text: string): string {
  return text
    .replace(/\bhas_answer\s*:\s*(?:true|false)\b/gi, "")
    .replace(/\banswer_session_ids?\s*:\s*\[[^\]]*]/gi, "")
    .replace(/\banswer\s*:\s*["'][^"']*["']/gi, "")
    .trim();
}

function metadataValue(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function memoryOpPayload(user: string): unknown {
  const fact = valueAfter(user, "Fact:");
  const existingJson = valueBetween(user, "Existing memories:", "Return");
  const existing = safeJsonParse<Array<{ id: string; content: string }>>(existingJson, []);
  return decideMemoryOp(fact, existing);
}

function memoryOpBatchPayload(user: string): unknown {
  const batchJson = valueBetween(user, "Facts with candidates:", "Return JSON array");
  const batch = safeJsonParse<Array<{
    factIndex: number;
    fact: string;
    candidates: Array<{ id: string; content: string }>;
  }>>(batchJson, []);

  return batch.map((item) => ({
    factIndex: item.factIndex,
    ...decideMemoryOp(item.fact, item.candidates),
  }));
}

function decideMemoryOp(
  fact: string,
  existing: Array<{ id: string; content: string }>,
): Record<string, unknown> {
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

  const updatable = existing.find((memory) => shouldUpdateMemory(memory.content, fact));
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

function answerFromEvidence(user: string): string {
  const evidence = valueAfter(user, "Evidence:");
  const lines = evidence
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[\d+\]\s*/, "").trim())
    .filter((line) => line && line !== "(none)");

  if (lines.length === 0) {
    return "I don't know.";
  }

  return stripSessionPrefix(lines[0]);
}

function stripSessionPrefix(value: string): string {
  return value.replace(/^session\s+[^:]+:\s+user said\s+/i, "").trim();
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

  if (lower.includes("last week")) {
    refs.push({ text: "last week", resolvedDate: daysAgo(occurredAt, 7) });
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

function shouldUpdateMemory(existing: string, fact: string): boolean {
  const existingTokens = meaningfulTokens(existing);
  const factTokens = meaningfulTokens(fact);
  if (existingTokens.length === 0 || factTokens.length === 0) {
    return false;
  }

  const factSet = new Set(factTokens);
  const shared = existingTokens.filter((token) => factSet.has(token)).length;

  return shared / existingTokens.length >= 0.8;
}

function tokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function meaningfulTokens(value: string): string[] {
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "are",
    "by",
    "for",
    "in",
    "is",
    "of",
    "on",
    "or",
    "the",
    "this",
    "to",
    "we",
  ]);

  return tokens(value).filter((token) => token.length > 2 && !stopwords.has(token));
}

function summaryKey(value: string): string {
  const tokenList = tokens(value).filter((token) => token.length > 2);
  return tokenList.slice(0, 4).join(" ") || value.slice(0, 80);
}
