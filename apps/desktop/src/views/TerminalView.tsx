/**
 * The Terminal mode: real shells at the project root, beside Threads and Code.
 *
 * The emulator is here; the PTY, and the scrollback, are in main. Switching
 * modes unmounts this view — `App.tsx` renders only the active mode's panel —
 * so anything held in xterm's buffer would be lost on every visit. Opening is
 * therefore an *attach*: main replays what it kept, then live output resumes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { bridge, type TerminalEvent } from "../bridge.js";
import {
  createColorResolver,
  isDarkTheme,
  nextTerminalId,
  readTerminalTheme,
  terminalLabel,
  watchThemeTokens,
} from "../terminal.js";

/**
 * The PTY only hears about settled dimensions. Notifying on every frame of a
 * drag makes the shell reprint its prompt at each step, which reads as the
 * window stuttering.
 */
const RESIZE_SETTLE_MS = 150;

/** How long the size readout outlives the drag that produced it. */
const SIZE_HUD_MS = 900;

interface SurfaceProps {
  terminalId: string;
  visible: boolean;
  /** The tab needs to know: an exited shell wears a hollow dot up there. */
  onStatus(terminalId: string, status: "running" | "exited"): void;
}

/**
 * One terminal.
 *
 * Kept mounted while its mode is showing, even when another tab is in front —
 * a `display: none` element measures 0x0, so unmounting and remounting on every
 * tab click would round-trip the whole scrollback for nothing.
 */
