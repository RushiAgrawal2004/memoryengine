import { getSqlClient } from "./client.js";
import type { RepoRef } from "./schema.js";

export interface EpisodeRecord {
  id: string;
  sessionId: string | null;
  scope: string;
  kind: string;
  content: string;
  source: string;
  repoRef: RepoRef | null;
  occurredAt: Date;
}

export async function getEpisode(episodeId: string): Promise<EpisodeRecord | undefined> {
  const sql = getSqlClient();
  const [episode] = await sql<EpisodeRecord[]>`
    select
      id,
      session_id as "sessionId",
      scope,
      kind,
      content,
      source,
      repo_ref as "repoRef",
      occurred_at as "occurredAt"
    from episodes
    where id = ${episodeId}
  `;

  return episode;
}
