import { getLLM } from "../providers/llm.js";

export interface AnswerQuestionInput {
  question: string;
  evidence: string[];
  asOf?: Date;
}

export async function answerQuestion(input: AnswerQuestionInput): Promise<string> {
  const evidence = input.evidence
    .map((item, index) => `[${index + 1}] ${item}`)
    .join("\n");

  const answer = await getLLM().chat(
    [
      "Answer a long-term memory question using only the provided evidence.",
      "Keep the answer short and direct.",
      "If the evidence is insufficient, answer: I don't know.",
      "For dates, durations, before/after, and counts, calculate carefully from the evidence.",
    ].join(" "),
    [
      input.asOf ? `Question date: ${input.asOf.toISOString()}` : undefined,
      `Question: ${input.question}`,
      "Evidence:",
      evidence || "(none)",
    ].filter(Boolean).join("\n"),
  );

  return answer.trim();
}
