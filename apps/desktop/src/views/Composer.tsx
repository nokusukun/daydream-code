/**
 * The two things you can type into, sharing one box.
 *
 * `DispatchComposer` sits under the master thread and starts a run — typing at
 * the thread is how a run comes into existence, so the thread's composer is
 * the dispatch composer rather than a message that would have nowhere to go.
 * `MessageComposer` sits under a run and steers it.
 *
 * They differ only in what the button does and what the footer has room for,
 * which is why the growing textarea and the ⌘⏎ handling live in one place.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SessionRecord } from "@daydream-code/shared";
import { useHarness } from "../harness.js";
import { NEW_SESSION_DRAFT, useDraft } from "../drafts.js";
import { ModelSelector, loadChoice, type ModelChoice } from "../model-selector.js";
import { compact } from "./ThreadRail.js";

function Box(props: {
  value: string;
  placeholder: string;
  disabled: boolean;
  autoFocus: boolean;
  onChange(value: string): void;
  onSubmit(): void;
  footer: ReactNode;
}): ReactNode {
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (box === null || !props.autoFocus) return;
    box.focus();
    // A restored draft is text you were in the middle of: carry on at the end
    // of it rather than in front of it.
    box.setSelectionRange(box.value.length, box.value.length);
    // Only on mount: refocusing on every keystroke would fight the caret.
  }, [props.autoFocus]);

  // Grow with content up to the CSS max-height, then scroll.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    box.style.height = "auto";
    const max = Number.parseFloat(getComputedStyle(box).maxHeight);
    const wanted = box.scrollHeight;
    box.style.height = `${Number.isFinite(max) ? Math.min(wanted, max) : wanted}px`;
    // Only show a scroller once the field has actually stopped growing.
    box.style.overflowY = Number.isFinite(max) && wanted > max ? "auto" : "hidden";
  }, [props.value]);

  return (
    <div className="composer">
      <div className="composer-field">
        <textarea
          ref={boxRef}
          rows={1}
          value={props.value}
          placeholder={props.placeholder}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              props.onSubmit();
            }
          }}
        />
        <div className="composer-row">{props.footer}</div>
      </div>
    </div>
  );
}

/** Starts a run. The master thread's composer. */
export function DispatchComposer(props: {
  autoFocus: boolean;
  onError(message: string): void;
}): ReactNode {
  const { api, select, drafts } = useHarness();
  // The draft outlives this view, which disappears the moment a run is
  // clicked; the text is still here when you come back.
  const [task, setTask] = useDraft(drafts, NEW_SESSION_DRAFT);
  const [choice, setChoice] = useState<ModelChoice>(loadChoice);
  const [busy, setBusy] = useState(false);

  const dispatch = useCallback(() => {
    const trimmed = task.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    api
      .dispatch({
        task: trimmed,
        driver: choice.driver,
        ...(choice.modelId !== null ? { modelId: choice.modelId } : {}),
      })
      .then((record) => {
        // Only once the task is safely a session; a failed dispatch keeps it.
        drafts.clear(NEW_SESSION_DRAFT);
        select(record.id as string);
      })
      .catch((e: unknown) =>
        props.onError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  }, [api, task, choice, busy, select, drafts, props]);

  return (
    <Box
      value={task}
      placeholder="Describe a task — it forks the master thread…"
      disabled={false}
      autoFocus={props.autoFocus}
      onChange={setTask}
      onSubmit={dispatch}
      footer={
        <>
          <ModelSelector value={choice} onChange={setChoice} disabled={busy} />
          <span className="composer-spacer" />
          <span className="composer-hint">
            <kbd>⌘</kbd> <kbd>return</kbd>
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || task.trim().length === 0}
            onClick={dispatch}
          >
            {busy ? "dispatching" : "dispatch"}
          </button>
        </>
      }
    />
  );
}

/** Steers a run that already exists. */
export function MessageComposer(props: {
  session: SessionRecord | null;
  id: string;
  onError(message: string): void;
}): ReactNode {
  const { api, drafts } = useHarness();
  // The panel is keyed by session id, so this composer is thrown away and
  // rebuilt on every switch. The draft is what makes that survivable.
  const [message, setMessage] = useDraft(drafts, props.id);
  const [busy, setBusy] = useState(false);
  const running = props.session?.status === "running";

  const send = useCallback(() => {
    const trimmed = message.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    api
      .message(props.id, trimmed)
      // Only once the server has it; a failed send keeps the text.
      .then(() => drafts.clear(props.id))
      .catch((e: unknown) =>
        props.onError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  }, [api, message, busy, props, drafts]);

  const usage = props.session?.usage;
  const tokens = usage === undefined ? 0 : usage.tokensIn + usage.tokensOut;

  return (
    <Box
      value={message}
      placeholder={
        running
          ? "Steer this run — it lands on the next turn…"
          : "Send a message to resume this run…"
      }
      disabled={false}
      autoFocus={false}
      onChange={setMessage}
      onSubmit={send}
      footer={
        <>
          {usage !== undefined && tokens > 0 && (
            <span
              className="composer-facts"
              title={`${usage.tokensIn.toLocaleString()} in · ${usage.tokensOut.toLocaleString()} out`}
            >
              <span>{compact(tokens)} tokens</span>
              {usage.costUsd > 0 && <span>${usage.costUsd.toFixed(2)}</span>}
            </span>
          )}
          <span className="composer-spacer" />
          <span className="composer-hint">
            <kbd>⌘</kbd> <kbd>return</kbd>
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || message.trim().length === 0}
            onClick={send}
          >
            {busy ? "sending" : "send"}
          </button>
        </>
      }
    />
  );
}
