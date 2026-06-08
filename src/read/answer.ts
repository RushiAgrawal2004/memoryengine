import * as z from "zod/v4";
import { config } from "../lib/config.js";
import { getLLM } from "../providers/llm.js";

export interface AnswerQuestionInput {
  question: string;
  evidence: string[];
  asOf?: Date;
  debug?: boolean;
}

export interface AnswerQuestionOutput {
  answer: string;
  rationale?: string;
  usedEvidence?: number[];
}

const answerSchema = z.object({
  answer: z.string(),
  rationale: z.string().optional(),
  usedEvidence: z.array(z.number().int().positive()).optional(),
});

export async function answerQuestion(
  input: AnswerQuestionInput & { debug: true },
): Promise<AnswerQuestionOutput>;
export async function answerQuestion(input: AnswerQuestionInput): Promise<string>;
export async function answerQuestion(
  input: AnswerQuestionInput,
): Promise<string | AnswerQuestionOutput> {
  if (config.llmProvider !== "hosted") {
    const local = composeLocalAnswer(input);
    return input.debug ? local : local.answer;
  }

  const output = input.debug
    ? await getLLM().json(systemPrompt(true), userPrompt(input), answerSchema)
    : {
        answer: await getLLM().chat(systemPrompt(false), userPrompt(input)),
      };
  const answer = cleanAnswer(output.answer);
  const result = {
    ...output,
    answer,
  };

  return input.debug ? result : result.answer;
}

function systemPrompt(debug: boolean): string {
  return [
    "Answer a long-term memory question using only the provided evidence.",
    "Answer briefly and directly.",
    "Do not use outside knowledge.",
    "Calculate date differences when dates are present in evidence.",
    "For before/after questions, compare the event dates in the evidence.",
    "Prefer active/latest facts when evidence conflicts or updates older facts.",
    "If evidence is insufficient, answer exactly: I don't know.",
    debug
      ? "Return JSON with answer, optional rationale, and optional usedEvidence indexes."
      : "Return only the final answer text, with no markdown or rationale.",
  ].join(" ");
}

function userPrompt(input: AnswerQuestionInput): string {
  return [
    input.asOf ? `Question date: ${input.asOf.toISOString()}` : undefined,
    `Question: ${input.question}`,
    "Evidence:",
    formatEvidence(input.evidence),
  ].filter(Boolean).join("\n");
}

function formatEvidence(evidence: string[]): string {
  if (evidence.length === 0) {
    return "(none)";
  }

  return evidence.map((item, index) => `[${index + 1}] ${item}`).join("\n");
}

function composeLocalAnswer(input: AnswerQuestionInput): AnswerQuestionOutput {
  const evidence = input.evidence.map(stripEvidencePrefix).filter(Boolean);
  if (evidence.length === 0) {
    return {
      answer: "I don't know.",
      rationale: "No evidence was provided.",
      usedEvidence: [],
    };
  }

  const question = input.question.toLowerCase();
  const dateAnswer = answerDateQuestion(question, evidence);
  if (dateAnswer) {
    return dateAnswer;
  }

  const latest = answerLatestFact(question, evidence);
  if (latest) {
    return latest;
  }

  const direct = answerDirectFact(question, evidence);
  if (direct) {
    return direct;
  }

  return {
    answer: "I don't know.",
    rationale: "The evidence did not contain enough overlapping facts to answer.",
    usedEvidence: [],
  };
}

function answerDateQuestion(
  question: string,
  evidence: string[],
): AnswerQuestionOutput | undefined {
  const dated = evidence
    .flatMap((item, index) =>
      datedSegments(item).map((text) => ({ index, text, date: firstDate(text) }))
    )
    .filter((item): item is { index: number; text: string; date: Date } => Boolean(item.date));

  if (dated.length < 2) {
    return undefined;
  }

  const selected = selectDatedEvidence(question, dated);
  if (selected.length < 2) {
    return undefined;
  }

  const [first, second] = selected.sort((a, b) => a.date.getTime() - b.date.getTime());
  if (/\b(?:how many days|days between|duration between|how long between|time between)\b/i.test(question)) {
    const days = Math.round(
      Math.abs(second.date.getTime() - first.date.getTime()) / (24 * 60 * 60 * 1000),
    );
    return {
      answer: `${days} days.`,
      rationale: `Computed from ${isoDate(first.date)} and ${isoDate(second.date)}.`,
      usedEvidence: [first.index + 1, second.index + 1],
    };
  }

  if (/\b(?:before|after)\b/i.test(question)) {
    const subject = bestSubjectForBeforeAfter(question, selected);
    const other = selected.find((item) => item !== subject) ?? selected[0];
    const relation = subject.date.getTime() < other.date.getTime() ? "before" : "after";
    return {
      answer: `${stripArticle(eventName(subject.text))} happened ${relation}.`,
      rationale: `Compared ${isoDate(subject.date)} with ${isoDate(other.date)}.`,
      usedEvidence: [subject.index + 1, other.index + 1],
    };
  }

  return undefined;
}

