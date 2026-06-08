import { getSqlClient } from "../db/client.js";
import {
  hasEmbeddingVectorColumn,
  localEmbeddingFallbackEnabled,
  vectorLiteral,
} from "../db/embedding-vectors.js";
import { getEmbeddings } from "../providers/embeddings.js";

export interface RecallResult {
  id: string;
  type: string;
  scope: string;
  content: string;
  rank: number;
  createdAt: string;
}

interface MemoryRow {
  id: string;
  type: string;
  scope: string;
  content: string;
  embedding: number[] | null;
  createdAt: string;
}

type TemporalMemoryRow = RecallResult & {
  eventDate: string | null;
  temporalRefs: unknown;
};

type DatedTemporalMemoryRow = TemporalMemoryRow & {
  eventDate: string;
  date: Date;
};

const VECTOR_CANDIDATE_LIMIT = 500;

export async function vectorRecall(
  query: string,
  scope: string | undefined,
  k: number,
  asOf?: Date,
): Promise<RecallResult[]> {
  const [queryEmbedding] = await getEmbeddings().embed([query]);
  if (await hasEmbeddingVectorColumn("memories")) {
    return pgVectorRecall(queryEmbedding, scope, k, asOf);
  }

  if (!localEmbeddingFallbackEnabled()) {
    return [];
  }

  const sql = getSqlClient();

  const rows = asOf
    ? scope
      ? await sql<MemoryRow[]>`
          select
            id,
            type,
            scope,
            content,
            embedding,
            created_at::text as "createdAt"
          from memories
          where scope = ${scope}
            and embedding is not null
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit ${VECTOR_CANDIDATE_LIMIT}
        `
      : await sql<MemoryRow[]>`
          select
            id,
            type,
            scope,
            content,
            embedding,
            created_at::text as "createdAt"
          from memories
          where embedding is not null
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit ${VECTOR_CANDIDATE_LIMIT}
        `
    : scope
      ? await sql<MemoryRow[]>`
        select
          id,
          type,
          scope,
          content,
          embedding,
          created_at::text as "createdAt"
        from memories
        where status = 'active'
          and scope = ${scope}
          and embedding is not null
        order by created_at desc
        limit ${VECTOR_CANDIDATE_LIMIT}
      `
      : await sql<MemoryRow[]>`
        select
          id,
          type,
          scope,
          content,
          embedding,
          created_at::text as "createdAt"
        from memories
        where status = 'active'
          and embedding is not null
        order by created_at desc
        limit ${VECTOR_CANDIDATE_LIMIT}
      `;

  return rows
    .map((row) => ({
      id: row.id,
      type: row.type,
      scope: row.scope,
      content: row.content,
      rank: cosineSimilarity(queryEmbedding, row.embedding ?? []),
      createdAt: row.createdAt,
    }))
    .filter((row) => row.rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, k);
}

async function pgVectorRecall(
  queryEmbedding: number[],
  scope: string | undefined,
  k: number,
  asOf?: Date,
): Promise<RecallResult[]> {
  const sql = getSqlClient();
  const vector = vectorLiteral(queryEmbedding);

  return asOf
    ? scope
      ? await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            (1 - (embedding_vector <=> ${vector}::vector))::real as rank,
            created_at::text as "createdAt"
          from memories
          where scope = ${scope}
            and embedding_vector is not null
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by embedding_vector <=> ${vector}::vector
          limit ${k}
        `
      : await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            (1 - (embedding_vector <=> ${vector}::vector))::real as rank,
            created_at::text as "createdAt"
          from memories
          where embedding_vector is not null
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by embedding_vector <=> ${vector}::vector
          limit ${k}
        `
    : scope
      ? await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            (1 - (embedding_vector <=> ${vector}::vector))::real as rank,
            created_at::text as "createdAt"
          from memories
          where status = 'active'
            and scope = ${scope}
            and embedding_vector is not null
          order by embedding_vector <=> ${vector}::vector
          limit ${k}
        `
      : await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            (1 - (embedding_vector <=> ${vector}::vector))::real as rank,
            created_at::text as "createdAt"
          from memories
          where status = 'active'
            and embedding_vector is not null
          order by embedding_vector <=> ${vector}::vector
          limit ${k}
        `;
}

