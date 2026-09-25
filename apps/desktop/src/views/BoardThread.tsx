/**
 * The thread beside the board.
 *
 * Opening a card used to leave the board: it selected the thread and switched
 * to agent mode, so reading one run cost you your place among the others, and
 * getting back meant switching modes and finding the lane again. A card now
 * opens its thread in a pane on the board's trailing edge. The lanes stay
 * live on the left, and opening another card swaps the pane rather than
 * stacking a second one.
 *
 * Only the board opens threads here. The rail and the palette still select a
 * thread, which is agent mode's job. The pane's "Open in Threads" button does
 * the same for the thread it holds, and leaves the pane open behind it, so
 * coming back to the board finds it where it was.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useHarness } from "../harness.js";
import { SplitPane } from "../split.js";
import { planStorage } from "./PlanView.js";
import { SessionPanel } from "./SessionPanel.js";

const THREAD_KEY = "daydream.board.thread";

/**
 * The session open beside the board, remembered per project across reloads
 * for the reason the plan screen is: a reload is how a renderer change gets
 * picked up, and it should not close what you were reading. Per project,
 * because a session id means nothing in another project's board.
 */
export function useBoardThread(): [string | null, (id: string | null) => void] {
  // Optional on purpose: the board's tests mount it under a harness stub
  // with no connection.
  const root = useHarness().connection?.rootPath;
  const key = root === undefined ? THREAD_KEY : `${THREAD_KEY}:${root}`;
  const [thread, setThreadState] = useState<string | null>(() => planStorage()?.getItem(key) ?? null);
  useEffect(() => setThreadState(planStorage()?.getItem(key) ?? null), [key]);
  const setThread = useCallback(
    (id: string | null) => {
      if (id === null) planStorage()?.removeItem(key);
      else planStorage()?.setItem(key, id);
      setThreadState(id);
    },
    [key],
  );
  return [thread, setThread];
}

/**
 * The board, with the open card's thread beside it when there is one.
 *
 * The split is always mounted and collapses when nothing is open. Switching
 * between a bare board and a split one would remount the board, and a
 * remount scrolls the lanes back to Drafts, so the Done card you just clicked
 * would slide out of view as its thread slid in.
 */
export function BoardSplit(props: {
  board: ReactNode;
  threadId: string | null;
  onClose(): void;
}): ReactNode {
  const { threadId } = props;
  const { select } = useHarness();

  // The pane takes width from the lanes, which can push the card that was
  // just opened out of view. `nearest` leaves the board alone when the card
  // is still on screen.
  useEffect(() => {
    if (threadId === null) return;
    document
      .querySelector<HTMLElement>(".board-card.is-open")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [threadId]);

  return (
    <SplitPane
      id="board-thread-split"
      className="board-split"
      collapsed={threadId === null}
      direction="row"
      fixed="second"
      label="Resize card thread"
      initial={560}
      min={360}
      max={1400}
      first={props.board}
      second={
        threadId === null ? null : (
          <section className="thread-pane glass board-thread" aria-label="Card thread">
            <SessionPanel
              key={threadId}
              id={threadId}
              close={{ label: "Close card thread", onClick: props.onClose }}
              expand={{ label: "Open in Threads", onClick: () => select(threadId) }}
            />
          </section>
        )
      }
    />
  );
}
