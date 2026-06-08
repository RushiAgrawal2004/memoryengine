import { getSqlClient } from "../db/client.js";
import { normalizeScope } from "../memory/scope.js";
import { answerQuestion } from "./answer.js";
import { RecallResult, temporalRecall } from "./recall.js";
import { retrieve } from "./retrieve.js";

export type QuestionKind =
  | "single_fact"
  | "multi_session"
  | "temporal_difference"
  | "before_after"
  | "knowledge_update"
  | "abstention_check";

export interface QuestionPlan {
  kind: QuestionKind;
  parts: string[];
  adaptiveK: number;
}

export interface RetrieveEvidenceOptions {
  topN?: number;
  asOf?: Date;
  composeAnswer?: boolean;
}

interface MemoryEvidenceRow extends RecallResult {
  sourceSession: string | null;
  sourceSessionId: string | null;
  eventDate: string | null;
}

const SIMPLE_K = 5;
const MEDIUM_K = 10;
const LARGE_K = 14;
const EXPANSION_LIMIT = 80;

export function classifyQuestion(query: string): QuestionKind {
  const lower = query.toLowerCase();

  if (/\b(?:how many days|days between|time between|duration between|how long between)\b/.test(lower)) {
    return "temporal_difference";
  }

  if (/\b(?:before|after)\b/.test(lower)) {
    return "before_after";
  }

  if (/\b(?:latest|newest|current|now|changed|switched|moved|no longer|instead|updated)\b/.test(lower)) {
    return "knowledge_update";
  }

  if (/\b(?:do we know|can we answer|is there evidence|any evidence|unknown|not enough information)\b/.test(lower)) {
    return "abstention_check";
  }

  if (/\b(?:across sessions|multiple sessions|multi-session|both sessions|compare|combine|connect|relationship)\b/.test(lower)) {
    return "multi_session";
  }

  return "single_fact";
}

export function planQuestion(query: string): QuestionPlan {
  const kind = classifyQuestion(query);
  const parts = decomposeQuestion(query, kind);
  return {
    kind,
    parts,
    adaptiveK: adaptiveKFor(kind),
  };
}

export function adaptiveKFor(kind: QuestionKind): number {
  if (kind === "temporal_difference" || kind === "before_after" || kind === "multi_session") {
    return LARGE_K;
  }

  if (kind === "knowledge_update" || kind === "abstention_check") {
    return MEDIUM_K;
  }

  return SIMPLE_K;
}

export async function retrieveEvidence(
  query: string,
  scope: string | undefined,
  options: RetrieveEvidenceOptions = {},
): Promise<RecallResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const plan = planQuestion(trimmed);
  const resolvedScope = normalizeScope(scope);
  const targetK = options.topN ?? plan.adaptiveK;
  const expansionK = Math.max(targetK, plan.adaptiveK);
  const evidence: RecallResult[] = [];

  evidence.push(...await retrieve({
    query: trimmed,
    scope: resolvedScope,
    topN: expansionK,
    asOf: options.asOf,
  }));

  if (isTemporalKind(plan.kind)) {
    evidence.push(...await temporalRecall(trimmed, resolvedScope, expansionK, options.asOf));
    for (const part of plan.parts) {
      evidence.push(...await retrieve({
        query: part,
        scope: resolvedScope,
        topN: Math.ceil(expansionK / 2),
        asOf: options.asOf,
      }));
      evidence.push(...await temporalRecall(part, resolvedScope, Math.ceil(expansionK / 2), options.asOf));
    }
  }

  const detailed = await detailsForEvidence(evidence);
  evidence.push(...await expandBySourceSession(detailed, resolvedScope, options.asOf));
  evidence.push(...await expandBySharedEntitiesAndEvents(trimmed, evidence, resolvedScope, options.asOf));

  const diversified = diversifyEvidence(await detailsForEvidence(evidence), targetK);
  if (options.composeAnswer === false || diversified.length === 0) {
    return diversified;
  }

  const composed = await answerQuestion({
    question: trimmed,
    evidence: diversified.map((item) => item.content),
    asOf: options.asOf,
  });
  if (isAbstention(composed) || evidenceAlreadyContainsAnswer(diversified, composed)) {
    return diversified;
  }

  return [
    {
      id: `derived-answer:${hashText(`${trimmed}\n${composed}`)}`,
      type: "derived_answer",
      scope: resolvedScope ?? "global",
      content: `Derived answer from retrieved evidence: ${composed}`,
      rank: 1,
      createdAt: new Date().toISOString(),
    },
    ...diversified,
  ];
}

