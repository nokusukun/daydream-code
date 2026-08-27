/**
 * ⌘K palette: the app's navigation. Typing filters sessions and commands; a
 * leading `?` searches the journal, which is the only search surface now that
 * the header tabs are gone.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  compareSessionRecency,
  sessionActivityAt,
} from "@daydream-code/shared";
import type { SearchHit } from "../api.js";
import { bridge } from "../bridge.js";
import { useHarness } from "../harness.js";
import { runPaletteAction } from "../palette-actions.js";
import { useDesktopModules } from "../modules/react.js";
import type { DesktopHost } from "../modules/host.js";
import { isArchived, useSessions } from "../sessions.js";
import { fmtAgo } from "../ui.js";

interface Item {
  key: string;
  group: string;
  label: string;
  hint?: string;
  snippet?: string;
  run(): void;
}

const SEARCH_PREFIX = "?";

export function CommandPalette(props: {
  onSwitchProject?: (() => void) | undefined;
}): ReactNode {
  const { select, setOverlay, sidebar, toggleSidebar } = useHarness();
  const modules = useDesktopModules<DesktopHost>();
  const { sessions } = useSessions();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const searching = query.startsWith(SEARCH_PREFIX);
  const term = searching ? query.slice(1).trim() : query.trim();
  const hits = useJournalSearch(searching ? term : "");

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setActive(0), [query]);

  const close = useCallback(() => setOverlay(null), [setOverlay]);

  const items = useMemo<Item[]>(() => {
    if (searching) {
      return hits.map((hit) => ({
        key: `hit-${hit.eventId}`,
        group: "journal",
        label: hit.type,
        snippet: hit.snippet,
        hint: fmtAgo(hit.ts),
        run: () => select(hit.sessionId as unknown as string),
      }));
    }

    const lower = term.toLowerCase();
    const match = (text: string): boolean =>
      lower.length === 0 || text.toLowerCase().includes(lower);

    // Sort before the slice: with an empty query this list is the eight most
    // recently active sessions, not eight arbitrary ones.
    //
    // An archived run is findable by name but never fills one of those eight
    // slots unprompted — offering it back the moment you open the palette is
    // the shelf leaking into the list it was meant to leave.
    const sessionItems: Item[] = sessions
      .filter((s) => (lower.length === 0 ? !isArchived(s) : true))
      .filter((s) => match(`${s.name ?? ""} ${s.id as string} ${s.task}`))
      .sort(compareSessionRecency)
      .slice(0, 8)
      .map((s) => ({
        key: `session-${s.id as string}`,
        group: "sessions",
        label: s.name ?? (s.id as string),
        hint: `${isArchived(s) ? "archived · " : ""}${s.status} · ${fmtAgo(sessionActivityAt(s))}`,
        run: () => select(s.id as string),
      }));

    const overlayCommands = modules.overlays
      .flatMap((overlay) =>
        overlay.command === undefined
          ? []
          : [
              {
                key: `overlay-${overlay.id}`,
                group: "commands",
                label: overlay.command.label,
                ...(overlay.command.hint === undefined
                  ? {}
                  : { hint: overlay.command.hint }),
                order: overlay.command.order ?? 0,
                run: () => setOverlay(overlay.id),
              },
            ],
      )
      .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));

    const commands: Item[] = [
      {
        key: "cmd-search",
        group: "commands",
        label: "Search the journal",
        hint: "?",
        run: () => setQuery(SEARCH_PREFIX),
      },
      ...overlayCommands,
      {
        // The toolbar no longer has a button for this — that slot is quick
        // actions now — so the palette is where it stays reachable without
        // knowing the shortcut.
        key: "cmd-sidebar",
        group: "commands",
        label: sidebar ? "Hide sidebar" : "Show sidebar",
        hint: "⌘B",
        run: toggleSidebar,
      },
      {
        key: "cmd-settings",
        group: "commands",
        label: "Settings…",
        hint: "⌘,",
        run: () => void bridge()?.openSettings(),
      },
      ...(props.onSwitchProject !== undefined
        ? [
            {
              key: "cmd-project",
              group: "commands",
              label: "Switch project…",
              hint: "⌘⇧O",
              run: props.onSwitchProject,
            },
          ]
        : []),
    ].filter((item) => match(item.label));

    return [...sessionItems, ...commands];
  }, [
    searching,
    hits,
    sessions,
    term,
    select,
    setOverlay,
    sidebar,
    toggleSidebar,
    modules.overlays,
    props.onSwitchProject,
  ]);

  const choose = useCallback(
    (item: Item | undefined) => {
      if (item === undefined) return;
      runPaletteAction(
        { keepOpen: item.key.startsWith("cmd-search"), run: item.run },
        close,
      );
    },
    [close],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (items.length === 0) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + delta + items.length) % items.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        choose(items[active]);
      }
    },
    [items, active, choose, close],
  );

  let index = -1;
  let lastGroup = "";

  return (
    <div
      className="scrim"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="palette glass-strong"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Jump to a session, or type ? to search the journal"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="palette-list">
          {items.length === 0 && (
            <p className="palette-empty">
              {searching && term.length === 0
                ? "Type to search every journaled event."
                : "Nothing matches."}
            </p>
          )}
          {items.map((item) => {
            index += 1;
            const i = index;
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.key}>
                {header !== null && <div className="palette-group">{header}</div>}
                <button
                  type="button"
                  className="palette-item"
                  data-active={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(item)}
                >
                  <span className="palette-label">{item.label}</span>
                  {item.snippet !== undefined && (
                    <span className="hit-snippet">{item.snippet}</span>
                  )}
                  {item.hint !== undefined && (
                    <span className="palette-hint">{item.hint}</span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Debounced journal search; empty term clears without hitting the server. */
function useJournalSearch(term: string): SearchHit[] {
  const { api } = useHarness();
  const [hits, setHits] = useState<SearchHit[]>([]);

  useEffect(() => {
    if (term.length === 0) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .search(term, { limit: 30 })
        .then((list) => {
          if (!cancelled) setHits(list);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, term]);

  return hits;
}
