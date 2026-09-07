/**
 * The main panel with nothing selected — which is the master thread, not an
 * empty state.
 *
 * Its Changes tab is the whole working tree, because every run's edits land in
 * one tree, and its Usage tab is the project's bill. Its composer dispatches:
 * typing at the master thread is how a run comes to exist, so there is nothing
 * else the box under it could sensibly do.
 */
import { useState, type ReactNode } from "react";
import { useHarness } from "../harness.js";
import { useMaster } from "../master.js";
import { useSessions } from "../sessions.js";
import { useWorkspace } from "../workspace.js";
import { PanelHead, type PanelCloseAction } from "./PanelHead.js";
import { MasterThread } from "./MasterThread.js";
import { ChangesView } from "./ChangesView.js";
import { UsageView } from "./UsageView.js";
import { DispatchComposer } from "./Composer.js";

export function MasterPanel(props: { close?: PanelCloseAction }): ReactNode {
  const { view, draft } = useHarness();
  const { sessions } = useSessions();
  const { status } = useWorkspace();
  // The full history includes entries a compaction has superseded. That
  // distinction is the point of the thread being copy-on-write, so it is a
  // control on the bar rather than something you would have to query for.
  const [showAll, setShowAll] = useState(false);
  const { entries } = useMaster(showAll);
  const [error, setError] = useState<string | null>(null);

  const live = sessions.filter(
    (s) => s.status === "running" || s.status === "waiting",
  ).length;

  return (
    <main className="panel">
      <div className="panel-top">
        <PanelHead
          title="Master thread"
          {...(props.close === undefined ? {} : { close: props.close })}
          sub={
            entries === null
              ? "loading…"
              : `${entries.length} ${entries.length === 1 ? "entry" : "entries"} · ${
                  sessions.length
                } thread${sessions.length === 1 ? "" : "s"}${live > 0 ? ` · ${live} live` : ""}`
          }
        >
          {view === "thread" && (
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setShowAll((v) => !v)}
              title={
                showAll
                  ? "Showing the full history including superseded entries"
                  : "Showing the live context the model actually sees"
              }
            >
              {showAll ? "full history" : "live context"}
            </button>
          )}
        </PanelHead>
        {error !== null && (
          <div className="error-bar">
            {error}
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setError(null)}
            >
              dismiss
            </button>
          </div>
        )}
      </div>

      {view === "thread" && <MasterThread showAll={showAll} />}

      {view === "changes" && (
        <div className="panel-scroll">
          <div className="column">
            <ChangesView
              note={
                status.branch !== null ? (
                  <>
                    The working tree against <code>HEAD</code> on{" "}
                    <code>{status.branch}</code>, every thread's edits in one tree.
                  </>
                ) : (
                  <>
                    The working tree against <code>HEAD</code>: every thread's
                    edits, in one tree.
                  </>
                )
              }
            />
          </div>
        </div>
      )}

      {view === "usage" && (
        <div className="panel-scroll">
          <div className="column">
            <UsageView
              sessions={sessions}
              {...(showAll ? {} : { entries: entries ?? [] })}
            />
          </div>
        </div>
      )}

      <DispatchComposer autoFocus={draft} onError={setError} />
    </main>
  );
}
