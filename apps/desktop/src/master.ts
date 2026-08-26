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

/* ==========================================================================
   Compaction digests
   ========================================================================== */

/**
 * How much of a digest one `Markdown` call may be handed at a time.
 *
 * A compaction entry is not a message. It is every fact from the prefix it
 * supersedes — the compactor budgets it in tokens, so nothing bounds it in the
 * units a renderer cares about, and this project's own thread produces one of
 * ~190k characters. Measured: that parses in ~7ms and renders to ~230kB of
 * markup, so it is not the hang the parser's known worst cases would be — it
 * is a single timeline row that quietly becomes larger than the rest of the
 * feed put together, inside a container that scrolls and re-anchors. The view
 * pages it instead: bounded work per chunk, and only what the reader asked
 * for is in the document.
 */
export const DIGEST_CHUNK_CHARS = 6_000;

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/;

/**
 * Split a digest into render-sized chunks at line boundaries.
 *
 * Chunks are parsed independently, so a fence left open at a chunk's end would
 * swallow the rest of that chunk's markdown and leak a stray closer into the
 * next one — session summaries carry fenced blocks, so this is the common case
 * rather than the pathological one. A chunk that ends inside a fence is closed,
 * and the chunk after it reopens with the same marker and info string.
 *
 * A single line longer than `chunkChars` is its own chunk rather than being
 * split: breaking mid-line would cut a word, and the compactor already caps
 * each line at a share of the digest.
 */
export function digestChunks(text: string, chunkChars = DIGEST_CHUNK_CHARS): string[] {
  if (text === "") return [];
  const chunks: string[] = [];
  let buf: string[] = [];
  let used = 0;
  // The fence a chunk ends inside of, and so the one the next chunk reopens.
  let open: { marker: string; info: string } | null = null;
  // Characters a chunk starts with before any of its own lines: the reopened
  // fence, when the previous chunk ended inside one.
  let carriedChars = 0;

  const flush = (): void => {
    if (buf.length === 0) return;
    const reopen =
      open === null
        ? null
        : open.info === "" ? open.marker : `${open.marker}${open.info}`;
    if (open !== null) buf.push(open.marker);
    chunks.push(buf.join("\n"));
    buf = [];
    used = 0;
    carriedChars = 0;
    if (reopen !== null) {
      buf.push(reopen);
      used = reopen.length + 1;
      carriedChars = used;
    }
  };

  for (const line of text.split("\n")) {
    // Measuring against the chunk's own start keeps an over-long line from
    // flushing an empty chunk — or a bare reopened fence — ahead of itself.
    if (used > carriedChars && used + line.length + 1 > chunkChars) flush();
    buf.push(line);
    used += line.length + 1;

    const fence = FENCE.exec(line);
    if (fence === null) continue;
    const marker = fence[1] as string;
    if (open === null) open = { marker, info: fence[2] as string };
    else if (
      marker[0] === open.marker[0] &&
      marker.length >= open.marker.length &&
      fence[2] === ""
    ) {
      open = null;
    }
  }
  flush();
  return chunks;
}
