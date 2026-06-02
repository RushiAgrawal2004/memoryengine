import { getSqlClient } from "../db/client.js";

export interface CapturedEpisode {
  id: string;
  content: string;
  scope: string;
  occurredAt: Date;
}

export interface CaptureEpisodeInput {
  text: string;
  scope?: string;
  source?: string;
  kind?: string;
  occurredAt?: Date;
}

const DEFAULT_SCOPE = "global";

export async function captureEpisode(input: CaptureEpisodeInput): Promise<CapturedEpisode> {
  const sql = getSqlClient();
  const occurredAt = input.occurredAt ?? new Date();
  const scope = input.scope ?? DEFAULT_SCOPE;

  const [row] = await sql<Array<{ id: string; occurredAt: Date }>>`
    insert into episodes (scope, kind, content, source, occurred_at)
    values (
      ${scope},
      ${input.kind ?? "message"},
      ${input.text},
      ${input.source ?? "explicit_mcp"},
      ${occurredAt}
    )
    returning id, occurred_at as "occurredAt"
  `;

  return {
    id: row.id,
    content: input.text,
    scope,
    occurredAt: row.occurredAt,
  };
}