function datedSegments(value: string): string[] {
  const segments = value
    .replace(/^Source episode context:\s*/i, "")
    .split(/\s+\|\s+|(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  return segments.length > 0 ? segments : [value];
}

function answerLatestFact(question: string, evidence: string[]): AnswerQuestionOutput | undefined {
  if (!/\b(?:latest|newest|current|now|use now|active)\b/i.test(question)) {
    return undefined;
  }

  const scored = evidence
    .map((item, index) => ({
      item,
      index,
      date: firstDate(item),
      score: tokenOverlap(question, item),
    }))
    .filter((item) => item.score > 0 || item.date)
    .sort((a, b) =>
      (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0)
      || b.score - a.score
      || b.index - a.index
    );

  const best = scored[0];
  if (!best) {
    return undefined;
  }

  return {
    answer: cleanFactSentence(best.item),
    rationale: "Selected the latest dated or most relevant active fact.",
    usedEvidence: [best.index + 1],
  };
}

function answerDirectFact(question: string, evidence: string[]): AnswerQuestionOutput | undefined {
  const scored = evidence
    .map((item, index) => ({
      item,
      index,
      score: tokenOverlap(question, item),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const best = scored[0];
  if (!best || best.score < 0.15) {
    return undefined;
  }

  return {
    answer: extractShortAnswer(question, best.item),
    rationale: "Selected the evidence item with the strongest lexical overlap.",
    usedEvidence: [best.index + 1],
  };
}

function selectDatedEvidence(
  question: string,
  dated: Array<{ index: number; text: string; date: Date }>,
): Array<{ index: number; text: string; date: Date }> {
  const betweenParts = question.match(/\bbetween\s+(.+?)\s+and\s+(.+?)(?:[?.]|$)/i);
  if (betweenParts) {
    const selected = [betweenParts[1], betweenParts[2]]
      .map((part) => bestDatedMatch(part, dated))
      .filter((item): item is { index: number; text: string; date: Date } => Boolean(item));
    const unique = uniqueDatedMentions(selected);
    if (unique.length >= 2) {
      return unique.slice(0, 2);
    }
  }

  const tokens = meaningfulTokens(question);
  const scored = dated
    .map((item) => ({
      ...item,
      score: tokenOverlap(tokens.join(" "), item.text),
    }))
    .sort((a, b) => b.score - a.score || a.date.getTime() - b.date.getTime());

  const positive = scored.filter((item) => item.score > 0);
  return (positive.length >= 2 ? positive : scored).slice(0, 2);
}

function bestDatedMatch(
  subject: string,
  dated: Array<{ index: number; text: string; date: Date }>,
): { index: number; text: string; date: Date } | undefined {
  const tokens = meaningfulTokens(subject);
  return dated
    .map((item) => ({
      ...item,
      score: sharedCount(tokens, meaningfulTokens(item.text)),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length)[0];
}

function uniqueDatedMentions(
  dated: Array<{ index: number; text: string; date: Date }>,
): Array<{ index: number; text: string; date: Date }> {
  const seen = new Set<string>();
  const unique: Array<{ index: number; text: string; date: Date }> = [];
  for (const item of dated) {
    const key = `${item.date.toISOString()}:${item.text.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function bestSubjectForBeforeAfter(
  question: string,
  selected: Array<{ index: number; text: string; date: Date }>,
): { index: number; text: string; date: Date } {
  const beforeAfter = question.match(/\bdid\s+(.+?)\s+happen\s+(?:before|after)\b/i)?.[1]
    ?? question.match(/\bwas\s+(.+?)\s+(?:before|after)\b/i)?.[1]
    ?? "";
  const subjectTokens = meaningfulTokens(beforeAfter);
  return selected
    .map((item) => ({
      ...item,
      score: sharedCount(subjectTokens, meaningfulTokens(item.text)),
    }))
    .sort((a, b) => b.score - a.score)[0] ?? selected[0];
}

function firstDate(value: string): Date | undefined {
  const slash = value.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slash) {
    const year = slash[3]
      ? normalizeYear(Number(slash[3]))
      : new Date().getUTCFullYear();
    return validDate(year, Number(slash[1]) - 1, Number(slash[2]));
  }

  const iso = value.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    return validDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  const monthPattern = Object.keys(months).join("|");
  const monthFirst = value.match(new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i"));
  if (monthFirst) {
    return validDate(
      monthFirst[3] ? Number(monthFirst[3]) : new Date().getUTCFullYear(),
      months[monthFirst[1].toLowerCase()],
      Number(monthFirst[2]),
    );
  }

  const dayFirst = value.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})(?:,?\\s+(\\d{4}))?\\b`, "i"));
  if (dayFirst) {
    return validDate(
      dayFirst[3] ? Number(dayFirst[3]) : new Date().getUTCFullYear(),
      months[dayFirst[2].toLowerCase()],
      Number(dayFirst[1]),
    );
  }

  return undefined;
}

function normalizeYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

const months: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

function validDate(year: number, month: number | undefined, day: number): Date | undefined {
  if (month === undefined || !Number.isFinite(year) || !Number.isFinite(day)) {
    return undefined;
  }

  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month
    && date.getUTCDate() === day
    ? date
    : undefined;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function eventName(value: string): string {
  return value
    .replace(/\bon\s+\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/i, "")
    .replace(/\bhappened\b/i, "")
    .replace(/\bwas\b/i, "")
    .replace(/\.$/, "")
    .trim();
}

function stripArticle(value: string): string {
  return value.replace(/^(?:the|a|an)\s+/i, "");
}

function cleanFactSentence(value: string): string {
  return stripSessionPrefix(value)
    .replace(/\.$/, "")
    .trim();
}

function extractShortAnswer(question: string, evidence: string): string {
  const cleaned = cleanFactSentence(evidence);
  const packageManager = cleaned.match(/\b(?:package manager|scripts?)\b.*?\b(npm|pnpm|yarn)\b/i)
    ?? cleaned.match(/\b(npm|pnpm|yarn)\b.*?\b(?:package manager|scripts?)\b/i);
  if (/\b(?:package manager|run scripts|scripts)\b/i.test(question) && packageManager?.[1]) {
    return packageManager[1];
  }

  const uses = cleaned.match(/\b(?:is|are|uses?|use|depends on|calls)\s+(.+)$/i);
  return cleanAnswer(uses?.[1] ?? cleaned);
}

function cleanAnswer(value: string): string {
  return value.trim().replace(/^answer:\s*/i, "").replace(/\s+$/g, "");
}

function stripEvidencePrefix(value: string): string {
  return value.replace(/^\[\d+\]\s*/, "").trim();
}

function stripSessionPrefix(value: string): string {
  return value.replace(/^session\s+[^:]+:\s+user said\s+/i, "").trim();
}

function tokenOverlap(query: string, evidence: string): number {
  const queryTokens = meaningfulTokens(query);
  const evidenceTokens = meaningfulTokens(evidence);
  if (queryTokens.length === 0 || evidenceTokens.length === 0) {
    return 0;
  }

  return sharedCount(queryTokens, evidenceTokens) / queryTokens.length;
}

function sharedCount(a: string[], b: string[]): number {
  const bSet = new Set(b);
  return new Set(a.filter((token) => bSet.has(token))).size;
}

function meaningfulTokens(value: string): string[] {
  const stopwords = new Set([
    "about",
    "after",
    "answer",
    "before",
    "between",
    "current",
    "days",
    "does",
    "evidence",
    "from",
    "have",
    "happen",
    "happened",
    "latest",
    "many",
    "that",
    "the",
    "this",
    "what",
    "when",
    "where",
    "which",
    "with",
  ]);

  return [...new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9_.-]+/g)
      ?.filter((token) => token.length >= 3 && !stopwords.has(token)) ?? [],
  )];
}
