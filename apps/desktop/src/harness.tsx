/**
 * Renderer-side glue: one ApiClient + one websocket per open project, a tiny
 * pub/sub for stream frames, and hash-free view routing. Deliberately no
 * state library — React context + hooks only.
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
import { ApiClient } from "./api.js";
import { connectStream, type StreamFrame, type StreamStatus } from "./stream.js";
import type { ConnectionInfo } from "./bridge.js";

export type View =
  | { name: "home" }
  | { name: "session"; id: string }
  | { name: "search" }
  | { name: "fibers" };

export interface Harness {
  api: ApiClient;
  connection: ConnectionInfo;
  /** Subscribe to raw stream frames; returns an unsubscriber. */
  subscribe(listener: (frame: StreamFrame) => void): () => void;
  /** Bumps on every `hello` frame — views refetch their lists on change. */
  resyncTick: number;
  wsStatus: StreamStatus;
  view: View;
  navigate(view: View): void;
}

const HarnessContext = createContext<Harness | null>(null);

export function useHarness(): Harness {
  const harness = useContext(HarnessContext);
  if (harness === null) throw new Error("useHarness outside <HarnessProvider>");
  return harness;
}

export function HarnessProvider(props: {
  connection: ConnectionInfo;
  children: ReactNode;
}): ReactNode {
  const { connection } = props;
  const api = useMemo(
    () => new ApiClient({ baseUrl: connection.url, token: connection.token }),
    [connection.url, connection.token],
  );

  const listeners = useRef(new Set<(frame: StreamFrame) => void>());
  const [resyncTick, setResyncTick] = useState(0);
  const [wsStatus, setWsStatus] = useState<StreamStatus>("connecting");
  const [view, setView] = useState<View>({ name: "home" });

  useEffect(() => {
    setView({ name: "home" });
    return connectStream(api.streamUrl(), {
      onFrame: (frame) => {
        if (frame.kind === "hello") setResyncTick((tick) => tick + 1);
        for (const listener of listeners.current) listener(frame);
      },
      onStatus: setWsStatus,
    });
  }, [api]);

  const subscribe = useCallback((listener: (frame: StreamFrame) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const navigate = useCallback((next: View) => setView(next), []);

  const harness = useMemo<Harness>(
    () => ({ api, connection, subscribe, resyncTick, wsStatus, view, navigate }),
    [api, connection, subscribe, resyncTick, wsStatus, view, navigate],
  );

  return (
    <HarnessContext.Provider value={harness}>
      {props.children}
    </HarnessContext.Provider>
  );
}
