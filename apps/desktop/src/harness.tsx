/**
 * Renderer-side glue: one ApiClient + one websocket per open project, a tiny
 * pub/sub for stream frames, and the workspace selection model. Deliberately
 * no state library — React context + hooks only.
 *
 * There is no page routing. Both panels are always mounted; `selected` decides
 * which session the right panel shows, and `overlay` drives the palette and
 * the fibers sheet.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiClient, type DriverCatalogEntry } from "./api.js";
import { DraftStore } from "./drafts.js";
import { QuickActionStore } from "./quick-actions.js";
import { labelForModel, type ModelLabel } from "./model-label.js";
import { connectStream, type StreamFrame, type StreamStatus } from "./stream.js";
import type { ConnectionInfo } from "./bridge.js";
import { loadWindowLayout, saveWindowLayout } from "./window-layout.js";

/** Overlay ids are contributed by desktop modules. */
export type Overlay = string | null;

/**
 * Which half of the window you are in. `agent` is the harness — threads,
 * transcripts, the composer. `code` is the working tree the harness is editing.
 * They share the window rather than the sidebar because they answer different
 * questions ("what is the run doing" / "what did it do to this file") and
 * neither is a subordinate view of the other.
 */
/** Mode ids are contributed by desktop modules. */
export type Mode = string;

/** The tabs over one thread: its transcript, its files, its bill. */
export type PanelView = "thread" | "changes" | "usage";

export type { ModelLabel } from "./model-label.js";

export interface Harness {
  api: ApiClient;
  connection: ConnectionInfo;
  /** Subscribe to raw stream frames; returns an unsubscriber. */
  subscribe(listener: (frame: StreamFrame) => void): () => void;
  /**
   * Unsent composer text, kept per session so switching panels does not eat
   * it. Scoped to the open project and written through to localStorage.
   */
  drafts: DraftStore;
  /**
   * Custom toolbar actions. Not scoped to the project, unlike drafts: these
   * are habits about how you work, and they run against whichever project is
   * open, so one list serves all of them.
   */
  quickActions: QuickActionStore;
  /** Bumps on every `hello` frame — views refetch their lists on change. */
  resyncTick: number;
  wsStatus: StreamStatus;
  /**
   * Session shown in the main panel, or null for the master thread. Null is
   * the *master thread*, not an empty state: the master thread is the thing
   * sessions fork from, so it is what the window shows when nothing else is
   * chosen.
   */
  selected: string | null;
  select(id: string | null): void;
  /**
   * A second thread shown beside `selected`, or null when the view is a
   * single pane. `{ id: null }` is the master thread, the same convention
   * `selected` uses — the wrapper object is what distinguishes "master in the
   * second pane" from "no second pane".
   */
  split: { id: string | null } | null;
  /**
   * Open a thread beside the current one, or close the second pane if that
   * thread is already in it. Callers guard against splitting the thread the
   * first pane is showing — the same transcript twice is not a comparison.
   */
  toggleSplit(id: string | null): void;
  closeSplit(): void;
  mode: Mode;
  setMode(mode: Mode): void;
  view: PanelView;
  setView(view: PanelView): void;
  sidebar: boolean;
  toggleSidebar(): void;
  /**
   * Files open in the editor, in tab order. Kept here rather than in the code
   * view so that opening a file from a transcript — which is a different
   * component, in a different mode — is one call.
   */
  openFiles: readonly string[];
  /** The editor's active file, or null when nothing is open. */
  file: string | null;
  /** Open a file in the editor and switch to Code mode. */
  openFile(path: string): void;
  closeFile(path: string): void;
  /**
   * A new session the user has started but not dispatched yet. It exists only
   * in the renderer: the row is created server-side by the first message, so
   * clicking + never mints an empty session or spends a model call.
   */
  draft: boolean;
  newSession(): void;
  overlay: Overlay;
  setOverlay(overlay: Overlay): void;
  /** Driver catalog from `GET /api/models`, fetched once per connection. */
  catalog: DriverCatalogEntry[];
  /**
   * Friendly name for a model id: "Claude Opus 5" rather than
   * "claude-opus-5". Falls back to the raw id for models the catalog does not
   * know about, and to the driver's default when the id is null.
   */
  modelLabel(driver: string, modelId: string | null): ModelLabel;
}

const HarnessContext = createContext<Harness | null>(null);

export function useHarness(): Harness {
  const harness = useContext(HarnessContext);
  if (harness === null) throw new Error("useHarness outside <HarnessProvider>");
  return harness;
}