function decomposeQuestion(query: string, kind: QuestionKind): string[] {
  if (kind === "temporal_difference") {
    const between = query.match(/\bbetween\s+(.+?)\s+and\s+(.+?)(?:[?.]|$)/i);
    if (between) {
      return [between[1], between[2]].map(cleanPart).filter(Boolean);
    }
  }

  if (kind === "before_after") {
    const relation = query.match(/\b(before|after)\s+(.+?)(?:[?.]|$)/i);
    if (relation) {
      return [relation[2]].map(cleanPart).filter(Boolean);
    }
  }

  const split = query.split(/\b(?:and|then|versus|vs)\b/i).map(cleanPart).filter(Boolean);
  return split.length > 1 ? split : [query];
}

function cleanPart(value: string | undefined): string {
  return (value ?? "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\b(?:happen(?:ed)?|occur(?:red)?|date|event)\b/gi, "")
    .trim();
}

function isTemporalKind(kind: QuestionKind): boolean {
  return kind === "temporal_difference" || kind === "before_after";
}

async function detailsForEvidence(results: RecallResult[]): Promise<MemoryEvidenceRow[]> {
  const synthetic = results
    .filter((result) => !isUuid(result.id))
    .map((result) => ({
      ...result,
      sourceSession: null,
      sourceSessionId: null,
      eventDate: null,
    }));
  const ids = [...new Set(results.map((result) => result.id).filter(isUuid))];
  if (ids.length === 0) {
    return synthetic;
  }

  const sql = getSqlClient();
  const rows = await sql<Array<{
    id: string;
    type: string;
    scope: string;
    content: string;
    createdAt: string;
    sourceSession: string | null;
    sourceSessionId: string | null;
    eventDate: string | null;
  }>>`
    select
      id,
      type,
      scope,
      content,
      created_at::text as "createdAt",
      source_session::text as "sourceSession",
      attrs->'observation'->>'sourceSessionId' as "sourceSessionId",
      attrs->'observation'->>'eventDate' as "eventDate"
    from memories
    where id in ${sql(ids)}
  `;
  const rankById = new Map(results.map((result, index) => [
    result.id,
    Math.max(result.rank, 1 / (index + 1)),
  ]));

  return [
    ...synthetic,
    ...rows.map((row) => ({
      ...row,
      rank: rankById.get(row.id) ?? 0,
    })),
  ];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

async function expandBySourceSession(
  seeds: MemoryEvidenceRow[],
  scope: string | undefined,
  asOf: Date | undefined,
): Promise<RecallResult[]> {
  const sourceSessionIds = [...new Set(seeds.map((seed) => seed.sourceSessionId).filter(Boolean))] as string[];
  const sourceSessions = [...new Set(seeds.map((seed) => seed.sourceSession).filter(Boolean))] as string[];
  if (sourceSessionIds.length === 0 && sourceSessions.length === 0) {
    return [];
  }

  const rows = await activeMemoryRows(scope, asOf);
  return rows
    .filter((row) =>
      Boolean(row.sourceSessionId && sourceSessionIds.includes(row.sourceSessionId))
      || Boolean(row.sourceSession && sourceSessions.includes(row.sourceSession))
    )
    .map((row) => ({ ...row, rank: 0.55 }))
    .slice(0, EXPANSION_LIMIT);
}

async function expandBySharedEntitiesAndEvents(
  query: string,
  seeds: RecallResult[],
  scope: string | undefined,
  asOf: Date | undefined,
): Promise<RecallResult[]> {
  const seedText = [query, ...seeds.map((seed) => seed.content)].join("\n");
  const tokens = importantTokens(seedText);
  if (tokens.length === 0) {
    return [];
  }

  const rows = await activeMemoryRows(scope, asOf);
  return rows
    .map((row) => ({
      ...row,
      rank: sharedTokenScore(tokens, importantTokens(row.content)) + (row.eventDate ? 0.15 : 0),
    }))
    .filter((row) => row.rank >= 0.35)
    .sort((a, b) => b.rank - a.rank || b.createdAt.localeCompare(a.createdAt))
    .slice(0, EXPANSION_LIMIT);
}

async function activeMemoryRows(
  scope: string | undefined,
  asOf: Date | undefined,
): Promise<MemoryEvidenceRow[]> {
  const sql = getSqlClient();
  return asOf
    ? scope
      ? await sql<MemoryEvidenceRow[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            source_session::text as "sourceSession",
            attrs->'observation'->>'sourceSessionId' as "sourceSessionId",
            attrs->'observation'->>'eventDate' as "eventDate"
          from memories
          where scope = ${scope}
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit 1000
        `
      : await sql<MemoryEvidenceRow[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            source_session::text as "sourceSession",
            attrs->'observation'->>'sourceSessionId' as "sourceSessionId",
            attrs->'observation'->>'eventDate' as "eventDate"
          from memories
          where (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit 1000
        `
    : scope
      ? await sql<MemoryEvidenceRow[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            source_session::text as "sourceSession",
            attrs->'observation'->>'sourceSessionId' as "sourceSessionId",
            attrs->'observation'->>'eventDate' as "eventDate"
          from memories
          where status = 'active'
            and scope = ${scope}
          order by created_at desc
          limit 1000
        `
      : await sql<MemoryEvidenceRow[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            source_session::text as "sourceSession",
            attrs->'observation'->>'sourceSessionId' as "sourceSessionId",
            attrs->'observation'->>'eventDate' as "eventDate"
          from memories
          where status = 'active'
          order by created_at desc
          limit 1000
        `;
}

function diversifyEvidence(results: MemoryEvidenceRow[], topN: number): RecallResult[] {
  const byId = new Map<string, MemoryEvidenceRow>();
  for (const result of results) {
    const existing = byId.get(result.id);
    if (!existing || result.rank > existing.rank) {
      byId.set(result.id, result);
    }
  }

  const ordered = [...byId.values()].sort((a, b) =>
    b.rank - a.rank
    || (b.eventDate ?? "").localeCompare(a.eventDate ?? "")
    || b.createdAt.localeCompare(a.createdAt)
  );
  const selected: MemoryEvidenceRow[] = [];
  const deferred: MemoryEvidenceRow[] = [];
  const seenSessions = new Set<string>();

  for (const item of ordered) {
    const source = sourceKey(item);
    if (!source || !seenSessions.has(source)) {
      selected.push(item);
      if (source) {
        seenSessions.add(source);
      }
    } else {
      deferred.push(item);
    }

    if (selected.length === topN) {
      return selected.map(toRecallResult);
    }
  }

  return [...selected, ...deferred].slice(0, topN).map(toRecallResult);
}

function toRecallResult(row: MemoryEvidenceRow): RecallResult {
  return {
    id: row.id,
    type: row.type,
    scope: row.scope,
    content: row.content,
    rank: row.rank,
    createdAt: row.createdAt,
  };
}

function sourceKey(row: MemoryEvidenceRow): string | undefined {
  return row.sourceSessionId?.toLowerCase()
    ?? row.sourceSession?.toLowerCase()
    ?? row.content.match(/^session\s+([^:\s]+)\b/i)?.[1]?.toLowerCase();
}

function isAbstention(value: string): boolean {
  return /\b(?:i don't know|unknown|insufficient|not enough)\b/i.test(value.trim());
}

function evidenceAlreadyContainsAnswer(evidence: RecallResult[], answer: string): boolean {
  const answerTokens = importantTokens(answer);
  if (answerTokens.length === 0) {
    return true;
  }

  const text = evidence.map((item) => item.content).join("\n").toLowerCase();
  return answerTokens.every((token) => text.includes(token));
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function sharedTokenScore(queryTokens: string[], contentTokens: string[]): number {
  if (queryTokens.length === 0 || contentTokens.length === 0) {
    return 0;
  }

  const content = new Set(contentTokens);
  const shared = new Set(queryTokens.filter((token) => content.has(token))).size;
  return shared / Math.min(queryTokens.length, 8);
}

function importantTokens(value: string): string[] {
  const stopwords = new Set([
    "about",
    "after",
    "before",
    "between",
    "current",
    "days",
    "does",
    "event",
    "from",
    "have",
    "latest",
    "many",
    "memory",
    "session",
    "that",
    "the",
    "this",
    "what",
    "when",
    "where",
    "which",
    "with",
  ]);

  return [...new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9_.-]+/g)
      ?.filter((token) => token.length >= 4 && !stopwords.has(token)) ?? [],
  )].slice(0, 24);
}