function TerminalSurface(props: SurfaceProps): React.ReactNode {
  const { terminalId, visible, onStatus } = props;
  const mount = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState<number | null>(null);
  const [epoch, setEpoch] = useState(0);
  /** `120×40`, shown while a drag settles, the way Terminal.app answers one. */
  const [sizeHud, setSizeHud] = useState<string | null>(null);
  const hudTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const host = mount.current;
    const api = bridge();
    if (host === null || api === undefined) return;

    let disposed = false;
    const attachmentId = crypto.randomUUID();
    const resolver = createColorResolver(host);
    const term = new Terminal({
      fontFamily: window.getComputedStyle(host).fontFamily,
      fontSize: 12,
      // xterm owns the glyph grid, so CSS tracking cannot tighten it. Pull the
      // cell advance in by one physical CSS pixel instead; SF Mono otherwise
      // reads unusually airy at this compact size.
      letterSpacing: -1,
      lineHeight: 1.25,
      cursorBlink: true,
      // Output arrives coalesced from main, so the emulator is never the thing
      // that falls behind; scrollback here only needs to cover what main keeps.
      scrollback: 5000,
      allowProposedApi: true,
      theme: readTerminalTheme(resolver, isDarkTheme()),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    terminal.current = term;
    fit.current = fitAddon;

    // Fit before opening so the shell is spawned at the size it will be drawn
    // at, rather than at xterm's 80x24 default and immediately resized.
    let shownSize: { cols: number; rows: number } | null = null;
    try {
      fitAddon.fit();
      // Seed the readout's baseline here, or the layout settling right after
      // mount reads as a "resize" and flashes the grid size at nobody.
      shownSize = { cols: term.cols, rows: term.rows };
    } catch {
      // A zero-sized host (the mode is hidden) cannot be fitted; the
      // ResizeObserver below will do it as soon as it has a box.
    }

    let settle: ReturnType<typeof setTimeout> | null = null;
    let lastSent = { cols: 0, rows: 0 };
    const sendResize = (): void => {
      const { cols, rows } = term;
      if (cols === lastSent.cols && rows === lastSent.rows) return;
      lastSent = { cols, rows };
      void api.resizeTerminal({ terminalId, cols, rows });
    };
    const scheduleResize = (): void => {
      if (settle !== null) clearTimeout(settle);
      settle = setTimeout(sendResize, RESIZE_SETTLE_MS);
    };

    const unsubscribe = api.onTerminalEvent((event: TerminalEvent) => {
      if (disposed || event.terminalId !== terminalId) return;
      if (event.type === "output") {
        if (event.data !== undefined) term.write(event.data);
        return;
      }
      const code = event.exitCode ?? 0;
      setExited(code);
      term.write(`\r\n\u001b[2m[process exited with code ${String(code)}]\u001b[0m\r\n`);
      onStatus(terminalId, "exited");
    });

    void (async () => {
      const opened = await api.openTerminal({
        terminalId,
        attachmentId,
        cols: term.cols,
        rows: term.rows,
      });
      if (disposed) return;
      if (!opened.ok) {
        setError(opened.error);
        return;
      }
      // Replay first, then let live output through. Main captured the snapshot
      // and subscribed us in the same tick, so there is no gap to bridge here.
      if (opened.snapshot.history.length > 0) term.write(opened.snapshot.history);
      if (opened.snapshot.status === "exited") setExited(0);
      onStatus(terminalId, opened.snapshot.status);
      lastSent = { cols: opened.snapshot.cols, rows: opened.snapshot.rows };
      sendResize();
      term.focus();
    })();

    const typed = term.onData((data) => {
      void api.writeTerminal({ terminalId, data });
    });

    const observer = new ResizeObserver(() => {
      // A hidden tab reports 0x0, and fitting to that would resize the shell to
      // one column and reflow every line it has printed.
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      // The size readout appears only once the grid actually moves — the first
      // fit is layout settling, not a person asking how big the terminal is.
      if (shownSize !== null && (shownSize.cols !== term.cols || shownSize.rows !== term.rows)) {
        setSizeHud(`${String(term.cols)}×${String(term.rows)}`);
        if (hudTimer.current !== null) clearTimeout(hudTimer.current);
        hudTimer.current = setTimeout(() => setSizeHud(null), SIZE_HUD_MS);
      }
      shownSize = { cols: term.cols, rows: term.rows };
      scheduleResize();
    });
    observer.observe(host);

    const stopWatching = watchThemeTokens(() => {
      if (disposed) return;
      term.options.theme = readTerminalTheme(resolver, isDarkTheme());
    });

    return () => {
      disposed = true;
      stopWatching();
      observer.disconnect();
      if (hudTimer.current !== null) {
        clearTimeout(hudTimer.current);
        hudTimer.current = null;
      }
      if (settle !== null) {
        clearTimeout(settle);
        // The last drag step never settled; the shell would otherwise keep the
        // stale size until something else resized it.
        sendResize();
      }
      typed.dispose();
      unsubscribe();
      // Detach, not close: the shell keeps running and main keeps its output.
      void api.detachTerminal({ terminalId, attachmentId });
      term.dispose();
      resolver.dispose();
      terminal.current = null;
      fit.current = null;
    };
  }, [terminalId, onStatus, epoch]);

  // Becoming visible is not a resize the observer can see: the element went
  // from 0x0 to its real box while `display` changed, and the fit has to happen
  // after layout has run.
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      const term = terminal.current;
      if (term === null || mount.current === null) return;
      if (mount.current.clientWidth === 0) return;
      try {
        fit.current?.fit();
      } catch {
        return;
      }
      term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, epoch]);

  const restart = useCallback(() => {
    const api = bridge();
    if (api === undefined) return;
    void api.closeTerminal(terminalId).then(() => {
      setExited(null);
      setError(null);
      // Remounting the emulator is the honest way back: the old buffer belongs
      // to a shell that is gone.
      setEpoch((n) => n + 1);
    });
  }, [terminalId]);

  return (
    <div className={visible ? "term-surface" : "term-surface term-hidden"}>
      <div className="term-mount" ref={mount} />
      {sizeHud !== null && (
        <div className="term-size" aria-hidden="true">
          {sizeHud}
        </div>
      )}
      {error !== null && (
        <div className="term-notice is-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-quiet" onClick={restart}>
            Try again
          </button>
        </div>
      )}
      {error === null && exited !== null && (
        <div className="term-notice">
          <span>shell exited</span>
          <button type="button" className="btn btn-quiet" onClick={restart}>
            Start a new one
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The Terminal mode's panel: a tab strip over one live surface per terminal.
 *
 * Tabs are ids, not indexes — main keys sessions by id, and renumbering on
 * close would silently rebind a tab to somebody else's shell.
 */
export function TerminalView(): React.ReactNode {
  const [ids, setIds] = useState<string[]>(["term-1"]);
  const [active, setActive] = useState("term-1");
  const [adopted, setAdopted] = useState(false);

  // Terminals opened before this mode was last closed are still running in
  // main. Adopt them rather than stranding shells nothing can reach.
  useEffect(() => {
    const api = bridge();
    if (api === undefined) {
      setAdopted(true);
      return;
    }
    let stale = false;
    void api.listTerminals().then((running) => {
      if (stale) return;
      if (running.length > 0) {
        setIds(running);
        setActive((current) => (running.includes(current) ? current : running[0]!));
      }
      setAdopted(true);
    });
    return () => {
      stale = true;
    };
  }, []);

  const add = useCallback(() => {
    setIds((current) => {
      const id = nextTerminalId(current);
      setActive(id);
      return [...current, id];
    });
  }, []);

  const close = useCallback((terminalId: string) => {
    void bridge()?.closeTerminal(terminalId);
    setIds((current) => {
      const remaining = current.filter((id) => id !== terminalId);
      // A panel with no terminals has nothing to show and no way back, so the
      // last close opens a fresh one instead of emptying the mode.
      const next = remaining.length > 0 ? remaining : ["term-1"];
      setActive((currentActive) => {
        if (currentActive !== terminalId) return currentActive;
        const at = current.indexOf(terminalId);
        return next[Math.min(at, next.length - 1)]!;
      });
      return next;
    });
  }, []);

  // A tab whose shell has exited wears a hollow dot, the same way an edited
  // file wears the editor's filled one. The tab itself stays: an exited shell
  // leaves output worth reading, and the surface offers a way to start another.
  const [statuses, setStatuses] = useState<Record<string, "running" | "exited">>({});
  const onStatus = useCallback((terminalId: string, status: "running" | "exited") => {
    setStatuses((current) =>
      current[terminalId] === status ? current : { ...current, [terminalId]: status },
    );
  }, []);

  if (bridge() === undefined) {
    return (
      <main className="term-panel">
        <div className="term-empty">
          <p>Terminals need the desktop app.</p>
          <p className="dim">
            This renderer is running in a browser, which has no shell to attach to.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="term-panel">
      <div className="tabs" role="tablist" aria-label="Terminals">
        {ids.map((id) => (
          <div
            key={id}
            className={`tab${id === active ? " is-active" : ""}`}
            role="presentation"
          >
            <button
              type="button"
              className="tab-main"
              role="tab"
              aria-selected={id === active}
              title={statuses[id] === "exited" ? `${terminalLabel(id)} · exited` : undefined}
              onClick={() => setActive(id)}
            >
              <span
                className={`tab-dot${statuses[id] === "exited" ? " is-exited" : ""}`}
                aria-hidden="true"
              />
              {terminalLabel(id)}
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${terminalLabel(id)}`}
              onClick={() => close(id)}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className="term-add" aria-label="New terminal" onClick={add}>
          +
        </button>
      </div>
      <div className="term-stack">
        {adopted &&
          ids.map((id) => (
            <TerminalSurface key={id} terminalId={id} visible={id === active} onStatus={onStatus} />
          ))}
      </div>
    </main>
  );
}

export default TerminalView;
