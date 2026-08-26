/**
 * One websocket to /stream with dumb reconnect. Frame shapes mirror the
 * server's StreamMessage wire protocol (declared locally so the renderer
 * depends only on the shared vocabulary, not the server package).
 */
import type { JournalEvent, SessionRecord, ThreadEntry } from "@daydream-code/shared";

export type StreamFrame =
  | { kind: "hello"; lastEventId: number }
  | { kind: "journal"; event: JournalEvent }
  | { kind: "thread"; entry: ThreadEntry }
  | { kind: "session"; session: SessionRecord }
  | { kind: "session-deleted"; id: string };

export type StreamStatus = "connecting" | "open" | "closed";

export interface StreamOptions {
  onFrame(frame: StreamFrame): void;
  onStatus?(status: StreamStatus): void;
  /** Reconnect backoff in ms (default 1500). */
  backoffMs?: number;
}

/** Connect (and keep reconnecting) to the stream; returns a disposer. */
export function connectStream(url: string, options: StreamOptions): () => void {
  const backoff = options.backoffMs ?? 1500;
  let disposed = false;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = (): void => {
    if (disposed) return;
    options.onStatus?.("connecting");
    socket = new WebSocket(url);
    socket.onopen = () => {
      if (!disposed) options.onStatus?.("open");
    };
    socket.onmessage = (event: MessageEvent) => {
      if (disposed || typeof event.data !== "string") return;
      try {
        options.onFrame(JSON.parse(event.data) as StreamFrame);
      } catch {
        // malformed frame; skip
      }
    };
    socket.onclose = () => {
      if (disposed) return;
      options.onStatus?.("closed");
      timer = setTimeout(open, backoff);
    };
    socket.onerror = () => {
      // onclose follows; reconnect handled there
    };
  };

  open();
  return () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    socket?.close();
  };
}
