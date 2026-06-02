import * as z from "zod/v4";
import { getLLM } from "../providers/llm.js";

export const temporalReferenceSchema = z.object({
  text: z.string(),
  resolvedDate: z.string(),
});

export const extractedFactSchema = z.object({
  fact: z.string().min(1),
  temporalRefs: z.array(temporalReferenceSchema).default([]),
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
    "Extract atomic, self-contained facts from a coding-agent memory episode. Resolve temporal references relative to the occurred_at timestamp.",
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