export async function ftsRecall(
  query: string,
  scope: string | undefined,
  k: number,
  asOf?: Date,
): Promise<RecallResult[]> {
  const sql = getSqlClient();

  return asOf
    ? scope
      ? await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            ts_rank(fts, websearch_to_tsquery('english', ${query}))::real as rank,
            created_at::text as "createdAt"
          from memories
          where scope = ${scope}
            and fts @@ websearch_to_tsquery('english', ${query})
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by rank desc, created_at desc
          limit ${k}
        `
      : await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            ts_rank(fts, websearch_to_tsquery('english', ${query}))::real as rank,
            created_at::text as "createdAt"
          from memories
          where fts @@ websearch_to_tsquery('english', ${query})
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by rank desc, created_at desc
          limit ${k}
        `
    : scope
      ? await sql<RecallResult[]>`
        select
          id,
          type,
          scope,
          content,
          ts_rank(fts, websearch_to_tsquery('english', ${query}))::real as rank,
          created_at::text as "createdAt"
        from memories
        where
          status = 'active'
          and scope = ${scope}
          and fts @@ websearch_to_tsquery('english', ${query})
        order by rank desc, created_at desc
        limit ${k}
      `
      : await sql<RecallResult[]>`
        select
          id,
          type,
          scope,
          content,
          ts_rank(fts, websearch_to_tsquery('english', ${query}))::real as rank,
          created_at::text as "createdAt"
        from memories
        where
          status = 'active'
          and fts @@ websearch_to_tsquery('english', ${query})
        order by rank desc, created_at desc
        limit ${k}
      `;
}

export async function keywordRecall(
  query: string,
  scope: string | undefined,
  k: number,
  asOf?: Date,
): Promise<RecallResult[]> {
  const sql = getSqlClient();
  const rows = asOf
    ? scope
      ? await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt"
          from memories
          where scope = ${scope}
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit 1000
        `
      : await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt"
          from memories
          where (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit 1000
        `
    : scope
      ? await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt"
          from memories
          where status = 'active'
            and scope = ${scope}
          order by created_at desc
          limit 1000
        `
      : await sql<RecallResult[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt"
          from memories
          where status = 'active'
          order by created_at desc
          limit 1000
        `;
  const queryTokens = meaningfulTokens(query);

  return rows
    .map((row) => ({
      ...row,
      rank: tokenOverlapScore(queryTokens, meaningfulTokens(row.content)),
    }))
    .filter((row) => row.rank > 0)
    .sort((a, b) => b.rank - a.rank || b.createdAt.localeCompare(a.createdAt))
    .slice(0, k);
}

export async function temporalRecall(
  query: string,
  scope: string | undefined,
  k: number,
  asOf?: Date,
): Promise<RecallResult[]> {
  if (!isTemporalQuery(query)) {
    return [];
  }

  const sql = getSqlClient();
  const rows = asOf
    ? scope
      ? await sql<Array<RecallResult & { eventDate: string | null; temporalRefs: unknown }>>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            attrs->'observation'->>'eventDate' as "eventDate",
            attrs->'observation'->'temporalRefs' as "temporalRefs"
          from memories
          where scope = ${scope}
            and (attrs->'observation'->>'eventDate' is not null
              or attrs->'observation'->'temporalRefs' is not null)
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit 1000
        `
      : await sql<Array<RecallResult & { eventDate: string | null; temporalRefs: unknown }>>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            attrs->'observation'->>'eventDate' as "eventDate",
            attrs->'observation'->'temporalRefs' as "temporalRefs"
          from memories
          where (attrs->'observation'->>'eventDate' is not null
              or attrs->'observation'->'temporalRefs' is not null)
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit 1000
        `
    : scope
      ? await sql<Array<RecallResult & { eventDate: string | null; temporalRefs: unknown }>>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            attrs->'observation'->>'eventDate' as "eventDate",
            attrs->'observation'->'temporalRefs' as "temporalRefs"
          from memories
          where status = 'active'
            and scope = ${scope}
            and (attrs->'observation'->>'eventDate' is not null
              or attrs->'observation'->'temporalRefs' is not null)
          order by created_at desc
          limit 1000
        `
      : await sql<Array<RecallResult & { eventDate: string | null; temporalRefs: unknown }>>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            attrs->'observation'->>'eventDate' as "eventDate",
            attrs->'observation'->'temporalRefs' as "temporalRefs"
          from memories
          where status = 'active'
            and (attrs->'observation'->>'eventDate' is not null
              or attrs->'observation'->'temporalRefs' is not null)
          order by created_at desc
          limit 1000
        `;

  const queryTokens = meaningfulTokens(query);
  const latest = /\b(?:latest|newest|recent|current|now)\b/i.test(query);
  const between = /\bbetween\b|\bhow many days\b|\bdays between\b/i.test(query);

  return rows
    .map((row) => {
      const lexical = tokenOverlapScore(queryTokens, meaningfulTokens(row.content));
      const dateScore = row.eventDate ? normalizedDateScore(row.eventDate) : 0.2;
      const temporalDensity = Array.isArray(row.temporalRefs) ? Math.min(row.temporalRefs.length, 5) / 10 : 0;
      const rank = between
        ? 0.55 + lexical * 0.35 + temporalDensity
        : latest
          ? 0.65 + dateScore * 0.3 + lexical * 0.2
          : 0.45 + lexical * 0.4 + dateScore * 0.15 + temporalDensity;

      return {
        id: row.id,
        type: row.type,
        scope: row.scope,
        content: row.content,
        rank,
        createdAt: row.createdAt,
      };
    })
    .filter((row) => row.rank > 0.45)
    .sort((a, b) => b.rank - a.rank || b.createdAt.localeCompare(a.createdAt))
    .slice(0, k);
}

