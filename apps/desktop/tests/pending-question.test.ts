import { describe, expect, it } from "vitest";
import type { Question } from "@daydream-code/questions";
import {
  answeredCount,
  buildAnswers,
  firstUnanswered,
  pendingQuestionFrom,
  resolveAnswer,
  setCustom,
  toggleOption,
} from "../src/pending-question";

function q(text: string, multiSelect = false): Question {
  return {
    id: text,
    header: "H",
    question: text,
    options: [
      { label: "one", description: "" },
      { label: "two", description: "" },
    ],
    multiSelect,
  };
}

const asked = (requestId: string, questions: Question[]) => ({
  type: "question_asked",
  payload: { requestId, questions },
});
const settled = (requestId: string, kind = "answered") => ({
  type: "question_settled",
  payload: { requestId, kind },
});

describe("pendingQuestionFrom", () => {
  it("returns null when nothing was ever asked", () => {
    expect(pendingQuestionFrom([{ type: "turn", payload: { text: "hi" } }])).toBeNull();
  });

  it("surfaces an unanswered question", () => {
    const pending = pendingQuestionFrom([asked("r1", [q("which?")])]);
    expect(pending?.requestId).toBe("r1");
    expect(pending?.questions).toHaveLength(1);
  });

  it("closes a question once it settles", () => {
    expect(pendingQuestionFrom([asked("r1", [q("which?")]), settled("r1")])).toBeNull();
  });

  it("retires a question cancelled by a restart, rather than pinning it", () => {
    expect(
      pendingQuestionFrom([asked("r1", [q("which?")]), settled("r1", "cancelled")]),
    ).toBeNull();
  });

  it("returns the oldest still-open question", () => {
    const pending = pendingQuestionFrom([
      asked("r1", [q("first?")]),
      asked("r2", [q("second?")]),
      settled("r1"),
    ]);
    expect(pending?.requestId).toBe("r2");
  });

  it("ignores an asked event carrying no questions", () => {
    expect(pendingQuestionFrom([{ type: "question_asked", payload: { requestId: "r1" } }])).toBeNull();
  });
});

describe("answer drafting", () => {
  it("takes a single selected label", () => {
    const draft = toggleOption(q("which?"), undefined, "one");
    expect(resolveAnswer(q("which?"), draft)).toBe("one");
  });

  it("replaces the selection for a single-select question", () => {
    let draft = toggleOption(q("which?"), undefined, "one");
    draft = toggleOption(q("which?"), draft, "two");
    expect(draft.selected).toEqual(["two"]);
  });

  it("accumulates and toggles off for a multi-select question", () => {
    const question = q("which?", true);
    let draft = toggleOption(question, undefined, "one");
    draft = toggleOption(question, draft, "two");
    expect(resolveAnswer(question, draft)).toEqual(["one", "two"]);
    draft = toggleOption(question, draft, "one");
    expect(resolveAnswer(question, draft)).toEqual(["two"]);
  });

  it("lets typed prose override a selected option", () => {
    let draft = toggleOption(q("which?"), undefined, "one");
    draft = setCustom(draft, "actually, neither");
    expect(resolveAnswer(q("which?"), draft)).toBe("actually, neither");
    expect(draft.selected).toEqual([]);
  });

  it("falls back to the selection when the typed text is cleared", () => {
    const question = q("which?");
    let draft = toggleOption(question, undefined, "one");
    draft = setCustom(draft, "");
    expect(resolveAnswer(question, draft)).toBe("one");
  });

  it("treats whitespace-only text as no answer", () => {
    expect(resolveAnswer(q("which?"), setCustom(undefined, "   "))).toBeNull();
  });

  it("refuses a partial submit", () => {
    const questions = [q("a?"), q("b?")];
    const drafts = { "a?": toggleOption(questions[0]!, undefined, "one") };
    expect(buildAnswers(questions, drafts)).toBeNull();
    expect(answeredCount(questions, drafts)).toBe(1);
    expect(firstUnanswered(questions, drafts)).toBe(1);
  });

  it("builds the full answer map once every question is answered", () => {
    const questions = [q("a?"), q("b?")];
    const drafts = {
      "a?": toggleOption(questions[0]!, undefined, "one"),
      "b?": setCustom(undefined, "my own words"),
    };
    expect(buildAnswers(questions, drafts)).toEqual({ "a?": "one", "b?": "my own words" });
    expect(firstUnanswered(questions, drafts)).toBe(1);
  });
});
