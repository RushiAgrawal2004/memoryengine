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
  sourceEpisode: string | null;
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
  evidence.push(...await expandBySourceEpisodeSnippets(trimmed, detailed, resolvedScope, options.asOf));
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
      content: `Answer: ${composed}`,
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
      sourceEpisode: null,
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
    sourceEpisode: string | null;
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
      source_episode::text as "sourceEpisode",
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

async function expandBySourceEpisodeSnippets(
  query: string,
  seeds: MemoryEvidenceRow[],
  scope: string | undefined,
  asOf: Date | undefined,
): Promise<RecallResult[]> {
  const episodeIds = [...new Set(
    seeds
      .map((seed) => seed.sourceEpisode)
      .filter((id): id is string => Boolean(id && isUuid(id))),
  )];
  if (episodeIds.length === 0) {
    return [];
  }

  const seedText = [query, ...seeds.map((seed) => seed.content)].join("\n");
  const queryTokens = importantTokens(query);
  const seedTokens = importantTokens(seedText);
  const sql = getSqlClient();
  const rows = await sql<Array<{
    id: string;
    scope: string;
    content: string;
    occurredAt: string;
  }>>`
    select id, scope, content, occurred_at::text as "occurredAt"
    from episodes
    where id in ${sql(episodeIds)}
      and (${scope ?? null}::text is null or scope = ${scope ?? null})
      and (${asOf ?? null}::timestamptz is null or occurred_at <= ${asOf ?? null})
  `;

  return rows
    .flatMap((row) => {
      const snippets = topEpisodeSnippets(row.content, queryTokens, seedTokens).map((snippet) => ({
        id: `source-excerpt:${row.id}:${hashText(snippet)}`,
        type: "source_excerpt",
        scope: row.scope,
        content: `Source episode excerpt: ${snippet}`,
        rank: snippetScore(snippet, queryTokens, seedTokens) + 0.75,
        createdAt: row.occurredAt,
      }));
      const digest = episodeDigestCandidate(row.content);
      return digest
        ? [
            ...snippets,
            {
              id: `source-context:${row.id}:${hashText(digest)}`,
              type: "source_context",
              scope: row.scope,
              content: `Source episode context: ${digest}`,
              rank: Math.max(0.65, ...snippets.map((snippet) => snippet.rank - 0.1)),
              createdAt: row.occurredAt,
            },
          ]
        : snippets;
    })
    .sort((a, b) => b.rank - a.rank || b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.min(EXPANSION_LIMIT, episodeIds.length * 4));
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
            source_episode::text as "sourceEpisode",
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
            source_episode::text as "sourceEpisode",
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
            source_episode::text as "sourceEpisode",
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
            source_episode::text as "sourceEpisode",
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

  const ordered = dedupeNearDuplicateEvidence([...byId.values()]).sort((a, b) =>
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

function dedupeNearDuplicateEvidence(results: MemoryEvidenceRow[]): MemoryEvidenceRow[] {
  const kept: MemoryEvidenceRow[] = [];
  for (const result of results) {
    const duplicateIndex = kept.findIndex((existing) => isNearDuplicateEvidence(existing, result));
    if (duplicateIndex === -1) {
      kept.push(result);
      continue;
    }

    const existing = kept[duplicateIndex];
    if (preferEvidence(result, existing)) {
      kept[duplicateIndex] = result;
    }
  }

  return kept;
}

function isNearDuplicateEvidence(a: MemoryEvidenceRow, b: MemoryEvidenceRow): boolean {
  const aTokens = importantTokens(a.content);
  const bTokens = importantTokens(b.content);
  return tokenCoverage(aTokens, bTokens) >= 0.8 || tokenCoverage(bTokens, aTokens) >= 0.8;
}

function preferEvidence(candidate: MemoryEvidenceRow, existing: MemoryEvidenceRow): boolean {
  if (candidate.type === "source_excerpt" && existing.type !== "source_excerpt") {
    return candidate.content.length + 30 < existing.content.length;
  }

  if (candidate.type !== "source_excerpt" && existing.type === "source_excerpt") {
    return candidate.content.length <= existing.content.length + 30;
  }

  return candidate.content.length < existing.content.length
    || (candidate.content.length === existing.content.length && candidate.rank > existing.rank);
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
    ?? row.sourceEpisode?.toLowerCase()
    ?? row.content.match(/^session\s+([^:\s]+)\b/i)?.[1]?.toLowerCase();
}

function topEpisodeSnippets(
  content: string,
  queryTokens: string[],
  seedTokens: string[],
): string[] {
  const candidates = episodeSnippetCandidates(content)
    .map((snippet) => ({
      snippet,
      score: snippetScore(snippet, queryTokens, seedTokens),
      novelty: 1 - tokenCoverage(importantTokens(snippet), seedTokens),
    }))
    .filter((candidate) => candidate.score > 0 && candidate.novelty >= 0.25)
    .sort((a, b) => b.score - a.score || a.snippet.length - b.snippet.length);

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate.snippet.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    selected.push(candidate.snippet);
    seen.add(normalized);
    if (selected.length >= 2) {
      return selected;
    }
  }

  return selected;
}

function episodeSnippetCandidates(content: string): string[] {
  const chunks: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const role = trimmed.match(/^(user|human|assistant|system)\s*:\s*(.+)$/i);
    const body = role?.[2]?.trim() ?? trimmed;
    const speaker = role?.[1]?.toLowerCase();
    const keepAssistant = speaker === "assistant"
      && /\b(?:remember|decided|implemented|verified|changed|uses|depends|fixed)\b/i.test(body);
    if ((speaker === "assistant" || speaker === "system") && !keepAssistant) {
      continue;
    }

    for (const sentence of splitIntoSnippets(body)) {
      chunks.push(speaker ? `${speaker}: ${sentence}` : sentence);
    }
  }

  return chunks;
}

