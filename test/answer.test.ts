import { describe, expect, it } from "vitest";
import { answerQuestion } from "../src/read/answer.js";

describe("answerQuestion", () => {
  it("answers a direct fact briefly from evidence", async () => {
    const answer = await answerQuestion({
      question: "Which package manager should run scripts?",
      evidence: ["The project package manager is pnpm."],
    });

    expect(answer).toBe("pnpm");
  });

  it("answers before/after questions from dated evidence", async () => {
    const answer = await answerQuestion({
      question: "Did the migration happen before or after the launch?",
      evidence: [
        "The launch happened on May 1, 2026.",
        "The migration happened on May 20, 2026.",
      ],
    });

    expect(answer).toBe("migration happened after.");
  });

  it("calculates days-between answers from evidence dates", async () => {
    const debug = await answerQuestion({
      question: "How many days between launch and migration?",
      evidence: [
        "The launch happened on May 1, 2026.",
        "The migration happened on May 20, 2026.",
      ],
      debug: true,
    });

    expect(debug.answer).toBe("19 days.");
    expect(debug.rationale).toContain("2026-05-01");
    expect(debug.usedEvidence).toEqual([1, 2]);
  });

  it("abstains when evidence is insufficient", async () => {
    const answer = await answerQuestion({
      question: "Which database does production use?",
      evidence: ["The dashboard uses neo-brutalist cards."],
    });

    expect(answer).toBe("I don't know.");
  });
});
