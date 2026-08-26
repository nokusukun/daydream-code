/**
 * Archived runs, as an overlay sheet.
 *
 * Archiving takes a run off the sidebar; this is where it goes. It is a
 * separate window rather than a section of the rail on purpose — a drawer that
 * expands the shelf back into the list undoes the only thing archiving does,
 * and the rail is the answer to "what am I working on", which an archived run
 * is by definition not.
 *
 * It shares `.sheet` with the fibers overlay and the palette rather than
 * inventing a surface, so the three overlays read as one kind of thing.
 */
import { useMemo, type ReactNode } from "react";
import { sessionActivityAt, type SessionRecord } from "@daydream-code/shared";
import { useHarness } from "../harness.js";
import { clip } from "../master.js";
import { StatusGlyph, fmtAgo, fmtTime } from "../ui.js";
import { railSessions, useSessionActions, useSessions } from "../sessions.js";

export function ArchiveSheet(): ReactNode {
  const { setOverlay, select, modelLabel } = useHarness();
  const { sessions, loading } = useSessions();
  const { setArchived, remove, failure } = useSessionActions();
  const archived = useMemo(() => railSessions(sessions).archived, [sessions]);

  return (
    <div
      className="scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOverlay(null);
      }}
    >
      <div
        className="sheet glass-strong archive-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Archived runs"
        onKeyDown={(event) => {
          if (event.key === "Escape") setOverlay(null);
        }}
      >
        <header className="sheet-head">
          <h2>archived</h2>
          {!loading && archived.length > 0 && (
            <span className="palette-hint">
              {archived.length} {archived.length === 1 ? "run" : "runs"}
            </span>
          )}
          <button
            type="button"
            className="btn"
            autoFocus
            onClick={() => setOverlay(null)}
          >
            done
          </button>
        </header>
        <div className="sheet-body">
          {failure !== null && <div className="error-bar">{failure}</div>}

          {/* Teach the gesture rather than saying "nothing here": the only way
              into this window is a menu item most people have not found yet. */}
          {!loading && archived.length === 0 && (
            <p className="archive-empty">
              Nothing archived. Right-click a run in the sidebar and choose
              Archive to move it here. It keeps its transcript and stays
              readable; it just stops competing for the list.
            </p>
          )}

          {archived.map((session) => (
            <ArchivedRow
              key={session.id as string}
              session={session}
              model={modelLabel(session.driver, session.modelId).label}
              onOpen={() => {
                // Opening one is a reason to close this window: the panel it
                // switches to is behind the scrim.
                select(session.id as string);
                setOverlay(null);
              }}
              onRestore={() => void setArchived(session, false)}
              onDelete={() => void remove(session)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * One shelved run: what it was, when it last did anything, and the two things
 * you can do to it.
 *
 * The actions are buttons rather than a context menu even though the rail's
 * are a menu. In the rail a menu keeps rows quiet in a list you read
 * constantly; here there are only ever a handful of rows and the whole reason
 * you opened the window is to act on one.
 */
function ArchivedRow(props: {
  session: SessionRecord;
  model: string;
  onOpen(): void;
  onRestore(): void;
  onDelete(): void;
}): ReactNode {
  const { session } = props;
  const said = clip(session.tldr ?? "", 160);
  const activity = sessionActivityAt(session);

  return (
    <div className="archive-row">
      <button
        type="button"
        className="archive-row-main"
        onClick={props.onOpen}
        title={`${session.name} · ${session.status} · ${session.driver}`}
      >
        <span className="archive-row-top">
          <StatusGlyph status={session.status} />
          <span className="archive-row-name">{session.title || session.name}</span>
          <span className="archive-row-time" title={fmtTime(activity)}>
            {fmtAgo(activity)}
          </span>
        </span>
        {said.length > 0 && <span className="archive-row-said">{said}</span>}
        <span className="archive-row-facts">
          <span>{session.name}</span>
          <span>{props.model}</span>
        </span>
      </button>
      <span className="archive-row-actions">
        <button type="button" className="btn btn-quiet" onClick={props.onRestore}>
          restore
        </button>
        <button type="button" className="btn btn-danger" onClick={props.onDelete}>
          delete
        </button>
      </span>
    </div>
  );
}
