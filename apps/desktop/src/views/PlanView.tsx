/**
 * Plan mode: one large prompt in, many draft cards out.
 *
 * Two screens inside board mode. The composer takes the prompt and the agent.
 * The workspace shows the plan's cards beside the planner's own thread. The
 * thread is the refinement tool: a person asks for changes in words there,
 * and the planner rewrites the cards on the left through `board_plan_write`.
 * Anything faster done by hand (fix a word, drop a card, move one up) is done
 * by hand on the left, and the planner re-reads the plan before its next turn.
 *
 * Nothing runs until the person queues the plan. That is the point of a plan:
 * the review happens before any agent touches the tree, not card by card as
 * each one lands in Queued.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionRecord } from "@daydream-code/shared";
import { ApiError, type BoardCard, type BoardPlan } from "../api.js";
import { laneOf } from "../board.js";
import { useHarness } from "../harness.js";
import { loadChoice, ModelSelector, type ModelChoice } from "../model-selector.js";
import { isLive } from "../sessions.js";
import { SplitPane } from "../split.js";
import { StatusGlyph, fmtAgo } from "../ui.js";
import { SessionPanel } from "./SessionPanel.js";

const DRAFT_KEY = "daydream.board.plan-draft";

/** Same access rule as drafts.ts: storage can throw under a locked-down origin. */
export function planStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? error.message;
  return error instanceof Error ? error.message : String(error);
}

/** A plan's cards in run order: the order they will be queued in, first on top. */
export function planOrder(cards: readonly BoardCard[], planId: string): BoardCard[] {
  return cards.filter((card) => card.planId === planId).sort((a, b) => a.position - b.position);
}

/**
 * Plans worth offering to go back to, newest first: any plan with a card that
 * has not reached Done, or whose planner is still writing.
 *
 * Queuing is not the end of a plan. Its cards then wait, get evaluated and run
 * for as long as the work takes, and that is when a person most wants the plan
 * back: to see which of its cards have landed, or to ask the planner about the
 * next one. A plan is over when its last card is Done, or when its drafts were
 * discarded and nothing else is left.
 */
