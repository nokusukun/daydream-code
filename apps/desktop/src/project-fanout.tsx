/**
 * The toolbar's data, owned above the project it reports on.
 *
 * `App` keys `HarnessProvider` by connection, so switching projects unmounts
 * that whole subtree — correct for a workspace whose selection, drafts and
 * paths all belong to one project, and wrong for the toolbar, which is window
 * chrome that must keep answering "what is running?" across the switch. State
 * living inside the keyed subtree is discarded at exactly the moment the
 * question gets interesting: every retained core's stream closes, every
 * snapshot is thrown away, and the bar reports `idle` about projects it has
 * simply forgotten. So the fan-out is mounted *outside* the key and takes the
 * current connection as a prop instead of reading it from the harness.
 *
 * Its sockets therefore outlive the switch. The list of cores does not change
 * when you move between two projects that are already open, so nothing is
 * refetched and nothing blanks.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SessionRecord } from "@daydream-code/shared";
import { ApiClient } from "./api.js";
import { bridge, type ConnectionInfo } from "./bridge.js";
import {
  connectionKey,
  replaceProjectSessions,
  uniqueConnections,
  type ProjectFanout,
} from "./project-activity.js";
import { connectStream } from "./stream.js";

const FanoutContext = createContext<ProjectFanout | null>(null);

/**
 * Every retained core, and every run they know about.
 *
 * Mount this above `HarnessProvider` — above the `key` — or it will be torn
 * down by the switch it exists to survive.
 */
export function ProjectFanoutProvider(props: {
  connection: ConnectionInfo;
  children: ReactNode;
}): ReactNode {
  const value = useFanoutState(props.connection);
  return (
    <FanoutContext.Provider value={value}>
      {props.children}
    </FanoutContext.Provider>
  );
}

/** The fan-out, from the nearest provider. */
export function useProjectActivities(): ProjectFanout {
  const value = useContext(FanoutContext);
  if (value === null) {
    throw new Error("useProjectActivities outside <ProjectFanoutProvider>");
  }
  return value;
}

/**
 * Keep one lightweight stream per retained core. HTTP provides the snapshot;
 * session frames patch it live. A frame observed while a snapshot request is
 * in flight wins over that response, so a late fetch cannot regress a run from
 * completed back to running.
 */
function useFanoutState(current: ConnectionInfo): ProjectFanout {
  const [connections, setConnections] = useState<ConnectionInfo[]>([current]);
  const [sessionsByProject, setSessionsByProject] = useState(
    () => new Map<string, SessionRecord[]>(),
  );
  // Which projects have actually answered. Absent from this set means "not
  // asked yet", which is a different fact from "asked, and nothing is running"
  // — and only the second one may be drawn as idle.
  const [known, setKnown] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const b = bridge();
    if (b === undefined || typeof b.getProjectCores !== "function") {
      setConnections([current]);
      return;
    }

    let stale = false;
    const update = (next: readonly ConnectionInfo[]): void => {
      if (stale) return;
      // The supervisor's order, with the current project appended only if its
      // core has not been announced yet. Putting the current project first
      // instead would reorder this list on every switch — a new array, a new
      // effect run, and every stream closed and reopened for a change that is
      // presentational. `projectProgress` decides display order downstream.
      const all = uniqueConnections([...next, current]);
      setConnections((before) => {
        const a = before.map(connectionKey).join("\n");
        const b = all.map(connectionKey).join("\n");
        return a === b ? before : all;
      });
    };

    void b.getProjectCores().then(update).catch(() => update([current]));
    const unsubscribe = b.onProjectCores(update);
    return () => {
      stale = true;
      unsubscribe();
    };
  }, [current]);

  useEffect(() => {
    let disposed = false;
    const roots = new Set(connections.map((connection) => connection.rootPath));
    setSessionsByProject((before) => {
      const next = new Map(
        [...before].filter(([rootPath]) => roots.has(rootPath)),
      );
      return next.size === before.size ? before : next;
    });
    setKnown((before) => {
      const next = new Set([...before].filter((rootPath) => roots.has(rootPath)));
      return next.size === before.size ? before : next;
    });

    const disconnect = connections.map((connection) => {
      const api = new ApiClient({
        baseUrl: connection.url,
        token: connection.token,
      });
      let request = 0;
      let eventVersion = 0;
      const observed = new Map<
        string,
        { version: number; session: SessionRecord }
      >();

      const markKnown = (): void => {
        setKnown((before) =>
          before.has(connection.rootPath)
            ? before
            : new Set([...before, connection.rootPath]),
        );
      };

      const commit = (sessions: Iterable<SessionRecord>): void => {
        if (disposed) return;
        setSessionsByProject(
          replaceProjectSessions(connection.rootPath, sessions),
        );
        markKnown();
      };

      const load = (): void => {
        const thisRequest = ++request;
        const baseline = eventVersion;
        void api
          .sessions()
          .then((list) => {
            if (disposed || thisRequest !== request) return;
            const merged = new Map(
              list.map((session) => [String(session.id), session]),
            );
            for (const [id, event] of observed) {
              if (event.version > baseline) merged.set(id, event.session);
            }
            commit(merged.values());
          })
          .catch(() => undefined);
      };

      load();
      return connectStream(api.streamUrl(), {
        onFrame: (frame) => {
          if (frame.kind === "hello") {
            load();
            return;
          }
          if (frame.kind !== "session") return;
          eventVersion += 1;
          observed.set(String(frame.session.id), {
            version: eventVersion,
            session: frame.session,
          });
          const arrived = frame.session;
          setSessionsByProject((before) => {
            const currentSessions = before.get(connection.rootPath) ?? [];
            const nextSessions = [...currentSessions];
            const at = nextSessions.findIndex(
              (session) => session.id === arrived.id,
            );
            if (at === -1) nextSessions.unshift(arrived);
            else nextSessions[at] = arrived;
            const next = new Map(before);
            next.set(connection.rootPath, nextSessions);
            return next;
          });
          markKnown();
        },
      });
    });

    return () => {
      disposed = true;
      for (const close of disconnect) close();
    };
  }, [connections]);

  return useMemo(
    () => ({
      connections,
      known,
      activities: connections.flatMap((connection) =>
        (sessionsByProject.get(connection.rootPath) ?? []).map((session) => ({
          connection,
          session,
        })),
      ),
    }),
    [connections, known, sessionsByProject],
  );
}
