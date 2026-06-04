import { getMemorySession, MemorySession } from "../db/sessions.js";
import { captureEpisode } from "./capture.js";
import { extractEpisode } from "./extract.js";
import { AppliedMemoryOperation, ingestFacts } from "./memory-ops.js";

export interface RememberInput {
  text: string;
  scope?: string;
  sessionId?: string;
  requireSession?: boolean;
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

export class MemorySessionRequiredError extends Error {
  readonly code = "MEMORY_SESSION_REQUIRED";

  constructor() {
    super("memory.remember requires a sessionId from memory.activate for this chat window");
  }
}

export class MemorySessionInvalidError extends Error {
  readonly code = "MEMORY_SESSION_INVALID";

  constructor(message: string) {
    super(message);
  }
}

export async function remember(input: RememberInput): Promise<RememberResult> {
  const session = await resolveSession(input);
  const episode = await captureEpisode({
    text: input.text,
    scope: session?.scope ?? input.scope,
    sessionId: session?.id,
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

async function resolveSession(input: RememberInput): Promise<MemorySession | undefined> {
  if (!input.sessionId) {
    if (input.requireSession) {
      throw new MemorySessionRequiredError();
    }
    return undefined;
  }

  const session = await getMemorySession(input.sessionId);
  if (!session) {
    throw new MemorySessionInvalidError(`memory session ${input.sessionId} was not found`);
  }
  if (session.status !== "active") {
    throw new MemorySessionInvalidError(`memory session ${input.sessionId} is not active`);
  }
  if (input.scope && input.scope !== session.scope) {
    throw new MemorySessionInvalidError(
      `memory session ${input.sessionId} belongs to scope ${session.scope}, not ${input.scope}`,
    );
  }

  return session;
}
