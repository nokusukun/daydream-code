import type { ReactNode } from "react";
import { useHarness } from "../../harness.js";
import { SplitPane } from "../../split.js";
import { MasterPanel } from "../../views/MasterPanel.js";
import { SessionPanel } from "../../views/SessionPanel.js";
import type { PanelCloseAction } from "../../views/PanelHead.js";
import { ThreadRail } from "../../views/ThreadRail.js";
import type { DesktopModule } from "../runtime.js";
import type { DesktopHost } from "../host.js";

/** One thread by the workspace convention: null is the master thread. */
function ThreadPane(props: {
  id: string | null;
  close?: PanelCloseAction;
}): ReactNode {
  const close = props.close === undefined ? {} : { close: props.close };
  return props.id === null ? (
    <MasterPanel {...close} />
  ) : (
    <SessionPanel key={props.id} id={props.id} {...close} />
  );
}

/**
 * Single thread, or two side by side after a shift+click in the rail.
 *
 * Unsplit, the canvas deliberately has no shell of its own — that stays as it
 * was. Split, both threads get one: two transcripts sharing an edgeless sheet
 * read as one feed with a seam, so each pane becomes a floating piece of
 * glass like the rail, with its own edge to say where one thread ends.
 */
function AgentPanel(): ReactNode {
  const { selected, select, split, closeSplit } = useHarness();
  if (split === null) return <ThreadPane id={selected} />;

  return (
    <SplitPane
      id="agent-thread-split"
      className="thread-split"
      direction="row"
      fixed="second"
      label="Resize split thread"
      initial={560}
      min={340}
      max={1400}
      first={
        <section className="thread-pane glass" aria-label="Current thread">
          <ThreadPane
            id={selected}
            close={{
              label: "Close current thread pane",
              onClick: () => select(split.id),
            }}
          />
        </section>
      }
      second={
        <section className="thread-pane glass" aria-label="Split thread">
          <ThreadPane
            id={split.id}
            close={{ label: "Close split thread pane", onClick: closeSplit }}
          />
        </section>
      }
    />
  );
}

const agent: DesktopModule<DesktopHost> = {
  id: "agent",
  name: "Thread workspace",
  activate(context) {
    context.registerMode({
      id: "agent",
      label: "Threads",
      order: 0,
      splitId: "shell-rail",
      sidebar: ThreadRail,
      panel: AgentPanel,
    });
  },
};

export default agent;
