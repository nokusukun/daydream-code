/**
 * Board mode: the project's cards in six lanes.
 *
 * The board is a view of server state and nothing else — every move here is
 * a request, and the lane a card sits in is whatever the last stream frame
 * said. There is no optimistic drag: a card that lands in Working because
 * you dropped it there, and then snaps back because the server refused, is
 * a lie for the half second it lasts, and the refusal reason is the thing
 * you actually want to read.
 *
 * Four moves are legal by hand, and they are the only drops that do
 * anything: reorder within Queued, drop on Working to force start, drop on
 * the bin to cancel, and drag a Working card onto a queued one to add it as
 * a blocker. Everything else is inert rather than wrong.
 *
 * Those four rules used to be invisible: a drag lit every lane the same way
 * and most drops silently did nothing. `moveTo` now decides both what the
 * board *promises* while you drag and what it *does* when you let go, so the
 * promise cannot drift from the behaviour. Lanes that would refuse the card
 * go quiet instead of inviting the drop.
 */
import {
  useCallback,
  useMemo,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { titleFromTask, type SessionRecord } from "@daydream-code/shared";
import { ApiError, type BoardCard } from "../api.js";
import { LANES, laneOf, useBoard } from "../board.js";
import { useHarness } from "../harness.js";
import { useSessions } from "../sessions.js";
import { StatusGlyph, fmtAgo } from "../ui.js";

const DRAG_TYPE = "application/x-daydream-card";

/**
 * Lanes are not equally important and were not equally sized on purpose.
 * Working and Needs Attention carry a running session, a model, a verdict or
 * a failure reason and are the two a person scans first; Drafts and Done
 * carry a title and a timestamp. Equal sixths spent the same width on both
 * and wrapped the sentences that matter.
 */
const LANE_WEIGHT: Readonly<Record<string, number>> = {
  draft: 0.78,
  queued: 1.02,
  evaluating: 0.84,
  working: 1.2,
  attention: 1.12,
  done: 0.8,
};

/**
 * The shape of a board nobody has read yet. Every lane gets at least one, so
 * an unread lane never renders as a resolved empty one — Needs Attention
 * showing nothing is a claim, and it is the claim that matters most here.
 */
const SKELETONS: Readonly<Record<string, number>> = {
  draft: 1,
  queued: 2,
  evaluating: 1,
  working: 2,
  attention: 1,
  done: 1,
};

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Columns a person may pick up. Working cards move only as blockers. */
function draggable(card: BoardCard): boolean {
  return card.column !== "attention" && card.column !== "done";
}

function canStart(card: BoardCard): boolean {
  return card.column === "queued" || card.column === "blocked" || card.column === "evaluating";
}

function canCancel(card: BoardCard): boolean {
  return card.column === "draft" || card.column === "queued" || card.column === "blocked";
}

function queueable(card: BoardCard): boolean {
  return card.column === "queued" || card.column === "blocked";
}

/**
 * The description line under the title, deduped against it.
 *
 * A card's title is `titleFromTask(task)` — the task's first sentence —
 * until a session renames it, so rendering the task verbatim said the same
 * sentence twice on every one-sentence card, which is most of them. When
 * the title still derives from the task, the subtext is only what the task
 * says *beyond* that first sentence; empty means the title already is the
 * whole description and no line renders. A renamed card keeps the full
 * task, because its title no longer covers it.
 */
export function taskSubtext(title: string, task: string): string {
  const collapsed = task.replace(/\s+/g, " ").trim();
  if (titleFromTask(task) !== title) return collapsed;
  const line =
    task
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const sentence = (line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line).replace(/\s+/g, " ").trim();
  if (!collapsed.startsWith(sentence)) return collapsed;
  return collapsed.slice(sentence.length).replace(/^[\s.!?,;:]+/, "");
}

export type Move = "start" | "queue" | "reorder" | "block" | "cancel";

/**
 * What dropping `card` on `lane` would do, or null when the drop is inert.
 *
 * The single source of truth for the four legal moves: the drag hints read
 * it to decide which lanes light up and what verb they show, and `drop`
 * reads it to decide what to send. One function, so a lane cannot offer a
 * move the drop handler will not make.
 */
export function moveTo(card: BoardCard, lane: string): Move | null {
  if (lane === "bin") return canCancel(card) ? "cancel" : null;
  if (lane === "working") return canStart(card) ? "start" : null;
  if (lane === "queued") {
    if (card.column === "draft") return "queue";
    if (queueable(card)) return "reorder";
    if (card.column === "working" && card.sessionId !== null) return "block";
  }
  return null;
}

/**
 * The thread a click on the card body opens, or null when the card has none.
 *
 * It mirrors the primary link in the facts row exactly — the work session
 * when the card has one, the evaluator while the card is being evaluated —
 * so the whole-card click can never open something the card does not
 * visibly offer. Drafts and queued cards have no thread yet and stay inert
 * rather than growing a dead click.
 */
export function openTargetOf(
  card: Pick<BoardCard, "column">,
  session: { id: unknown } | undefined,
  evaluator: { id: unknown } | undefined,
): string | null {
  if (session !== undefined) return session.id as string;
  if (card.column === "evaluating" && evaluator !== undefined) return evaluator.id as string;
  return null;
}

/** The promise a lane makes while a card hovers it. Present tense, no period. */
export function moveVerb(move: Move): string {
  switch (move) {
    case "start":
      return "start it now";
    case "queue":
      return "queue it";
    case "reorder":
      return "drop to reorder";
    case "block":
      return "hold a card on this one";
    case "cancel":
      return "cancel it";
  }
}

export function BoardView(): ReactNode {
  const { api, select, newSession } = useHarness();
  const board = useBoard();
  const { sessions } = useSessions();
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [overCard, setOverCard] = useState<string | null>(null);
  // Roving tab stop per lane: one card in each column is tabbable, arrows
  // move between the rest. Making all of them tab stops put twenty presses
  // between the first lane and the second.
  const [cursor, setCursor] = useState<Readonly<Record<string, string>>>({});

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id as string, s])), [sessions]);
  const cardOf = useCallback((id: string) => board.cards.find((c) => c.id === id), [board.cards]);

  const attempt = useCallback(
    (run: () => Promise<unknown>) => {
      run().then(() => setNotice(null)).catch((error: unknown) => setNotice(messageOf(error)));
    },
    [],
  );

  const clearDrag = useCallback(() => {
    setDragging(null);
    setOver(null);
    setOverCard(null);
  }, []);

  // A card and the target it was dropped on decide the move; the server
  // decides whether it is allowed.
  const drop = useCallback(
    (target: { lane: string; card?: BoardCard }, event: DragEvent) => {
      event.preventDefault();
      const id = event.dataTransfer.getData(DRAG_TYPE);
      const card = dragging?.id === id ? dragging : cardOf(id);
      clearDrag();
      if (card === undefined || card === null) return;
      if (target.card?.id === card.id) return;

      switch (moveTo(card, target.lane)) {
        case "cancel":
          attempt(() => api.cancelCard(card.id));
          return;
        case "start":
          attempt(() => api.startCard(card.id));
          return;
        case "queue":
          attempt(() => api.submitCard(card.id));
          return;
        case "reorder":
          attempt(() => api.reorderCard(card.id, target.card?.id ?? null));
          return;
        case "block": {
          // A Working card dropped on a queued one becomes its blocker.
          const onto = target.card;
          if (onto === undefined || !queueable(onto) || card.sessionId === null) return;
          const names = new Set(onto.blockedBy.map((b) => b.blockerName));
          names.add(byId.get(card.sessionId)?.name ?? card.sessionId);
          attempt(() => api.setCardBlockers(onto.id, [...names], "added by hand"));
          return;
        }
        default:
          return;
      }
    },
    [api, attempt, byId, cardOf, clearDrag, dragging],
  );

  const laneProps = (lane: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      if (dragging !== null && moveTo(dragging, lane) === null) return;
      event.preventDefault();
      setOver(lane);
    },
    onDragLeave: () => setOver((current) => (current === lane ? null : current)),
    onDrop: (event: DragEvent) => drop({ lane }, event),
  });

  /**
   * ⌥↑ / ⌥↓ reorders a queued card, ↑ / ↓ walks the lane. Reorder and
   * blocking were drag-only, which PRODUCT.md rules out; this is the half
   * that can be given a key without inventing a second grammar for it.
   */
  const laneKeys = useCallback(
    (cards: BoardCard[]) => (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const tag = (event.target as HTMLElement).tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      const host = event.currentTarget;
      const rows = [...host.querySelectorAll<HTMLElement>("[data-card]")];
      const at = rows.findIndex((row) => row.contains(document.activeElement));
      if (at === -1) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const card = cards[at];
      if (event.altKey) {
        if (card === undefined || !queueable(card)) return;
        // `before` is the card to insert ahead of; moving down has to clear
        // the neighbour it swaps with, hence at + 2.
        const before = step === 1 ? cards[at + 2] : cards[at - 1];
        if (step === 1 ? at === cards.length - 1 : at === 0) return;
        attempt(() => api.reorderCard(card.id, before?.id ?? null));
        return;
      }
      rows[at + step]?.focus();
    },
    [api, attempt],
  );

  if (board.enabled === false) {
    return (
      <main className="panel board board-off">
        <div className="board-empty">
          <h2>Kanban mode is off</h2>
          <p>
            Turn on the four <strong>kanban</strong> rows in Settings and every new thread becomes a
            card here, cleared by an evaluator before it runs.
          </p>
        </div>
      </main>
    );
  }

  const known = board.enabled !== null;
  const needsYou = board.cards.filter((card) => card.column === "attention").length;

  return (
    <main className="panel board">
      <header className="board-head">
        <h1 className="board-title">Board</h1>
        {!known && <span className="board-checking">checking…</span>}
        {known && needsYou > 0 && (
          <span className="board-alert">
            <StatusGlyph status="failed" />
            {needsYou} {needsYou === 1 ? "card needs" : "cards need"} you
          </span>
        )}
        <span className="composer-spacer" />
        <button
          type="button"
          className="btn"
          onClick={newSession}
          title="Open a new thread to describe the card (⌘N)"
        >
          New card
        </button>
      </header>
      {(notice ?? board.error) !== null && (
        <p className="board-notice" role="status">
          {notice ?? board.error}
          <button type="button" className="btn btn-quiet" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </p>
      )}
      <div className={`board-lanes${dragging !== null ? " is-dragging" : ""}`}>
        {LANES.map((lane) => {
          const cards = board.cards.filter((card) => laneOf(card) === lane.id);
          const move = dragging === null ? null : moveTo(dragging, lane.id);
          const armed = move !== null;
          const state = dragging === null ? "" : armed ? " is-armed" : " is-inert";
          return (
            <section
              key={lane.id}
              className={`board-lane board-lane-${lane.id}${state}${over === lane.id && armed ? " is-over" : ""}`}
              style={{ ["--lane-w" as string]: LANE_WEIGHT[lane.id] ?? 1 }}
              aria-label={lane.label}
              {...(armed ? laneProps(lane.id) : {})}
            >
              <h2 className="board-lane-head">
                <span className="board-lane-name">{lane.label}</span>
                {armed && move !== null ? (
                  <span className="board-lane-move">{moveVerb(move)}</span>
                ) : (
                  known && <span className="board-lane-count">{cards.length}</span>
                )}
              </h2>
              {/* No role="list" here: the same box also holds the Drafts
                  door, the loading skeletons and the empty line, and a list
                  whose children are not all list items is worse for a screen
                  reader than the section's own label. */}
              <div className="board-lane-cards" onKeyDown={laneKeys(cards)}>
                {lane.id === "draft" && (
                  <button type="button" className="board-lane-new" onClick={newSession}>
                    + New card
                  </button>
                )}
                {!known &&
                  Array.from({ length: SKELETONS[lane.id] ?? 1 }, (_, i) => (
                    <div key={i} className="skeleton board-card-skel" />
                  ))}
                {cards.map((card) => (
                  <Card
                    key={card.id}
                    card={card}
                    session={card.sessionId === null ? undefined : byId.get(card.sessionId)}
                    evaluator={card.evaluatorSessionId === null ? undefined : byId.get(card.evaluatorSessionId)}
                    dragging={dragging?.id === card.id}
                    target={
                      overCard === card.id && dragging !== null && dragging.id !== card.id
                        ? moveTo(dragging, lane.id)
                        : null
                    }
                    blockerName={
                      dragging === null || dragging.sessionId === null
                        ? undefined
                        : (byId.get(dragging.sessionId)?.name ?? dragging.sessionId)
                    }
                    tabbable={(cursor[lane.id] ?? cards[0]?.id) === card.id}
                    onFocus={() => setCursor((prev) => ({ ...prev, [lane.id]: card.id }))}
                    reorderable={queueable(card) && cards.length > 1}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DRAG_TYPE, card.id);
                      event.dataTransfer.effectAllowed = "move";
                      setDragging(card);
                    }}
                    onDragEnd={clearDrag}
                    onDragOver={
                      lane.id === "queued"
                        ? (event) => {
                            if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
                            if (dragging === null || moveTo(dragging, "queued") === null) return;
                            event.preventDefault();
                            setOverCard(card.id);
                          }
                        : undefined
                    }
                    onDragLeave={() => setOverCard((id) => (id === card.id ? null : id))}
                    onDrop={lane.id === "queued" ? (event) => drop({ lane: "queued", card }, event) : undefined}
                    onOpen={(id) => select(id)}
                    onStart={() => attempt(() => api.startCard(card.id))}
                    onSubmit={() => attempt(() => api.submitCard(card.id))}
                    onCancel={() => attempt(() => api.cancelCard(card.id))}
                    onSave={(task) => attempt(() => api.patchCard(card.id, { task }))}
                    onUnblock={(name) =>
                      attempt(() =>
                        api.setCardBlockers(
                          card.id,
                          card.blockedBy.map((b) => b.blockerName).filter((n) => n !== name),
                        ),
                      )
                    }
                  />
                ))}
                {known && cards.length === 0 && lane.id !== "draft" && (
                  <p className="board-lane-empty">{emptyLine(lane.id)}</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <div
        className={`board-bin glass-strong${over === "bin" ? " is-over" : ""}${
          dragging !== null && canCancel(dragging) ? " is-armed" : ""
        }`}
        {...(dragging !== null && canCancel(dragging) ? laneProps("bin") : {})}
        aria-hidden={dragging === null || !canCancel(dragging)}
      >
        drop here to cancel
      </div>
    </main>
  );
}

/**
 * Empty lanes say what the lane is for, not that it is empty. A board a
 * person meets for the first time has five of these on screen at once, and
 * "nothing waiting" five times teaches nothing about how a card travels.
 */
function emptyLine(lane: string): string {
  switch (lane) {
    case "queued":
      return "cards wait here in order. the one on top starts next.";
    case "evaluating":
      return "each card is read against what is already running before it starts.";
    case "working":
      return "cleared cards run here, one thread each.";
    case "attention":
      return "nothing is stuck. a card lands here when its run fails or asks you something.";
    case "done":
      return "finished cards stay as a record of what ran.";
    default:
      return "";
  }
}

function Card(props: {
  card: BoardCard;
  session: SessionRecord | undefined;
  evaluator: SessionRecord | undefined;
  dragging: boolean;
  /** The move a hovering card would make onto this one, when it is hovered. */
  target: Move | null;
  /** Name of the session being dragged, for the `block` promise. */
  blockerName: string | undefined;
  tabbable: boolean;
  reorderable: boolean;
  onFocus(): void;
  onDragStart(event: DragEvent): void;
  onDragEnd(): void;
  onDragOver?: ((event: DragEvent) => void) | undefined;
  onDragLeave(): void;
  onDrop?: ((event: DragEvent) => void) | undefined;
  onOpen(sessionId: string): void;
  onStart(): void;
  onSubmit(): void;
  onCancel(): void;
  onSave(task: string): void;
  onUnblock(name: string): void;
}): ReactNode {
  const { card, session, evaluator, target } = props;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(card.task);
  const openId = openTargetOf(card, session, evaluator);
  /**
   * The whole card is a hit target for the thread it points at. The
   * `.board-link` in the facts row stays as the labelled, accessible
   * control; the card body is the enlarged redundant target on top of it,
   * so clicks that belong to something else — a button, the editor, a text
   * selection being copied off the card — must fall through untouched.
   * A real drag never reaches here: once a drag operation starts, the
   * browser does not fire click on its source.
   */
  const openFromClick = (event: MouseEvent<HTMLElement>) => {
    if (openId === null) return;
    if ((event.target as HTMLElement).closest("button, a, textarea, input") !== null) return;
    // Only a selection inside this card swallows the click. Cards are
    // user-select: none today, so this is insurance for the day they are
    // not — and the containment check matters now: without it, a selection
    // lingering anywhere else on the page would silently kill every card
    // click.
    const selection = window.getSelection();
    if (
      selection !== null &&
      !selection.isCollapsed &&
      selection.toString().length > 0 &&
      event.currentTarget.contains(selection.anchorNode)
    )
      return;
    props.onOpen(openId);
  };
  // Enter opens only when the article itself holds focus (the roving tab
  // stop), never when it bubbles up out of the editor or a button.
  const openFromKey = (event: KeyboardEvent<HTMLElement>) => {
    if (openId === null || event.key !== "Enter" || event.target !== event.currentTarget) return;
    event.preventDefault();
    props.onOpen(openId);
  };
  const status = session?.status ?? (card.column === "evaluating" ? "running" : card.column);
  const subtext = taskSubtext(card.title, card.task);
  const acts = [
    card.column === "draft" && { label: "Queue", run: props.onSubmit, danger: false },
    (card.column === "draft" || card.column === "queued") && {
      label: "Edit",
      run: () => setEditing(true),
      danger: false,
    },
    canStart(card) && { label: "Start now", run: props.onStart, danger: false },
    canCancel(card) && { label: "Cancel", run: props.onCancel, danger: true },
  ].filter((a): a is { label: string; run: () => void; danger: boolean } => a !== false);

  return (
    <article
      data-card={card.id}
      tabIndex={props.tabbable ? 0 : -1}
      onFocus={props.onFocus}
      className={`board-card board-card-${card.column}${props.dragging ? " is-dragging" : ""}${
        target === "block" ? " is-target" : ""
      }${target === "reorder" || target === "queue" ? " is-insert" : ""}${
        openId !== null ? " is-openable" : ""
      }`}
      {...(openId !== null && !editing ? { onClick: openFromClick, onKeyDown: openFromKey } : {})}
      draggable={draggable(card)}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      {...(props.onDrop !== undefined
        ? { onDragOver: props.onDragOver, onDragLeave: props.onDragLeave, onDrop: props.onDrop }
        : {})}
      {...(props.reorderable ? { title: "⌥↑ / ⌥↓ to reorder" } : {})}
    >
      <div className="board-card-top">
        <span className="board-card-glyph">
          <StatusGlyph status={status} />
        </span>
        <span className="board-card-title">{card.title}</span>
        <span className="board-card-time" title={new Date(card.updatedAt).toLocaleString()}>
          {fmtAgo(card.updatedAt)}
        </span>
      </div>

      {card.column === "blocked" && (
        <div className="board-card-blockers">
          <span className="board-card-label">blocked by</span>
          {card.blockedBy.map((block) => (
            <span key={block.blockerSessionId} className="board-chip" title={block.reason ?? undefined}>
              {block.blockerName}
              <button
                type="button"
                className="board-chip-x"
                aria-label={`stop waiting on ${block.blockerName}`}
                onClick={() => props.onUnblock(block.blockerName)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {card.column === "attention" && card.attentionReason !== null && (
        <p className="board-card-reason board-card-reason-attention" title={card.attentionReason}>
          {card.attentionReason}
        </p>
      )}
      {card.verdict !== null && card.column !== "attention" && (
        <p
          className="board-card-reason"
          title={`evaluator: ${card.verdict.decision} — ${card.verdict.reason}`}
        >
          <span className="board-card-label">{card.verdict.decision}</span>
          {card.verdict.reason}
        </p>
      )}

      {editing ? (
        <div className="board-card-edit">
          <textarea
            className="board-draft-input"
            value={text}
            rows={3}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="board-card-actions is-open">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                props.onSave(text.trim());
                setEditing(false);
              }}
              disabled={text.trim().length === 0}
            >
              Save
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        subtext.length > 0 && (
          <p className="board-card-task" title={card.task}>
            {subtext}
          </p>
        )
      )}

      {target === "block" && props.blockerName !== undefined && (
        <p className="board-card-hint">hold until {props.blockerName} finishes</p>
      )}

      <div className="board-card-facts">
        {card.request.driver !== undefined && <span>{card.request.driver}</span>}
        {session !== undefined && (
          <button type="button" className="board-link" onClick={() => props.onOpen(session.id as string)}>
            {session.name}
          </button>
        )}
        {evaluator !== undefined && card.column === "evaluating" && (
          <button type="button" className="board-link" onClick={() => props.onOpen(evaluator.id as string)}>
            evaluator: {evaluator.name}
          </button>
        )}
      </div>

      {!editing && acts.length > 0 && (
        <div className="board-card-actions">
          {acts.map((act) => (
            <button
              key={act.label}
              type="button"
              className={`btn btn-quiet${act.danger ? " btn-danger-text" : ""}`}
              {...(act.label === "Start now" ? { title: "Skip evaluation and run now" } : {})}
              onClick={act.run}
            >
              {act.label}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