function episodeDigestCandidate(content: string): string | null {
  const candidates = episodeSnippetCandidates(content);
  if (content.length < 500 && candidates.length < 3) {
    return null;
  }

  const digest = candidates
    .filter((candidate) => !/^assistant:\s*(?:sure|okay|thanks|i can|i will|let)/i.test(candidate))
    .join(" | ")
    .slice(0, 3000)
    .trim();

  return digest.length >= 80 ? digest : null;
}

function splitIntoSnippets(value: string): string[] {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 260) {
    return [compact];
  }

  const pieces = compact
    .split(/(?<=[.!?])\s+/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (pieces.length === 0) {
    return [compact.slice(0, 260)];
  }

  const snippets: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const next = current ? `${current} ${piece}` : piece;
    if (next.length > 260 && current) {
      snippets.push(current);
      current = piece;
    } else {
      current = next;
    }
  }

  if (current) {
    snippets.push(current);
  }

  return snippets.map((snippet) => snippet.slice(0, 320));
}

function snippetScore(snippet: string, queryTokens: string[], seedTokens: string[]): number {
  const tokens = importantTokens(snippet);
  return sharedTokenScore(queryTokens, tokens) + (sharedTokenScore(seedTokens, tokens) * 0.35);
}

function tokenCoverage(tokens: string[], existingTokens: string[]): number {
  if (tokens.length === 0 || existingTokens.length === 0) {
    return 0;
  }

  const existing = new Set(existingTokens);
  const covered = tokens.filter((token) => existing.has(token)).length;
  return covered / tokens.length;
}

function isAbstention(value: string): boolean {
  return /\b(?:i don't know|unknown|insufficient|not enough)\b/i.test(value.trim());
}

function evidenceAlreadyContainsAnswer(evidence: RecallResult[], answer: string): boolean {
  const answerTokens = importantTokens(answer);
  if (answerTokens.length === 0) {
    const normalizedAnswer = answer.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalizedAnswer || /\b(?:i don't know|unknown|insufficient|not enough)\b/i.test(normalizedAnswer)) {
      return true;
    }

    return evidence
      .map((item) => item.content.toLowerCase().replace(/\s+/g, " "))
      .some((content) => content.includes(normalizedAnswer));
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
    "episode",
    "excerpt",
    "session",
    "source",
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
      ?.map((token) => token.replace(/^[._-]+|[._-]+$/g, ""))
      .filter((token) => token.length >= 4 && !stopwords.has(token)) ?? [],
  )].slice(0, 24);
}
