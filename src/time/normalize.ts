export type TemporalRefKind =
  | "explicit_date"
  | "relative_date"
  | "event_relation"
  | "duration";

export interface NormalizedTemporalRef {
  text: string;
  kind: TemporalRefKind;
  resolvedDate?: string;
  direction?: "before" | "after";
  eventText?: string;
  amount?: number;
  unit?: "day" | "week" | "month" | "year";
  days?: number;
}

export interface NormalizedTemporalInfo {
  eventDate?: string;
  mentionedAt?: string;
  temporalRefs: NormalizedTemporalRef[];
}

const monthNames: Record<string, number> = {
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

const numberWords: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

export function normalizeTemporalText(
  text: string,
  occurredAt = new Date(),
): NormalizedTemporalInfo {
  const temporalRefs = [
    ...explicitDateRefs(text, occurredAt),
    ...relativeDateRefs(text, occurredAt),
    ...eventRelationRefs(text),
    ...durationRefs(text),
  ];
  const eventDate = latestDate(temporalRefs);

  return {
    ...(eventDate ? { eventDate } : {}),
    ...(temporalRefs.length > 0 ? { mentionedAt: occurredAt.toISOString() } : {}),
    temporalRefs,
  };
}

export function durationToDays(amount: number, unit: NormalizedTemporalRef["unit"]): number {
  if (unit === "day") {
    return amount;
  }

  if (unit === "week") {
    return amount * 7;
  }

  if (unit === "month") {
    return amount * 30;
  }

  return amount * 365;
}

function explicitDateRefs(text: string, occurredAt: Date): NormalizedTemporalRef[] {
  const refs: NormalizedTemporalRef[] = [];
  for (const match of text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    const resolvedDate = isoDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (resolvedDate) {
      refs.push({ text: match[0], kind: "explicit_date", resolvedDate });
    }
  }

  const monthPattern = Object.keys(monthNames).join("|");
  const monthFirst = new RegExp(
    `\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
    "gi",
  );
  for (const match of text.matchAll(monthFirst)) {
    const resolvedDate = isoDate(
      match[3] ? Number(match[3]) : occurredAt.getUTCFullYear(),
      monthNames[match[1].toLowerCase()],
      Number(match[2]),
    );
    if (resolvedDate) {
      refs.push({ text: match[0], kind: "explicit_date", resolvedDate });
    }
  }

  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})(?:,?\\s+(\\d{4}))?\\b`,
    "gi",
  );
  for (const match of text.matchAll(dayFirst)) {
    const resolvedDate = isoDate(
      match[3] ? Number(match[3]) : occurredAt.getUTCFullYear(),
      monthNames[match[2].toLowerCase()],
      Number(match[1]),
    );
    if (resolvedDate) {
      refs.push({ text: match[0], kind: "explicit_date", resolvedDate });
    }
  }

  return uniqueRefs(refs);
}

function relativeDateRefs(text: string, occurredAt: Date): NormalizedTemporalRef[] {
  const refs: NormalizedTemporalRef[] = [];
  const lower = text.toLowerCase();
  const named: Array<[string, number]> = [
    ["today", 0],
    ["yesterday", -1],
    ["tomorrow", 1],
    ["last week", -7],
  ];

  for (const [phrase, days] of named) {
    if (lower.includes(phrase)) {
      refs.push({
        text: phrase,
        kind: "relative_date",
        resolvedDate: addDays(occurredAt, days),
      });
    }
  }

  for (const match of text.matchAll(
    /\b((?:\d+(?:\.\d+)?)|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))(?:\s+and\s+a\s+half)?\s+(days?|weeks?|months?|years?)\s+ago\b/gi,
  )) {
    const amount = numericAmount(match[1]) + (/\band\s+a\s+half\b/i.test(match[0]) ? 0.5 : 0);
    const unit = singularUnit(match[2]);
    refs.push({
      text: match[0],
      kind: "relative_date",
      resolvedDate: addDays(occurredAt, -durationToDays(amount, unit)),
      amount,
      unit,
      days: durationToDays(amount, unit),
    });
  }

  return uniqueRefs(refs);
}

function eventRelationRefs(text: string): NormalizedTemporalRef[] {
  const refs: NormalizedTemporalRef[] = [];
  for (const match of text.matchAll(/\b(before|after)\s+(?:the\s+)?([^.;,\n]+)/gi)) {
    refs.push({
      text: match[0].trim(),
      kind: "event_relation",
      direction: match[1].toLowerCase() as "before" | "after",
      eventText: match[2].trim(),
    });
  }
  return uniqueRefs(refs);
}

function durationRefs(text: string): NormalizedTemporalRef[] {
  const refs: NormalizedTemporalRef[] = [];
  for (const match of text.matchAll(
    /\b((?:\d+(?:\.\d+)?)|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))(?:\s+and\s+a\s+half)?\s+(days?|weeks?|months?|years?)\b/gi,
  )) {
    if (/\bago\b/i.test(text.slice(match.index ?? 0, (match.index ?? 0) + match[0].length + 4))) {
      continue;
    }
    const amount = numericAmount(match[1]) + (/\band\s+a\s+half\b/i.test(match[0]) ? 0.5 : 0);
    const unit = singularUnit(match[2]);
    refs.push({
      text: match[0],
      kind: "duration",
      amount,
      unit,
      days: durationToDays(amount, unit),
    });
  }
  return uniqueRefs(refs);
}

function latestDate(refs: NormalizedTemporalRef[]): string | undefined {
  return refs
    .map((ref) => ref.resolvedDate)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}

function numericAmount(value: string): number {
  const numeric = Number.parseFloat(value);
  if (!Number.isNaN(numeric)) {
    return numeric;
  }

  return numberWords[value.toLowerCase()] ?? 0;
}

function singularUnit(value: string): "day" | "week" | "month" | "year" {
  const lower = value.toLowerCase();
  if (lower.startsWith("day")) {
    return "day";
  }
  if (lower.startsWith("week")) {
    return "week";
  }
  if (lower.startsWith("month")) {
    return "month";
  }
  return "year";
}

function addDays(date: Date, days: number): string {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString();
}

function isoDate(year: number, month: number | undefined, day: number): string | undefined {
  if (month === undefined || !Number.isFinite(year) || !Number.isFinite(day)) {
    return undefined;
  }

  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month
    && date.getUTCDate() === day
    ? date.toISOString()
    : undefined;
}

function uniqueRefs(refs: NormalizedTemporalRef[]): NormalizedTemporalRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.text.toLowerCase()}:${ref.resolvedDate ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
