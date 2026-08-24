import type { Question } from "@daydream-code/questions";

/**
 * Pending-question state, derived from the journal rather than stored.
 *
 * The journal is the only lossless record, and it is already streamed to every
 * client — so folding it is both the cheapest and the most honest source of
 * "is this session blocked". It also means a client that reconnects mid-block
 * rebuilds the prompt from the transcript it just loaded, with no extra fetch
 * and no separate state to fall out of sync.
 */

export interface PendingQuestionView {
  requestId: string;
  questions: Question[];
}

interface Journalish {
  type: string;
  payload: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The oldest question still open, or null. `question_settled` closes its own
 * request — including the `cancelled` case, which is how a question retires
 * when the process holding its promise went away.
 */
export function pendingQuestionFrom(
  events: readonly Journalish[],
): PendingQuestionView | null {
  const open = new Map<string, PendingQuestionView>();
  for (const event of events) {
    const payload = asRecord(event.payload);
    const requestId =
      payload && typeof payload.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (event.type === "question_asked") {
      const questions = Array.isArray(payload?.questions)
        ? (payload.questions as Question[])
        : [];
      if (questions.length > 0) open.set(requestId, { requestId, questions });
    } else if (event.type === "question_settled") {
      open.delete(requestId);
    }
  }
  const first = open.values().next();
  return first.done === true ? null : first.value;
}

export interface DraftAnswer {
  selected: string[];
  custom: string;
}

export const EMPTY_DRAFT: DraftAnswer = { selected: [], custom: "" };

/**
 * Typed prose beats picked options — the user who bothered to write something
 * meant it, and the offered options may simply have been wrong.
 */
export function resolveAnswer(
  question: Question,
  draft: DraftAnswer | undefined,
): string | string[] | null {
  const custom = (draft?.custom ?? "").trim();
  if (custom.length > 0) return custom;
  const selected = draft?.selected ?? [];
  if (question.multiSelect) return selected.length > 0 ? [...selected] : null;
  return selected[0] ?? null;
}

/** Selecting clears typed text and vice versa, so the two never both apply. */
export function toggleOption(
  question: Question,
  draft: DraftAnswer | undefined,
  label: string,
): DraftAnswer {
  const selected = draft?.selected ?? [];
  if (!question.multiSelect) return { selected: [label], custom: "" };
  return {
    custom: "",
    selected: selected.includes(label)
      ? selected.filter((entry) => entry !== label)
      : [...selected, label],
  };
}

export function setCustom(draft: DraftAnswer | undefined, custom: string): DraftAnswer {
  return custom.trim().length > 0
    ? { selected: [], custom }
    : { selected: draft?.selected ?? [], custom };
}

/** Null unless every question is answered: there is no partial submit. */
export function buildAnswers(
  questions: readonly Question[],
  drafts: Record<string, DraftAnswer>,
): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const answer = resolveAnswer(question, drafts[question.id]);
    if (answer === null) return null;
    answers[question.id] = answer;
  }
  return answers;
}

export function answeredCount(
  questions: readonly Question[],
  drafts: Record<string, DraftAnswer>,
): number {
  return questions.filter((q) => resolveAnswer(q, drafts[q.id]) !== null).length;
}

/** Index of the first unanswered question, or the last one if all are done. */
export function firstUnanswered(
  questions: readonly Question[],
  drafts: Record<string, DraftAnswer>,
): number {
  const index = questions.findIndex((q) => resolveAnswer(q, drafts[q.id]) === null);
  return index === -1 ? Math.max(questions.length - 1, 0) : index;
}