export async function derivedTemporalRecall(
  query: string,
  scope: string | undefined,
  k: number,
  asOf?: Date,
): Promise<RecallResult[]> {
  if (!isTemporalQuery(query)) {
    return [];
  }

  const rows = await temporalMemoryRows(scope, asOf);
  const durationAnswer = derivedDurationAnswer(query, rows, scope);
  if (durationAnswer) {
    return [durationAnswer].slice(0, k);
  }

  const dated = rows
    .flatMap((row): DatedTemporalMemoryRow[] => {
      const date = parseDate(row.eventDate);
      return date && row.eventDate ? [{ ...row, eventDate: row.eventDate, date }] : [];
    });
  if (dated.length < 2) {
    return [];
  }

  const pair = selectTemporalPair(query, dated);
  if (pair.length < 2) {
    return [];
  }

  const [a, b] = pair;
  const days = Math.round(Math.abs(b.date.getTime() - a.date.getTime()) / 86_400_000);
  const sorted = [...pair].sort((left, right) => left.date.getTime() - right.date.getTime());
  const wantsFirst = /\b(?:which|what)\b.*\b(?:first|earlier)\b/i.test(query);
  const wantsBeforeAfter = /\b(?:before|after)\b/i.test(query) && !/\bhow many days\b/i.test(query);
  const content = wantsFirst || wantsBeforeAfter
    ? [
        `Derived temporal answer: ${eventLabel(sorted[0].content)} happened first.`,
        `${eventLabel(sorted[1].content)} happened after.`,
        `Evidence: "${summarizeTemporalEvidence(sorted[0].content)}" (${dateOnly(sorted[0].date)}) and "${summarizeTemporalEvidence(sorted[1].content)}" (${dateOnly(sorted[1].date)}).`,
      ].join(" ")
    : [
        `Derived temporal answer: ${formatDurationAnswer(days, query)}.`,
        `${days + 1} days including the last day is also acceptable.`,
        `Evidence: "${summarizeTemporalEvidence(a.content)}" (${dateOnly(a.date)}) and "${summarizeTemporalEvidence(b.content)}" (${dateOnly(b.date)}).`,
      ].join(" ");

  return [{
    id: `derived-temporal:${a.id}:${b.id}`,
    type: "derived_temporal",
    scope: scope ?? a.scope,
    content,
    rank: 1,
    createdAt: new Date().toISOString(),
  }].slice(0, k);
}

