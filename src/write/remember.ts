import { captureEpisode } from "./capture.js";
import { extractEpisode } from "./extract.js";
import { AppliedMemoryOperation, ingestFacts } from "./memory-ops.js";

export interface RememberInput {
  text: string;
  scope?: string;
  sessionId?: string;
}

export interface RememberResult {
  episodeId: string;
  sessionId?: string;
  facts: string[];
  operations: AppliedMemoryOperation[];
  graph: {
    entities: number;
    relations: number;
  };
}

export async function remember(input: RememberInput): Promise<RememberResult> {
  const episode = await captureEpisode({
    text: input.text,
    scope: input.scope,
    sessionId: input.sessionId,
    source: "explicit_mcp",
    kind: "message",
  });
  const extracted = await extractEpisode(episode.content, episode.occurredAt);
  const operations = await ingestFacts(extracted.facts, {
    scope: episode.scope,
    sourceEpisode: episode.id,
    sourceSession: episode.sessionId,
    entities: extracted.entities,
    relations: extracted.relations,
  });

  return {
    episodeId: episode.id,
    sessionId: episode.sessionId,
    facts: extracted.facts.map((fact) => fact.fact),
    operations,
    graph: {
      entities: extracted.entities.length,
      relations: extracted.relations.length,
    },
  };
}
