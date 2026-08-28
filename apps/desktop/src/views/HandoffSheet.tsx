/**
 * The handoff sheet: pick the agent for a new thread that takes over another
 * thread's work.
 *
 * A sheet rather than an immediate dispatch, because the whole point of a
 * handoff is choosing *who* continues — dispatching on the menu click alone
 * would pin the new thread to whatever the last-used model happened to be,
 * which is the exact mistake the feature exists to avoid.
 *
 * The server composes the context (transcript replay or summary) from the
 * source's journal; this sheet only names the source, the mode, the agent and
 * an optional instruction.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useHarness } from "../harness.js";
import { useDismiss, useInitialFocus } from "../overlay.js";
import { handoffStage, type HandoffStage } from "../handoff.js";
import { ModelSelector, type ModelChoice } from "../model-selector.js";

export function HandoffSheet(): ReactNode {
  const { api, select, setOverlay } = useHarness();
  // Read once on mount: the stage was written in the same tick as the
  // overlay id, and re-reading on render would let a later staging yank the
  // form out from under a half-written instruction.
  const [stage] = useState<HandoffStage | null>(handoffStage);
  const [choice, setChoice] = useState<ModelChoice>(() =>
    stage !== null
      ? { driver: stage.driver, modelId: stage.modelId, effort: stage.effort }
      : { driver: "claude", modelId: null, effort: null },
  );
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOverlay(null), [setOverlay]);
  useDismiss(sheetRef, true, close);
  useInitialFocus(sheetRef);

  const start = useCallback(() => {
    if (stage === null || busy) return;
    setBusy(true);
    setFailure(null);
    const trimmed = task.trim();
    api
      .handoff(stage.sessionId, {
        mode: stage.mode,
        ...(trimmed.length > 0 ? { task: trimmed } : {}),
        driver: choice.driver,
        ...(choice.modelId !== null ? { modelId: choice.modelId } : {}),
        ...(choice.effort !== null ? { effort: choice.effort } : {}),
      })
      .then((record) => {
        // The new thread is the thing to look at now; the source is untouched.
        select(record.id as string);
        setOverlay(null);
      })
      .catch((e: unknown) => {
        setFailure(e instanceof Error ? e.message : String(e));
        setBusy(false);
      });
  }, [api, stage, task, choice, busy, select, setOverlay]);

  return (
    <div
      className="scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={sheetRef}
        className="sheet glass-strong handoff-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={
          stage?.mode === "summary"
            ? "Summarize to new thread"
            : "Handoff to new thread"
        }
        tabIndex={-1}
      >
        <header className="sheet-head">
          <h2>{stage?.mode === "summary" ? "summarize to new thread" : "handoff to new thread"}</h2>
          <button type="button" className="btn" onClick={close}>
            cancel
          </button>
        </header>
        <div className="sheet-body">
          {stage === null ? (
            // Reachable only by opening the overlay without a staged source
            // (nothing in the UI does); teach the gesture rather than crash.
            <p className="handoff-empty">
              Right-click a thread in the sidebar and choose Handoff or
              Summarize to start one here.
            </p>
          ) : (
            <>
              {failure !== null && <div className="error-bar">{failure}</div>}
              <p className="handoff-source">
                <span className="handoff-source-name">{stage.name}</span>
                <span className="handoff-source-title">{stage.title}</span>
              </p>
              <p className="handoff-note">
                {stage.mode === "summary"
                  ? "The new thread starts from a summary of this thread's work — the conclusions, not the turns."
                  : "The new thread starts from this thread's replayed transcript, so it can continue mid-stride."}{" "}
                This thread is left exactly as it is.
              </p>
              <textarea
                className="handoff-task"
                rows={3}
                value={task}
                placeholder={`Optional instruction — otherwise: take over "${stage.name}" and continue its work`}
                onChange={(event) => setTask(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    start();
                  }
                }}
              />
              <footer className="handoff-foot">
                <ModelSelector
                  value={choice}
                  onChange={setChoice}
                  disabled={busy}
                  persist={false}
                />
                <span className="composer-spacer" />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={start}
                >
                  {busy ? "starting…" : "start thread"}
                </button>
              </footer>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