export function openPlans(
  plans: readonly BoardPlan[],
  cards: readonly BoardCard[],
  planner: (plan: BoardPlan) => SessionRecord | undefined,
): BoardPlan[] {
  return plans
    .filter((plan) => {
      const session = planner(plan);
      return (
        cards.some((card) => card.planId === plan.id && card.column !== "done") ||
        (session !== undefined && isLive(session))
      );
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * One line of where a plan stands, for the lists that offer it: the glyph and
 * the short count beside its title. Drafts are the review still owed; once
 * none are left the count is progress through the queued work.
 */
export function planStanding(
  plan: BoardPlan,
  cards: readonly BoardCard[],
  planner: SessionRecord | undefined,
): { glyph: string; meta: string } {
  const own = cards.filter((card) => card.planId === plan.id);
  const drafts = own.filter((card) => card.column === "draft").length;
  const done = own.filter((card) => card.column === "done").length;
  const working = own.some((card) => card.column === "working");
  const glyph = (planner !== undefined && isLive(planner)) || working ? "running" : drafts > 0 ? "draft" : "queued";
  if (drafts > 0) return { glyph, meta: `${drafts} ${drafts === 1 ? "draft" : "drafts"}` };
  if (own.length === 0) return { glyph, meta: "writing" };
  return { glyph, meta: `${done} of ${own.length} done` };
}

/**
 * `before` for moving the card at index `at` of a plan one row up (-1) or
 * down (+1). Undefined at the edge it is moving toward. Null is the back of
 * the whole queue, which is below the plan's last card wherever that sits.
 */
export function planNudge(order: readonly BoardCard[], at: number, step: 1 | -1): string | null | undefined {
  if (step === -1) return at <= 0 ? undefined : order[at - 1]!.id;
  if (at >= order.length - 1) return undefined;
  return order[at + 2]?.id ?? null;
}

export function PlanView(props: {
  /** `"new"` for the composer, otherwise the plan to show. */
  planId: string;
  plans: readonly BoardPlan[];
  cards: readonly BoardCard[];
  sessions: ReadonlyMap<string, SessionRecord>;
  onOpen(planId: string): void;
  onClose(): void;
}): ReactNode {
  const planner = (plan: BoardPlan) =>
    plan.sessionId === null ? undefined : props.sessions.get(plan.sessionId);
  if (props.planId === "new") {
    return (
      <PlanComposer
        resumable={openPlans(props.plans, props.cards, planner)}
        cards={props.cards}
        planner={planner}
        onOpen={props.onOpen}
        onClose={props.onClose}
      />
    );
  }
  const plan = props.plans.find((candidate) => candidate.id === props.planId);
  if (plan === undefined) {
    return (
      <main className="panel board board-off">
        <div className="board-empty">
          <h2>Plan not found</h2>
          <p>It may belong to another project, or the planner never started.</p>
          <button type="button" className="btn btn-primary" onClick={props.onClose}>
            Back to board
          </button>
        </div>
      </main>
    );
  }
  return (
    <PlanWorkspace
      plan={plan}
      cards={planOrder(props.cards, plan.id)}
      planner={planner(plan)}
      onClose={props.onClose}
    />
  );
}

function PlanComposer(props: {
  resumable: BoardPlan[];
  cards: readonly BoardCard[];
  planner(plan: BoardPlan): SessionRecord | undefined;
  onOpen(planId: string): void;
  onClose(): void;
}): ReactNode {
  const { api } = useHarness();
  // Kept across leaving the screen: a long plan pasted in and then lost to a
  // stray click on the board is the most expensive thing this screen could do.
  const [prompt, setPrompt] = useState(() => planStorage()?.getItem(DRAFT_KEY) ?? "");
  const [choice, setChoice] = useState<ModelChoice>(loadChoice);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    if (prompt.length > 0) planStorage()?.setItem(DRAFT_KEY, prompt);
    else planStorage()?.removeItem(DRAFT_KEY);
  }, [prompt]);

  const start = useCallback(() => {
    const text = prompt.trim();
    if (text.length === 0 || busy) return;
    setBusy(true);
    setFailure(null);
    api
      .createPlan({
        prompt: text,
        driver: choice.driver,
        ...(choice.modelId !== null ? { modelId: choice.modelId } : {}),
        ...(choice.effort !== null ? { effort: choice.effort } : {}),
        ...(choice.fastMode ? { fastMode: true } : {}),
      })
      .then((plan) => {
        planStorage()?.removeItem(DRAFT_KEY);
        props.onOpen(plan.id);
      })
      .catch((error: unknown) => {
        setFailure(messageOf(error));
        setBusy(false);
      });
  }, [api, busy, choice, prompt, props]);

  return (
    <main className="panel board plan-compose-screen">
      <header className="board-head">
        <button type="button" className="btn" onClick={props.onClose}>
          ← Board
        </button>
        <h1 className="board-title">New plan</h1>
      </header>
      <div className="plan-compose">
        <p className="plan-compose-lede">
          Paste a plan, a spec or a long request. A planner reads the code and breaks it into cards.
          You review and refine them with it. Nothing runs until you queue the plan, with the button
          or by telling the planner to.
        </p>
        {failure !== null && <div className="error-bar">{failure}</div>}
        <textarea
          ref={inputRef}
          className="plan-compose-input"
          aria-label="What should be planned"
          placeholder="Describe the work: goals, constraints, the order things need to happen in…"
          value={prompt}
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              start();
            }
          }}
        />
        <footer className="plan-compose-foot">
          <ModelSelector value={choice} onChange={setChoice} disabled={busy} persist={false} />
          <span className="plan-compose-hint">Plans with this agent. The cards run on it too.</span>
          <span className="composer-spacer" />
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || prompt.trim().length === 0}
            onClick={start}
            title="Draft cards (⌘↵)"
          >
            {busy ? "Starting planner…" : "Draft cards"}
          </button>
        </footer>
        {props.resumable.length > 0 && (
          <section className="plan-resume" aria-label="Plans in progress">
            <h2 className="plan-resume-head">In progress</h2>
            {props.resumable.map((plan) => {
              const standing = planStanding(plan, props.cards, props.planner(plan));
              return (
                <button key={plan.id} type="button" className="plan-resume-row" onClick={() => props.onOpen(plan.id)}>
                  <StatusGlyph status={standing.glyph} />
                  <span className="plan-resume-title">{plan.title}</span>
                  <span className="plan-resume-meta">
                    {standing.meta} · {fmtAgo(plan.createdAt)}
                  </span>
                </button>
              );
            })}
          </section>
        )}
      </div>
    </main>
  );
}

