import { getSqlClient } from "./client.js";

export interface TraceInput {
  kind: "retrieve" | "ingest";
  scope?: string;
  query?: string;
  payload: Record<string, unknown>;
  latencyMs?: number;
}

export interface TraceRow {
  id: string;
  kind: string;
  scope: string | null;
  query: string | null;
  payload: Record<string, unknown>;
  latencyMs: number | null;
  createdAt: Date;
}

const TRACE_LIMIT = 200;

export async function saveTrace(input: TraceInput): Promise<void> {
  try {
    const sql = getSqlClient();
    await sql.begin(async (tx) => {
      await tx`
        insert into traces (kind, scope, query, payload, latency_ms)
        values (
          ${input.kind},
          ${input.scope ?? null},
          ${input.query ?? null},
          ${tx.json(input.payload as never)},
          ${input.latencyMs ?? null}
        )
      `;
      await tx`
        delete from traces
        where id not in (
          select id
          from traces
          order by created_at desc
          limit ${TRACE_LIMIT}
        )
      `;
    });
  } catch (error) {
    console.warn(`[memory-engine] trace write failed: ${String(error)}`);
  }
}

export async function listTraces(input: {
  q?: string;
  scope?: string;
  limit?: number;
} = {}): Promise<TraceRow[]> {
  const sql = getSqlClient();
  const query = searchPattern(input.q);
  const scope = normalized(input.scope);

  try {
    return await sql<TraceRow[]>`
      select
        id,
        kind,
        scope,
        query,
        payload,
        latency_ms as "latencyMs",
        created_at as "createdAt"
      from traces
      where (${scope}::text is null or scope = ${scope})
        and (
          ${query}::text is null
          or kind ilike ${query}
          or scope ilike ${query}
          or query ilike ${query}
          or payload::text ilike ${query}
        )
      order by created_at desc
      limit ${limitFor(input.limit)}
    `;
  } catch (error) {
    if (isUndefinedTable(error)) {
      return [];
    }
    throw error;
  }
}

function normalized(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function searchPattern(value: string | undefined): string | null {
  const trimmed = normalized(value);
  return trimmed ? `%${trimmed}%` : null;
}

function limitFor(value: number | undefined): number {
  if (!value || Number.isNaN(value)) {
    return 50;
  }

  return Math.min(Math.max(Math.trunc(value), 1), 100);
}

function isUndefinedTable(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: string }).code === "42P01",
  );
}
