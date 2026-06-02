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

const extractionSchema = z.object({
  facts: z.array(extractedFactSchema),
});

export type ExtractedFact = z.infer<typeof extractedFactSchema>;

export async function extractFacts(
  episodeText: string,
  occurredAt = new Date(),
): Promise<ExtractedFact[]> {
  const output = await getLLM().json(
    "Extract atomic, self-contained facts from a coding-agent memory episode. Resolve temporal references relative to the occurred_at timestamp.",
    `Occurred at: ${occurredAt.toISOString()}\nEpisode text: ${episodeText}`,
    extractionSchema,
  );

  return output.facts;
}
