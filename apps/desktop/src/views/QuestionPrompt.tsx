/**
 * The composer, taken over by a question the session is blocked on.
 *
 * It replaces the message field rather than sitting above it: the session
 * cannot move until this is answered, so offering a second thing to type into
 * would be offering a way to be ignored. One question at a time, because a
 * wall of them reads as a form, and the model is told to ask few.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { Question } from "@daydream-code/questions";
import type { NextMessage } from "@daydream-code/session";
import { useHarness } from "../harness.js";
import { NextMessageQueue, useNextMessageControls } from "./Composer.js";
import {
  answeredCount,
  buildAnswers,
  firstUnanswered,
  resolveAnswer,
  setCustom,
  toggleOption,
  type DraftAnswer,
  type PendingQuestionView,
} from "../pending-question.js";

export function QuestionPrompt(props: {
  sessionId: string;
  pending: PendingQuestionView;
  nextMessages: NextMessage[];
  onNextMessages: Dispatch<SetStateAction<NextMessage[]>>;
  onError(message: string): void;
}): ReactNode {
  const { api } = useHarness();
  const { pending } = props;
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({});
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);
  const nextControls = useNextMessageControls(
    props.sessionId,
    props.onNextMessages,
    props.onError,
  );

  // A new request is a new set of answers; reusing them would silently carry a
  // previous question's pick into this one.
  useEffect(() => {
    setDrafts({});
    setIndex(0);
  }, [pending.requestId]);

  const questions = pending.questions;
  const active = questions[Math.min(index, questions.length - 1)];
  const draft = active ? drafts[active.id] : undefined;
  const answers = useMemo(() => buildAnswers(questions, drafts), [questions, drafts]);
  const done = answeredCount(questions, drafts);

  const advance = useCallback(() => {
    setDrafts((current) => {
      setIndex(firstUnanswered(questions, current));
      return current;
    });
  }, [questions]);

  const pick = useCallback(
    (question: Question, label: string) => {
      setDrafts((current) => ({
        ...current,
        [question.id]: toggleOption(question, current[question.id], label),
      }));
      // Multi-select needs an explicit move on; a single pick is the answer.
      if (!question.multiSelect) advance();
    },
    [advance],
  );

  const submit = useCallback(
    (body: { answers?: Record<string, string | string[]>; decline?: boolean }) => {
      if (busy) return;
      setBusy(true);
      api
        .answer(props.sessionId, { requestId: pending.requestId, ...body })
        .catch((e: unknown) => props.onError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    },
    [api, busy, pending.requestId, props],
  );

  // 1-9 pick an option, as long as the user is not mid-sentence in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (active === undefined || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable === true) return;
      if (!/^[1-9]$/.test(event.key)) return;
      const option = active.options[Number(event.key) - 1];
      if (option === undefined) return;
      event.preventDefault();
      pick(active, option.label);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, pick]);

  if (active === undefined) return null;

  const selected = draft?.selected ?? [];
  const custom = draft?.custom ?? "";
  const resolved = resolveAnswer(active, draft);

  return (
    <div className="composer composer-question">
      <NextMessageQueue
        messages={props.nextMessages}
        busyId={nextControls.busyId}
        onCancel={nextControls.cancel}
        onCancelEdit={nextControls.cancelEdit}
      />
      <div className="question-card">
        <div className="question-head">
          <span className="question-chip">{active.header}</span>
          {questions.length > 1 && (
            <span className="question-progress" aria-live="polite">
              {done} of {questions.length} answered
            </span>
          )}
        </div>
        <p className="question-text">{active.question}</p>
        <ul className="question-options">
          {active.options.map((option, n) => {
            const on = selected.includes(option.label) && custom.trim().length === 0;
            return (
              <li key={option.label}>
                <button
                  type="button"
                  className={`question-option${on ? " is-selected" : ""}`}
                  aria-pressed={on}
                  disabled={busy}
                  onClick={() => pick(active, option.label)}
                >
                  <kbd className="question-key">{n + 1}</kbd>
                  <span className="question-label">{option.label}</span>
                  {option.description !== "" && (
                    <span className="question-desc">{option.description}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <input
          ref={customRef}
          className="question-custom"
          type="text"
          value={custom}
          placeholder="or answer in your own words…"
          disabled={busy}
          onChange={(e) =>
            setDrafts((current) => ({
              ...current,
              [active.id]: setCustom(current[active.id], e.target.value),
            }))
          }
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (resolved === null) return;
            if (index < questions.length - 1) advance();
            else if (answers !== null) submit({ answers });
          }}
        />
        <div className="question-row">
          <span className="question-hint">
            {questions.length > 1 && index < questions.length - 1
              ? "press a number, or type your own"
              : "the session is waiting on this"}
          </span>
          <div className="question-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => submit({ decline: true })}
              title="Proceed without answering; the session takes its own recommendation and records it as an assumption."
            >
              you decide
            </button>
            {index < questions.length - 1 ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || resolved === null}
                onClick={advance}
              >
                next
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || answers === null}
                onClick={() => answers !== null && submit({ answers })}
              >
                {busy ? "sending" : "answer"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