export function HarnessProvider(props: {
  connection: ConnectionInfo;
  /** Session selected by a cross-project activity-menu jump. */
  initialSelected?: string | null;
  children: ReactNode;
}): ReactNode {
  const { connection } = props;
  const api = useMemo(
    () => new ApiClient({ baseUrl: connection.url, token: connection.token }),
    [connection.url, connection.token],
  );

  // Keyed by project, not by connection: reconnecting to the same project
  // must not throw away what the user was in the middle of typing.
  const drafts = useMemo(
    () => new DraftStore({ scope: connection.rootPath }),
    [connection.rootPath],
  );

  // Quitting or reloading skips the coalescing timer, so flush by hand.
  useEffect(() => {
    const flush = (): void => drafts.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [drafts]);

  // One store per connection: the list is the project's now, so switching
  // projects has to switch lists rather than carry one across.
  const quickActions = useMemo(() => new QuickActionStore(api), [api]);

  const listeners = useRef(new Set<(frame: StreamFrame) => void>());
  const [resyncTick, setResyncTick] = useState(0);
  const [wsStatus, setWsStatus] = useState<StreamStatus>("connecting");
  const [selected, setSelected] = useState<string | null>(
    props.initialSelected ?? null,
  );
  const [split, setSplit] = useState<{ id: string | null } | null>(null);
  const [mode, setModeState] = useState<Mode>(() =>
    props.initialSelected === null || props.initialSelected === undefined
      ? loadWindowLayout().mode
      : "agent",
  );
  const [view, setView] = useState<PanelView>("thread");
  const [sidebar, setSidebar] = useState(() => loadWindowLayout().sidebar);
  const [openFiles, setOpenFiles] = useState<readonly string[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [draft, setDraft] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [catalog, setCatalog] = useState<DriverCatalogEntry[]>([]);

  const setMode = useCallback((next: Mode) => {
    setModeState(next);
    saveWindowLayout({ mode: next });
  }, []);

  useEffect(() => {
    let stale = false;
    api
      .models()
      .then((entries) => {
        if (!stale) setCatalog(entries);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api]);

  const modelLabel = useCallback(
    (driver: string, modelId: string | null): ModelLabel =>
      labelForModel(catalog, driver, modelId),
    [catalog],
  );

  useEffect(() => {
    setSelected(props.initialSelected ?? null);
    setSplit(null);
    setDraft(false);
    setOverlay(null);
    // A new connection is a new project: its paths mean nothing here.
    setOpenFiles([]);
    setFile(null);
    return connectStream(api.streamUrl(), {
      onFrame: (frame) => {
        if (frame.kind === "hello") setResyncTick((tick) => tick + 1);
        for (const listener of listeners.current) listener(frame);
      },
      onStatus: setWsStatus,
    });
  }, [api, props.initialSelected]);

  const subscribe = useCallback((listener: (frame: StreamFrame) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const select = useCallback((id: string | null) => {
    setSelected(id);
    // Selecting the thread the second pane holds would show it twice; the
    // split closes instead, which is also the natural "promote to main" move.
    setSplit((cur) => (cur !== null && cur.id === id ? null : cur));
    setDraft(false);
    setOverlay(null);
    // Changes and Usage are about the thread you were on. Landing on another
    // thread's Usage tab because that is where you happened to be reads as the
    // app losing your place.
    setView("thread");
    setMode("agent");
  }, []);

  const toggleSplit = useCallback((id: string | null) => {
    setSplit((cur) => (cur !== null && cur.id === id ? null : { id }));
    setOverlay(null);
    setMode("agent");
  }, []);

  const closeSplit = useCallback(() => setSplit(null), []);

  const toggleSidebar = useCallback(
    () =>
      setSidebar((open) => {
        const next = !open;
        saveWindowLayout({ sidebar: next });
        return next;
      }),
    [],
  );

  const openFile = useCallback((path: string) => {
    setOpenFiles((open) => (open.includes(path) ? open : [...open, path]));
    setFile(path);
    setMode("code");
    setOverlay(null);
  }, []);

  const closeFile = useCallback((path: string) => {
    setOpenFiles((open) => {
      const next = open.filter((p) => p !== path);
      // Closing the active tab lands on its neighbour, the way every editor
      // does it — falling back to "nothing open" only when it was the last.
      setFile((current) => {
        if (current !== path) return current;
        const at = open.indexOf(path);
        return next[Math.min(at, next.length - 1)] ?? null;
      });
      return next;
    });
  }, []);

  const newSession = useCallback(() => {
    setSelected(null);
    setDraft(true);
    setOverlay(null);
    setView("thread");
    setMode("agent");
  }, []);

  const harness = useMemo<Harness>(
    () => ({
      api,
      connection,
      drafts,
      quickActions,
      subscribe,
      resyncTick,
      wsStatus,
      selected,
      select,
      split,
      toggleSplit,
      closeSplit,
      mode,
      setMode,
      view,
      setView,
      sidebar,
      toggleSidebar,
      openFiles,
      file,
      openFile,
      closeFile,
      draft,
      newSession,
      overlay,
      setOverlay,
      catalog,
      modelLabel,
    }),
    [
      api,
      connection,
      drafts,
      quickActions,
      subscribe,
      resyncTick,
      wsStatus,
      selected,
      select,
      split,
      toggleSplit,
      closeSplit,
      mode,
      view,
      sidebar,
      toggleSidebar,
      openFiles,
      file,
      openFile,
      closeFile,
      draft,
      newSession,
      overlay,
      catalog,
      modelLabel,
    ],
  );

  return (
    <HarnessContext.Provider value={harness}>
      {props.children}
    </HarnessContext.Provider>
  );
}
