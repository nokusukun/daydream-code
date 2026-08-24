/**
 * The project's master thread, as the renderer sees it.
 *
 * Lives outside the views because two of them read it: the sidebar card, which
 * shows what the thread is about right now, and the main panel, which shows
 * the whole timeline. One hook so they can never disagree about how many
 * entries there are.
 */
import { useCallback, useEffect, useState } from "react";
import type { SessionRecord, ThreadEntry } from "@daydream-code/shared";
import { useHarness } from "./harness.js";

/** A one-sentence lede longer than this gets trimmed at a word boundary. */
const LEDE_CHARS = 180;

/**
 * The collapsed entry is a single sentence: the first one, flattened. Thread
 * messages lead with their point ("session X ended (killed).") and follow with
 * task/summary detail, so sentence one is the description and the rest is
 * context worth a click.
 */
export function lede(flat: string): string {
  const boundary = /[.!?]["'”’`)\]]*(?=\s|$)/g;
  for (let m = boundary.exec(flat); m !== null; m = boundary.exec(flat)) {
    const end = m.index + m[0].length;
    // Skip stubs like "e.g." or a bare initial; they are not the sentence.
    if (end >= 24) return clip(flat.slice(0, end));
  }
  return clip(flat);
}

export function clip(text: string, max = LEDE_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.44 ? cut.slice(0, space) : cut).replace(/[.,;:\s]+$/, "")}…`;
}

/** Entry kinds, minus the `session_` prefix that every one of them shares. */
export function entryKind(entry: ThreadEntry): string {
  return entry.kind.replace(/^session_/, "");
}

export interface MasterState {
  entries: ThreadEntry[] | null;
  /** Sessions named by the thread, so entries can print a name not an id. */
  sessions: ReadonlyMap<string, SessionRecord>;
  error: string | null;
  refetch(): void;
}

/**
 * `all` switches between the live context the model actually sees and the full
 * history including entries a compaction has superseded. The distinction is
 * the whole point of the thread being copy-on-write, so it is a read option
 * rather than two different endpoints.
 */
export function useMaster(all = false): MasterState {
  const { api, subscribe, resyncTick } = useHarness();
  const [entries, setEntries] = useState<ThreadEntry[] | null>(null);
  const [sessions, setSessions] = useState<ReadonlyMap<string, SessionRecord>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    api
      .master(all)
      .then((list) => {
        setEntries(list);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    api
      .sessions()
      .then((list) => setSessions(new Map(list.map((s) => [s.id as string, s]))))
      .catch(() => undefined);
  }, [api, all]);

  useEffect(refetch, [refetch, resyncTick]);

  useEffect(
    () =>
      subscribe((frame) => {
        // Thread entries arrive at dispatch/turn-end cadence, so a refetch is
        // cheap; it is also the only correct move once a compaction supersedes
        // a prefix of the thread.
        if (frame.kind === "thread") refetch();
      }),
    [subscribe, refetch],
  );

  return { entries, sessions, error, refetch };
}