function PlanWorkspace(props: {
  plan: BoardPlan;
  cards: BoardCard[];
  planner: SessionRecord | undefined;
  onClose(): void;
}): ReactNode {
  const { plan, cards, planner } = props;
  const { api } = useHarness();
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const drafts = cards.filter((card) => card.column === "draft");
  const writing = planner !== undefined && isLive(planner);

  const attempt = useCallback((run: () => Promise<unknown>, after?: () => void) => {
    run()
      .then(() => {
        setNotice(null);
        after?.();
      })
      .catch((error: unknown) => setNotice(messageOf(error)));
  }, []);

  const queueAll = () => {
    setBusy(true);
    // Back to the board once queued: the cards leave the plan's hands there,
    // and watching the head of the plan meet its evaluator is the next thing
    // worth looking at.
    api
      .submitPlan(plan.id)
      .then(() => props.onClose())
      .catch((error: unknown) => {
        setNotice(messageOf(error));
        setBusy(false);
      });
  };

  const discard = () => {
    if (!confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    setBusy(true);
    api
      .discardPlan(plan.id)
      .then(() => props.onClose())
      .catch((error: unknown) => {
        setNotice(messageOf(error));
        setBusy(false);
        setConfirmDiscard(false);
      });
  };

  return (
    <main className="panel board plan">
      <header className="board-head">
        <button type="button" className="btn" onClick={props.onClose}>
          ← Board
        </button>
        <h1 className="board-title plan-title" title={plan.title}>
          {plan.title}
        </h1>
        {writing && (
          <span className="plan-writing" role="status">
            <StatusGlyph status="running" />
            planner is writing
          </span>
        )}
        <span className="composer-spacer" />
        {drafts.length > 0 && (
          <button
            type="button"
            className={`btn${confirmDiscard ? " btn-danger-text" : ""}`}
            disabled={busy}
            onClick={discard}
            onBlur={() => setConfirmDiscard(false)}
          >
            {confirmDiscard ? `Discard ${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"}?` : "Discard"}
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || writing || drafts.length === 0}
          onClick={queueAll}
          title={
            writing
              ? "Wait for the planner to finish its turn"
              : "Queue every draft in this order, behind what is already queued. You can also tell the planner to."
          }
        >
          {drafts.length === 0 ? "Nothing to queue" : `Queue ${drafts.length} ${drafts.length === 1 ? "card" : "cards"}`}
        </button>
      </header>
      {notice !== null && (
        <p className="board-notice" role="status">
          {notice}
          <button type="button" className="btn btn-quiet" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </p>
      )}
      <SplitPane
        id="board-plan-split"
        className="plan-split"
        direction="row"
        fixed="second"
        label="Resize planner thread"
        initial={520}
        min={360}
        max={1100}
        first={
          <section className="plan-cards" aria-label="Plan cards">
            {cards.length === 0 ? (
              writing ? (
                <>
                  <p className="plan-empty">The planner is reading the code and writing cards…</p>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="skeleton board-card-skel" />
                  ))}
                </>
              ) : (
                <p className="plan-empty">No cards yet. Ask the planner for some in its thread.</p>
              )
            ) : (
              <ol className="plan-list">
                {cards.map((card, at) => (
                  <PlanCard
                    key={card.id}
                    card={card}
                    order={at + 1}
                    onSave={(patch) => attempt(() => api.patchCard(card.id, patch))}
                    onRemove={() => attempt(() => api.cancelCard(card.id))}
                    onNudge={(step) => {
                      const before = planNudge(cards, at, step);
                      if (before !== undefined) attempt(() => api.reorderCard(card.id, before));
                    }}
                    canUp={at > 0}
                    canDown={at < cards.length - 1}
                  />
                ))}
              </ol>
            )}
          </section>
        }
        second={
          <section className="thread-pane glass plan-thread" aria-label="Planner thread">
            {plan.sessionId !== null ? (
              <SessionPanel key={plan.sessionId} id={plan.sessionId} />
            ) : (
              <p className="plan-empty">Starting the planner…</p>
            )}
          </section>
        }
      />
    </main>
  );
}

