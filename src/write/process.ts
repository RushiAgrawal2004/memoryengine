import { getEpisode, EpisodeRecord } from "../db/episodes.js";
import { extractEpisode } from "./extract.js";
import { AppliedMemoryOperation, ingestFacts } from "./memory-ops.js";

export interface ProcessEpisodeResult {
  episodeId: string;
  sessionId?: string;
  facts: string[];
  operations: AppliedMemoryOperation[];
  graph: {
    entities: number;
    relations: number;
  };
}

export async function processCapturedEpisode(
  episode: {
    id: string;
    sessionId?: string | null;
    scope: string;
    content: string;
    occurredAt: Date;
  },
): Promise<ProcessEpisodeResult> {
  const extracted = await extractEpisode(episode.content, episode.occurredAt);
  const operations = await ingestFacts(extracted.facts, {
    scope: episode.scope,
    sourceEpisode: episode.id,
    sourceSession: episode.sessionId ?? undefined,
    entities: extracted.entities,
    relations: extracted.relations,
  });

  return {
    episodeId: episode.id,
    sessionId: episode.sessionId ?? undefined,
    facts: extracted.facts.map((fact) => fact.fact),
    operations,
    graph: {
      entities: extracted.entities.length,
      relations: extracted.relations.length,
    },
  };
}

export async function processEpisodeById(episodeId: string): Promise<ProcessEpisodeResult> {
  const episode = await getEpisode(episodeId);
  if (!episode) {
    throw new Error(`episode ${episodeId} was not found`);
  }

  return processCapturedEpisode(toProcessableEpisode(episode));
}

function toProcessableEpisode(episode: EpisodeRecord): Parameters<typeof processCapturedEpisode>[0] {
  return {
    id: episode.id,
    sessionId: episode.sessionId,
    scope: episode.scope,
    content: episode.content,
    occurredAt: episode.occurredAt,
  };
}
