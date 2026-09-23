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
 */
import {
  useCallback,
  useMemo,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import type { SessionRecord } from "@daydream-code/shared";
import { ApiError, type BoardCard } from "../api.js";
import { LANES, laneOf, useBoard } from "../board.js";
import { useHarness } from "../harness.js";
import { useSessions } from "../sessions.js";
import { StatusGlyph, fmtAgo } from "../ui.js";

const DRAG_TYPE = "application/x-daydream-card";

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

export function BoardView(): ReactNode {
  const { api, select, newSession } = useHarness();
  const board = useBoard();
  const { sessions } = useSessions();
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id as string, s])), [sessions]);
  const cardOf = useCallback((id: string) => board.cards.find((c) => c.id === id), [board.cards]);

  const attempt = useCallback(
    (run: () => Promise<unknown>) => {
      run().then(() => setNotice(null)).catch((error: unknown) => setNotice(messageOf(error)));
    },
    [],
  );

  // A card and the target it was dropped on decide the move; the server
  // decides whether it is allowed.
  const drop = useCallback(
    (target: { lane: string; card?: BoardCard }, event: DragEvent) => {
      event.preventDefault();
      setOver(null);
      const id = event.dataTransfer.getData(DRAG_TYPE);
      const card = dragging?.id === id ? dragging : cardOf(id);
      setDragging(null);
      if (card === undefined || card === null) return;
      if (target.card?.id === card.id) return;

      if (target.lane === "bin") {
        if (canCancel(card)) attempt(() => api.cancelCard(card.id));
        return;
      }
      if (target.lane === "working") {
        if (canStart(card)) attempt(() => api.startCard(card.id));
        return;
      }
      if (target.lane === "queued") {
        // A Working card dropped on a queued one becomes its blocker.
        if (card.column === "working" && target.card !== undefined && card.sessionId !== null) {
          const onto = target.card;
          if (onto.column !== "queued" && onto.column !== "blocked") return;
          const names = new Set(onto.blockedBy.map((b) => b.blockerName));
          names.add(byId.get(card.sessionId)?.name ?? card.sessionId);
          attempt(() => api.setCardBlockers(onto.id, [...names], "added by hand"));
          return;
        }
        if (card.column === "draft") {
          attempt(() => api.submitCard(card.id));
          return;
        }
        if (card.column === "queued" || card.column === "blocked") {
          attempt(() => api.reorderCard(card.id, target.card?.id ?? null));
        }
      }
    },
    [api, attempt, byId, cardOf, dragging],
  );

  const laneProps = (lane: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      setOver(lane);
    },
    onDragLeave: () => setOver((current) => (current === lane ? null : current)),
    onDrop: (event: DragEvent) => drop({ lane }, event),
  });

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

  return (
    <main className="panel board">
      <header className="board-head">
        <h1 className="board-title">Board</h1>
        <span className="board-count">{board.cards.length} cards</span>
        <span className="composer-spacer" />
        <button type="button" className="btn" onClick={newSession} title="Queue a new task (⌘N)">
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
      <div className="board-lanes">
        {LANES.map((lane) => {
          const cards = board.cards.filter((card) => laneOf(card) === lane.id);
          const droppable = lane.id === "queued" || lane.id === "working";
          return (
            <section
              key={lane.id}
              className={`board-lane board-lane-${lane.id}${over === lane.id && droppable ? " is-over" : ""}`}
              aria-label={lane.label}
              {...(droppable ? laneProps(lane.id) : {})}
            >
              <h2 className="board-lane-head">
                {lane.label}
                <span className="board-lane-count">{cards.length}</span>
              </h2>
              <div className="board-lane-cards">
                {lane.id === "draft" && <DraftComposer onCreate={(task) => attempt(() => api.createCard({ task, draft: true }))} />}
                {cards.map((card) => (
                  <Card
                    key={card.id}
                    card={card}
                    lane={lane.id}
                    session={card.sessionId === null ? undefined : byId.get(card.sessionId)}
                    evaluator={card.evaluatorSessionId === null ? undefined : byId.get(card.evaluatorSessionId)}
                    dragging={dragging?.id === card.id}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DRAG_TYPE, card.id);
                      event.dataTransfer.effectAllowed = "move";
                      setDragging(card);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
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
                {cards.length === 0 && lane.id !== "draft" && (
                  <p className="board-lane-empty">{emptyLine(lane.id)}</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <div
        className={`board-bin${over === "bin" ? " is-over" : ""}${dragging !== null && canCancel(dragging) ? " is-armed" : ""}`}
        {...laneProps("bin")}
        aria-label="Drop here to cancel"
      >
        drop here to cancel
      </div>
    </main>
  );
}

function emptyLine(lane: string): string {
  switch (lane) {
    case "queued":
      return "nothing waiting";
    case "evaluating":
      return "nothing being judged";
    case "working":
      return "nothing running";
    case "attention":
      return "nothing needs you";
    case "done":
      return "nothing finished yet";
    default:
      return "";
  }
}

/** A draft is text the board holds for you; nothing runs until you submit it. */
function DraftComposer(props: { onCreate(task: string): void }): ReactNode {
  const [text, setText] = useState("");
  const save = () => {
    const task = text.trim();
    if (task.length === 0) return;
    props.onCreate(task);
    setText("");
  };
  return (
    <div className="board-draft-composer">
      <textarea
        className="board-draft-input"
        placeholder="Jot a task to queue later"
        value={text}
        rows={2}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save();
        }}
      />
      <button type="button" className="btn btn-quiet" disabled={text.trim().length === 0} onClick={save}>
        Save draft
      </button>
    </div>
  );
}

function Card(props: {
  card: BoardCard;
  lane: string;
  session: SessionRecord | undefined;
  evaluator: SessionRecord | undefined;
  dragging: boolean;
  onDragStart(event: DragEvent): void;
  onDragEnd(): void;
  onDrop?: ((event: DragEvent) => void) | undefined;
  onOpen(sessionId: string): void;
  onStart(): void;
  onSubmit(): void;
  onCancel(): void;
  onSave(task: string): void;
  onUnblock(name: string): void;
}): ReactNode {
  const { card, session, evaluator } = props;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(card.task);
  const status = session?.status ?? (card.column === "evaluating" ? "running" : card.column);

  return (
    <article
      className={`board-card board-card-${card.column}${props.dragging ? " is-dragging" : ""}`}
      draggable={draggable(card)}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      {...(props.onDrop !== undefined
        ? {
            onDragOver: (event: DragEvent) => {
              if (event.dataTransfer.types.includes(DRAG_TYPE)) event.preventDefault();
            },
            onDrop: props.onDrop,
          }
        : {})}
      title={card.task}
    >
      <div className="board-card-top">
        <span className="board-card-glyph">
          <StatusGlyph status={status} />
        </span>
        <span className="board-card-title">{card.title}</span>
        <span className="board-card-time">{fmtAgo(card.updatedAt)}</span>
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
        <p className="board-card-reason board-card-reason-attention">{card.attentionReason}</p>
      )}
      {card.verdict !== null && card.column !== "attention" && (
        <p className="board-card-reason" title={`evaluator: ${card.verdict.decision}`}>
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
          <div className="board-card-actions">
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
        <p className="board-card-task">{card.task}</p>
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

      {!editing && (
        <div className="board-card-actions">
          {card.column === "draft" && (
            <>
              <button type="button" className="btn btn-quiet" onClick={props.onSubmit}>
                Queue
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => setEditing(true)}>
                Edit
              </button>
            </>
          )}
          {card.column === "queued" && (
            <button type="button" className="btn btn-quiet" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {canStart(card) && (
            <button type="button" className="btn btn-quiet" onClick={props.onStart} title="Skip evaluation and run now">
              Start now
            </button>
          )}
          {canCancel(card) && (
            <button type="button" className="btn btn-quiet btn-danger-text" onClick={props.onCancel}>
              Cancel
            </button>
          )}
        </div>
      )}
    </article>
  );
}