function PlanCard(props: {
  card: BoardCard;
  order: number;
  canUp: boolean;
  canDown: boolean;
  onSave(patch: { title: string; task: string }): void;
  onRemove(): void;
  onNudge(step: 1 | -1): void;
}): ReactNode {
  const { card } = props;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(card.title);
  const [task, setTask] = useState(card.task);
  const draft = card.column === "draft";

  // A planner rewrite lands while the card is closed. Show it, rather than
  // the text this row happened to mount with.
  useEffect(() => {
    if (editing) return;
    setTitle(card.title);
    setTask(card.task);
  }, [card.title, card.task, editing]);

  const save = () => {
    const nextTask = task.trim();
    if (nextTask.length === 0) return;
    props.onSave({ title: title.trim(), task: nextTask });
    setEditing(false);
  };

  return (
    <li
      className={`plan-card${draft ? "" : " is-locked"}`}
      onKeyDown={(event) => {
        // ⌥↑ / ⌥↓ moves a card, the same chord that reorders the Queued lane.
        if (!draft || editing || !event.altKey) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        props.onNudge(event.key === "ArrowUp" ? -1 : 1);
      }}
    >
      <span className="plan-card-order" aria-hidden="true">
        {props.order}
      </span>
      <div className="plan-card-body">
        {editing ? (
          <div className="board-card-edit">
            <input
              className="board-draft-input plan-card-title-input"
              aria-label="Card title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <textarea
              className="board-draft-input"
              aria-label="Card task"
              value={task}
              rows={Math.min(14, Math.max(4, task.split("\n").length + 1))}
              onChange={(event) => setTask(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  save();
                }
                if (event.key === "Escape") setEditing(false);
              }}
            />
            <div className="board-card-actions is-open">
              <button type="button" className="btn btn-quiet" onClick={save} disabled={task.trim().length === 0}>
                Save
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="plan-card-top">
              <span className="plan-card-title">{card.title}</span>
              {!draft && <span className="plan-card-lane">{laneOf(card)}</span>}
            </div>
            <p className="plan-card-task">{card.task}</p>
            {draft && (
              <div className="plan-card-actions">
                <button type="button" className="btn btn-quiet" onClick={() => setEditing(true)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-quiet btn-icon"
                  aria-label="Move up"
                  title="Move up (⌥↑)"
                  disabled={!props.canUp}
                  onClick={() => props.onNudge(-1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn btn-quiet btn-icon"
                  aria-label="Move down"
                  title="Move down (⌥↓)"
                  disabled={!props.canDown}
                  onClick={() => props.onNudge(1)}
                >
                  ↓
                </button>
                <button type="button" className="btn btn-quiet btn-danger-text" onClick={props.onRemove}>
                  Remove
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}
