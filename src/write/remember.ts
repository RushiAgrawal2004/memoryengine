import { captureEpisode } from "./capture.js";
import { extractFacts } from "./extract.js";
import { AppliedMemoryOperation, ingestFacts } from "./memory-ops.js";

export interface RememberInput {
  text: string;
  scope?: string;
}

export interface RememberResult {
  episodeId: string;
  facts: string[];
  operations: AppliedMemoryOperation[];
}

export async function remember(input: RememberInput): Promise<RememberResult> {
  const episode = await captureEpisode({
    text: input.text,
    scope: input.scope,
    source: "explicit_mcp",
    kind: "message",
  });
  const facts = await extractFacts(episode.content, episode.occurredAt);
  const operations = await ingestFacts(facts, {
    scope: episode.scope,
    sourceEpisode: episode.id,
  });

  return {
    episodeId: episode.id,
    facts: facts.map((fact) => fact.fact),
    operations,
  };
}
