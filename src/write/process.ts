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
  const extracted = await extractEpisode(
    episode.content,
    occurredAtForExtraction(episode.content, episode.occurredAt),
  );
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

function occurredAtForExtraction(content: string, fallback: Date): Date {
  const raw = metadataValue(content, "LongMemEval session_date")
    ?? metadataValue(content, "session_date")
    ?? metadataValue(content, "Session date");
  if (!raw) {
    return fallback;
  }

  const parsed = parseLongMemEvalDate(raw);
  return parsed ?? fallback;
}

function metadataValue(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"))?.[1]?.trim();
}

function parseLongMemEvalDate(value: string): Date | undefined {
  const normalized = value.trim();
  const slash = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (slash) {
    return validDate(Number(slash[1]), Number(slash[2]) - 1, Number(slash[3]));
  }

  const dash = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (dash) {
    return validDate(Number(dash[1]), Number(dash[2]) - 1, Number(dash[3]));
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function validDate(year: number, month: number, day: number): Date | undefined {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month
    && date.getUTCDate() === day
    ? date
    : undefined;
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
