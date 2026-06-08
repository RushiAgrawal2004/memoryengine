import * as z from "zod/v4";
import { getLLM } from "../providers/llm.js";

export const temporalReferenceSchema = z.object({
  text: z.string(),
  kind: z.string().optional(),
  resolvedDate: z.string().optional(),
  direction: z.enum(["before", "after"]).optional(),
  eventText: z.string().optional(),
  amount: z.number().optional(),
  unit: z.string().optional(),
  days: z.number().optional(),
});

export const extractedFactSchema = z.object({
  fact: z.string().min(1),
  temporalRefs: z.array(temporalReferenceSchema).default([]),
  sourceSessionId: z.string().optional(),
  speaker: z.string().optional(),
  observationText: z.string().optional(),
  sessionDate: z.string().optional(),
  mentionedDate: z.string().optional(),
  eventDate: z.string().optional(),
  mentionedAt: z.string().optional(),
  observationType: z.enum([
    "user_fact",
    "preference",
    "update",
    "temporal_event",
    "assistant_durable_info",
  ]).optional(),
});

export const extractedEntitySchema = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
});

export const extractedRelationSchema = z.object({
  srcName: z.string().min(1),
  srcKind: z.string().min(1).optional(),
  relation: z.string().min(1),
  dstName: z.string().min(1),
  dstKind: z.string().min(1).optional(),
  fact: z.string().min(1),
  tValid: z.string().optional(),
});

const extractionSchema = z.object({
  facts: z.array(extractedFactSchema),
  entities: z.array(extractedEntitySchema).default([]),
  relations: z.array(extractedRelationSchema).default([]),
});

export type ExtractedFact = z.infer<typeof extractedFactSchema>;
export type ExtractedEntity = z.infer<typeof extractedEntitySchema>;
export type ExtractedRelation = z.infer<typeof extractedRelationSchema>;
export type ExtractedEpisode = z.infer<typeof extractionSchema>;

export async function extractEpisode(
  episodeText: string,
  occurredAt = new Date(),
): Promise<ExtractedEpisode> {
  return getLLM().json(
    [
      "Extract durable, atomic observations from a coding-agent memory episode.",
      "For role-prefixed chat, preserve sourceSessionId when present, speaker, observationText, sessionDate, mentionedDate, eventDate, mentionedAt, temporalRefs, and observationType.",
      "Use observationType user_fact, preference, update, temporal_event, or assistant_durable_info.",
      "Normalize explicit dates and relative dates into ISO eventDate where possible, using occurred_at as the reference time.",
      "Keep before/after event phrases and duration candidates in temporalRefs even when they do not resolve to a date.",
      "Ignore generic assistant advice, boilerplate, and step-by-step suggestions unless the user explicitly asked to remember it.",
      "Do not use LongMemEval answer labels, answer_session_ids, or has_answer markers to decide what is production memory.",
      "Resolve temporal references relative to the occurred_at timestamp.",
    ].join(" "),
    `Occurred at: ${occurredAt.toISOString()}\nEpisode text: ${episodeText}`,
    extractionSchema,
  );
}

export async function extractFacts(
  episodeText: string,
  occurredAt = new Date(),
): Promise<ExtractedFact[]> {
  const output = await extractEpisode(episodeText, occurredAt);
  return output.facts;
}