async function temporalMemoryRows(
  scope: string | undefined,
  asOf: Date | undefined,
): Promise<TemporalMemoryRow[]> {
  const sql = getSqlClient();
  return asOf
    ? scope
      ? await sql<TemporalMemoryRow[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            attrs->'observation'->>'eventDate' as "eventDate",
            attrs->'observation'->'temporalRefs' as "temporalRefs"
          from memories
          where scope = ${scope}
            and attrs->'observation'->>'eventDate' is not null
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit 1000
        `
      : await sql<TemporalMemoryRow[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            attrs->'observation'->>'eventDate' as "eventDate",
            attrs->'observation'->'temporalRefs' as "temporalRefs"
          from memories
          where attrs->'observation'->>'eventDate' is not null
            and (t_valid is null or t_valid <= ${asOf})
            and (t_invalid is null or t_invalid > ${asOf})
          order by created_at desc
          limit 1000
        `
    : scope
      ? await sql<TemporalMemoryRow[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            attrs->'observation'->>'eventDate' as "eventDate",
            attrs->'observation'->'temporalRefs' as "temporalRefs"
          from memories
          where status = 'active'
            and scope = ${scope}
            and attrs->'observation'->>'eventDate' is not null
          order by created_at desc
          limit 1000
        `
      : await sql<TemporalMemoryRow[]>`
          select
            id,
            type,
            scope,
            content,
            0::real as rank,
            created_at::text as "createdAt",
            attrs->'observation'->>'eventDate' as "eventDate",
            attrs->'observation'->'temporalRefs' as "temporalRefs"
          from memories
          where status = 'active'
            and attrs->'observation'->>'eventDate' is not null
          order by created_at desc
          limit 1000
        `;
}

function derivedDurationAnswer(
  query: string,
  rows: TemporalMemoryRow[],
  scope: string | undefined,
): RecallResult | undefined {
  const queryTokens = meaningfulTokens(query);
  const durationRows = rows
    .flatMap((row) => durationsFromRefs(row.temporalRefs).map((duration) => ({
      ...row,
      duration,
      rank: tokenOverlapScore(queryTokens, meaningfulTokens(row.content)),
    })))
    .filter((row) => row.rank > 0)
    .sort((a, b) => b.rank - a.rank);
  if (durationRows.length === 0) {
    return undefined;
  }

  if (/\b(?:combined|total|altogether|sum)\b/i.test(query)) {
    const selected = durationRows.slice(0, 4);
    const unit = dominantDurationUnit(selected.map((row) => row.duration));
    const totalDays = selected.reduce((sum, row) => sum + row.duration.days, 0);
    const amount = unit === "month"
      ? totalDays / 30
      : unit === "week"
        ? totalDays / 7
        : totalDays;
    return {
      id: `derived-duration:${selected.map((row) => row.id).join(":")}`,
      type: "derived_temporal",
      scope: scope ?? selected[0]?.scope ?? "global",
      content: [
        `Derived temporal answer: ${formatNumber(amount)} ${pluralUnit(unit, amount)}.`,
        `${numberWord(amount)} ${pluralUnit(unit, amount)}.`,
        `Evidence: ${selected.map((row) => `"${summarizeTemporalEvidence(row.content)}"`).join(" and ")}.`,
      ].join(" "),
      rank: 1,
      createdAt: new Date().toISOString(),
    };
  }

  const relativeRows = durationRows.filter((row) =>
    /\b(?:ago|advance|before|after|now)\b/i.test(row.duration.text),
  );
  if (relativeRows.length >= 2 && /\b(?:how many months ago|how long had|how long)\b/i.test(query)) {
    const selected = relativeRows.slice(0, 2);
    const totalDays = Math.abs(selected[0].duration.days - selected[1].duration.days);
    const unit = /\bmonths?\b/i.test(query) || selected.some((row) => row.duration.unit === "month")
      ? "month"
      : /\bweeks?\b/i.test(query) || selected.some((row) => row.duration.unit === "week")
        ? "week"
        : "day";
    const amount = unit === "month"
      ? Math.round(totalDays / 30)
      : unit === "week"
        ? Math.round(totalDays / 7)
        : Math.round(totalDays);

    return {
      id: `derived-duration-diff:${selected.map((row) => row.id).join(":")}`,
      type: "derived_temporal",
      scope: scope ?? selected[0]?.scope ?? "global",
      content: [
        `Derived temporal answer: ${formatNumber(amount)} ${pluralUnit(unit, amount)}${/\bago\b/i.test(query) ? " ago" : ""}.`,
        `${numberWord(amount)} ${pluralUnit(unit, amount)}${/\bago\b/i.test(query) ? " ago" : ""}.`,
        `Evidence: ${selected.map((row) => `"${summarizeTemporalEvidence(row.content)}"`).join(" and ")}.`,
      ].join(" "),
      rank: 1,
      createdAt: new Date().toISOString(),
    };
  }

  return undefined;
}

function durationsFromRefs(value: unknown): Array<{
  text: string;
  amount: number;
  unit: "day" | "week" | "month" | "year";
  days: number;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const record = item as Record<string, unknown>;
      const amount = typeof record.amount === "number" ? record.amount : undefined;
      const unit = typeof record.unit === "string" ? record.unit : undefined;
      const days = typeof record.days === "number" ? record.days : undefined;
      const text = typeof record.text === "string" ? record.text : undefined;
      if (!amount || !unit || !days || !text || !["day", "week", "month", "year"].includes(unit)) {
        return undefined;
      }
      return { text, amount, unit: unit as "day" | "week" | "month" | "year", days };
    })
    .filter((item): item is {
      text: string;
      amount: number;
      unit: "day" | "week" | "month" | "year";
      days: number;
    } => Boolean(item));
}

function dominantDurationUnit(durations: Array<{ unit: "day" | "week" | "month" | "year" }>): "day" | "week" | "month" | "year" {
  const counts = new Map<"day" | "week" | "month" | "year", number>();
  for (const duration of durations) {
    counts.set(duration.unit, (counts.get(duration.unit) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "day";
}

function formatDurationAnswer(days: number, query: string): string {
  if (/\bmonths?\b/i.test(query) && days >= 28) {
    const months = Math.round(days / 30);
    return `${months} ${pluralUnit("month", months)}. ${numberWord(months)} ${pluralUnit("month", months)}`;
  }

  if (/\bweeks?\b|\bhow long\b/i.test(query) && days >= 7 && days % 7 === 0) {
    const weeks = days / 7;
    return `${weeks} ${pluralUnit("week", weeks)}. ${numberWord(weeks)} ${pluralUnit("week", weeks)}`;
  }

  return `${days} days`;
}

function pluralUnit(unit: "day" | "week" | "month" | "year", amount: number): string {
  return amount === 1 ? unit : `${unit}s`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

function numberWord(value: number): string {
  const words: Record<number, string> = {
    1: "One",
    2: "Two",
    3: "Three",
    4: "Four",
    5: "Five",
    6: "Six",
    7: "Seven",
    8: "Eight",
    9: "Nine",
    10: "Ten",
    11: "Eleven",
    12: "Twelve",
  };
  return Number.isInteger(value) && words[value] ? words[value] : formatNumber(value);
}

function selectTemporalPair(
  query: string,
  rows: DatedTemporalMemoryRow[],
): DatedTemporalMemoryRow[] {
  const parts = temporalQuestionParts(query);
  if (parts.length >= 2) {
    const selected: DatedTemporalMemoryRow[] = [];
    for (const part of parts.slice(0, 2)) {
      const best = bestTemporalRow(part, rows.filter((row) => !selected.some((item) => item.id === row.id)));
      if (best) {
        selected.push(best);
      }
    }
    if (selected.length >= 2) {
      return selected;
    }
  }

  const queryTokens = meaningfulTokens(query);
  return rows
    .map((row) => ({
      ...row,
      rank: tokenOverlapScore(queryTokens, meaningfulTokens(row.content)),
    }))
    .filter((row) => row.rank > 0)
    .sort((left, right) => right.rank - left.rank || left.date.getTime() - right.date.getTime())
    .slice(0, 2);
}

function bestTemporalRow(
  part: string,
  rows: DatedTemporalMemoryRow[],
): DatedTemporalMemoryRow | undefined {
  const tokens = meaningfulTokens(part);
  return rows
    .map((row) => ({
      ...row,
      rank: tokenOverlapScore(tokens, meaningfulTokens(row.content)),
    }))
    .sort((left, right) => right.rank - left.rank || right.createdAt.localeCompare(left.createdAt))[0];
}

function temporalQuestionParts(query: string): string[] {
  const between = query.match(/\bbetween\s+(.+?)\s+and\s+(.+?)(?:[?.]|$)/i);
  if (between) {
    return [between[1], between[2]].map(cleanTemporalPart).filter(Boolean);
  }

  const beforeAfterDid = query.match(/\bhow many days\s+(?:before|after)\s+(.+?)\s+did\s+(?:i|we)\s+(.+?)(?:[?.]|$)/i);
  if (beforeAfterDid) {
    return [beforeAfterDid[1], beforeAfterDid[2]].map(cleanTemporalPart).filter(Boolean);
  }

  const first = query.match(/\b(?:which|what)\s+event\s+happened\s+first,?\s+(.+?)\s+or\s+(.+?)(?:[?.]|$)/i);
  if (first) {
    return [first[1], first[2]].map(cleanTemporalPart).filter(Boolean);
  }

  return query.split(/\b(?:and|or|then|versus|vs)\b/i).map(cleanTemporalPart).filter((part) => part.length >= 4);
}

function cleanTemporalPart(value: string | undefined): string {
  return (value ?? "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\b(?:happen(?:ed)?|occur(?:red)?|date|event|purchase of|malfunction of)\b/gi, "")
    .trim();
}

function parseDate(value: string | null): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function eventLabel(value: string): string {
  return summarizeTemporalEvidence(value)
    .replace(/^(?:i\s+)?(?:just|recently|had|have|got|came|attended|participated|bought|purchased)\s+/i, "")
    .replace(/\.$/, "")
    .trim();
}

function summarizeTemporalEvidence(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
}

export async function graphRecall(
  query: string,
  scope: string | undefined,
  k: number,
  asOf?: Date,
): Promise<RecallResult[]> {
  const sql = getSqlClient();

  const scopedPredicate = scope
    ? sql`and ent.scope = ${scope}`
    : sql``;
  const edgeScopePredicate = scope
    ? sql`and e.scope = ${scope}`
    : sql``;
  const edgeTimePredicate = asOf
    ? sql`and (e.t_valid is null or e.t_valid <= ${asOf})
           and (e.t_invalid is null or e.t_invalid > ${asOf})`
    : sql`and e.t_expired is null`;

  return sql<RecallResult[]>`
    with recursive matched_entities as (
      select ent.id, ent.scope
      from entities ent
      where lower(${query}) like '%' || lower(ent.name) || '%'
        ${scopedPredicate}
    ),
    walk(entity_id, edge_id, scope, fact, depth, path) as (
      select
        case when e.src = m.id then e.dst else e.src end,
        e.id,
        e.scope,
        e.fact,
        1,
        array[m.id, case when e.src = m.id then e.dst else e.src end]
      from edges e
      join matched_entities m on e.src = m.id or e.dst = m.id
      where e.fact is not null
        ${edgeScopePredicate}
        ${edgeTimePredicate}

      union all

      select
        case when e.src = w.entity_id then e.dst else e.src end,
        e.id,
        e.scope,
        e.fact,
        w.depth + 1,
        w.path || case when e.src = w.entity_id then e.dst else e.src end
      from edges e
      join walk w on e.src = w.entity_id or e.dst = w.entity_id
      where w.depth < 2
        and e.fact is not null
        and not (case when e.src = w.entity_id then e.dst else e.src end = any(w.path))
        ${edgeScopePredicate}
        ${edgeTimePredicate}
    )
    select distinct on (edge_id)
      edge_id::text as id,
      'graph_fact' as type,
      scope,
      fact as content,
      (1.0 / depth)::real as rank,
      now()::text as "createdAt"
    from walk
    order by edge_id, depth asc
    limit ${k}
  `;
}

function isTemporalQuery(query: string): boolean {
  return /\b(?:after|ago|before|between|combined|current|date|days?|duration|how long|latest|last|months?|newest|recent|today|tomorrow|week|when|yesterday)\b/i
    .test(query);
}

function normalizedDateScore(value: string): number {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return 0;
  }

  return Math.max(0, Math.min(1, time / Date.now()));
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) {
    return 0;
  }

  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;

  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    aMagnitude += a[i] * a[i];
    bMagnitude += b[i] * b[i];
  }

  if (aMagnitude === 0 || bMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}

function tokenOverlapScore(queryTokens: string[], contentTokens: string[]): number {
  if (queryTokens.length === 0 || contentTokens.length === 0) {
    return 0;
  }

  const contentSet = new Set(contentTokens);
  const shared = new Set(queryTokens.filter((token) => contentSet.has(token)));
  return shared.size / queryTokens.length;
}

function meaningfulTokens(value: string): string[] {
  const stopwords = new Set([
    "a",
    "about",
    "after",
    "an",
    "and",
    "are",
    "as",
    "be",
    "by",
    "did",
    "do",
    "does",
    "for",
    "from",
    "had",
    "has",
    "have",
    "how",
    "i",
    "in",
    "is",
    "it",
    "my",
    "of",
    "on",
    "or",
    "the",
    "this",
    "to",
    "was",
    "were",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "with",
  ]);

  return [...new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9_.-]+/g)
      ?.filter((token) => token.length > 2 && !stopwords.has(token)) ?? [],
  )];
}
