import type { Context } from "@daydream-code/kernel";
import { LIVE_STATUSES, SessionId } from "@daydream-code/shared";
import { schema } from "@daydream-code/store";
import { and, desc, eq, inArray, sql } from "@daydream-code/store/drizzle";
import type {} from "./index.js";
import type {} from "@daydream-code/journal";
import type {} from "@daydream-code/thread";
import type {} from "@daydream-code/store";

/**
 * Consumer plugin: the recall + inter-session communication tools every
 * session gets. Summaries on the master thread reference sessions by name;
 * these tools let the agent follow a summary into the full journal in one hop,
 * and post to the master thread (the message bus) for siblings.
 *
 * Every `session_id` argument accepts an id or a name, since the master-thread
 * prose the model is reading from uses names. Resolution reads the sessions
 * table directly rather than through `ctx.sessions`: the session package
 * depends on this one, so the reverse dependency would be a build cycle.
 */
const recallTools = {
  name: "recall-tools",
  inject: ["tools", "journal", "threads", "store"],
  apply(ctx: Context) {
    /** Accept either a `ses_…` id or a human-readable name; ids win ties. */
    const resolveSession = (idOrName: string): SessionId => {
      const row = ctx.store.db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.projectId, ctx.store.project.id),
            eq(schema.sessions.name, idOrName),
          ),
        )
        .get();
      return SessionId(row?.id ?? idOrName);
    };

    /** Display name for an id, for prose that lands on the master thread. */
    const nameOf = (id: SessionId): string => {
      const row = ctx.store.db
        .select({ name: schema.sessions.name })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, id))
        .get();
      return row?.name ?? id;
    };

    /**
     * The id of the caller's most recent journal event, read when the tool
     * starts executing.
     *
     * A tool call is journaled with its full arguments *before* the tool runs
     * (the driver emits `tool_call` off the SDK stream), so the query string
     * is inside the corpus being searched. Without this cutoff a session that
     * searches for a term it just typed matches its own call, and every
     * earlier search it made for the same term — the hits look like findings
     * and are just an echo.
     *
     * Read per-session rather than from `journal.maxId()`: ids are a global
     * autoincrement, so a sibling appending between the call and this line
     * would push the global max past our own row and let it back in.
     *
     * If the `tool_call` row has not landed yet — the driver's stream and the
     * SDK's tool dispatch are not ordered from our side — the cutoff lands one
     * event early and also drops the assistant text that led here. That is the
     * safe direction to be wrong, and it is one adjacent event.
     */
    const selfCutoff = (sessionId: SessionId): number | undefined =>
      ctx.journal.read({ sessionId, limit: 1, latest: true })[0]?.id;

    ctx.tools.register(ctx, {
      name: "search_journal",
      description:
        "Search all session journals (every tool call, turn, and result ever recorded in this project). Returns snippets with session ids; use read_session for the full context around a hit.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to search for" },
          session_id: {
            type: "string",
            description: "Restrict to one session (id or name)",
          },
          limit: { type: "number", description: "Max hits (default 20)" },
        },
        required: ["query"],
      },
      async execute(
        args: { query: string; session_id?: string; limit?: number },
        run,
      ) {
        const cutoff = selfCutoff(run.sessionId);
        return ctx.journal.search(args.query, {
          ...(args.session_id
            ? { sessionId: resolveSession(args.session_id) }
            : {}),
          ...(cutoff !== undefined
            ? { excludeTail: { sessionId: run.sessionId, fromId: cutoff } }
            : {}),
          limit: args.limit ?? 20,
        });
      },
    });

    ctx.tools.register(ctx, {
      name: "read_session",
      description:
        "Replay a past session's journal (turns, tool calls, results) oldest first, by session id or name. Paginate with after_id.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          after_id: {
            type: "number",
            description: "Return events with id greater than this",
          },
          limit: { type: "number", description: "Max events (default 50)" },
        },
        required: ["session_id"],
      },
      async execute(
        args: { session_id: string; after_id?: number; limit?: number },
        run,
      ) {
        const sessionId = resolveSession(args.session_id);
        // Same echo as search: replaying your own transcript would end on the
        // call doing the replaying.
        const cutoff =
          sessionId === run.sessionId ? selfCutoff(run.sessionId) : undefined;
        return ctx.journal.read({
          sessionId,
          ...(args.after_id !== undefined ? { afterId: args.after_id } : {}),
          ...(cutoff !== undefined ? { beforeId: cutoff } : {}),
          limit: args.limit ?? 50,
        });
      },
    });

    ctx.tools.register(ctx, {
      name: "read_master_thread",
      description:
        "Read the project's master thread history — including entries compacted out of the live context. Newest last. Paginate with before_seq.",
      parameters: {
        type: "object",
        properties: {
          before_seq: {
            type: "number",
            description: "Return entries with seq below this",
          },
          limit: { type: "number", description: "Max entries (default 50)" },
        },
        required: [],
      },
      async execute(args: { before_seq?: number; limit?: number }) {
        const master = ctx.threads.ensureMaster();
        const limit = args.limit ?? 50;
        const toSeq =
          args.before_seq !== undefined
            ? args.before_seq - 1
            : ctx.threads.maxSeq(master.id);
        const fromSeq = Math.max(1, toSeq - limit + 1);
        return ctx.threads
          .entries(master.id, { fromSeq, toSeq })
          .map((entry) => ({
            seq: entry.seq,
            kind: entry.kind,
            sessionId: entry.sessionId ?? null,
            message: entry.message,
            createdAt: entry.createdAt,
          }));
      },
    });

    ctx.tools.register(ctx, {
      name: "session_event_read",
      description:
        "Read the journal events immediately around one event — the context on either side of a search_journal hit, without replaying the whole session. Pass the `eventId` a hit came back with.",
      parameters: {
        type: "object",
        properties: {
          event_id: {
            type: "number",
            description: "The `eventId` from a search_journal hit.",
          },
          before: {
            type: "number",
            description: "Events to include before it (default 5, max 50)",
          },
          after: {
            type: "number",
            description: "Events to include after it (default 5, max 50)",
          },
        },
        required: ["event_id"],
      },
      async execute(
        args: { event_id: number; before?: number; after?: number },
        run,
      ) {
        const window = (value: number | undefined): number => {
          if (typeof value !== "number" || !Number.isFinite(value)) return 5;
          return Math.max(0, Math.min(50, Math.trunc(value)));
        };
        // Ids are global, so the event identifies its own session — the caller
        // does not have to carry one back from the hit.
        const focus = ctx.journal.read({
          afterId: args.event_id - 1,
          limit: 1,
        })[0];
        if (!focus || focus.id !== args.event_id) {
          return {
            status: "not-found",
            detail: `no journal event with id ${args.event_id}`,
            guidance:
              "Use the `eventId` from a search_journal hit verbatim. These are journal ids, not per-session step numbers.",
          };
        }
        const sessionId = focus.sessionId;
        const cutoff =
          sessionId === run.sessionId ? selfCutoff(run.sessionId) : undefined;
        // `latest` pages from the end and hands the page back ascending, so
        // the two halves concatenate around the focus in order.
        const before = ctx.journal.read({
          sessionId,
          beforeId: focus.id,
          limit: window(args.before),
          latest: true,
        });
        const after = ctx.journal.read({
          sessionId,
          afterId: focus.id,
          limit: window(args.after),
          ...(cutoff !== undefined ? { beforeId: cutoff } : {}),
        });
        return {
          session: nameOf(sessionId),
          sessionId,
          focusEventId: focus.id,
          events: [...before, focus, ...after],
        };
      },
    });

    ctx.tools.register(ctx, {
      name: "list_sessions",
      description:
        "List this project's sessions, most recently active first: the name you address one by, its status, what it is currently working on, and its last one-line summary. Check this before posting to the master thread or asking a sibling — it is the only way to see who is actually live.",
      parameters: {
        type: "object",
        properties: {
          live_only: {
            type: "boolean",
            description:
              "Only sessions still running or waiting (default false).",
          },
          limit: {
            type: "number",
            description: "Max sessions (default 20, max 100)",
          },
        },
        required: [],
      },
      async execute(args: { live_only?: boolean; limit?: number }, run) {
        const limit = Math.max(
          1,
          Math.min(100, Math.trunc(args?.limit ?? 20) || 20),
        );
        // Filtered in SQL, not after: `live_only` on a project with twenty
        // finished sessions would otherwise limit to twenty rows and then
        // throw all of them away.
        const where =
          args?.live_only === true
            ? and(
                eq(schema.sessions.projectId, ctx.store.project.id),
                inArray(schema.sessions.status, [...LIVE_STATUSES]),
              )
            : eq(schema.sessions.projectId, ctx.store.project.id);
        const rows = ctx.store.db
          .select({
            id: schema.sessions.id,
            name: schema.sessions.name,
            title: schema.sessions.title,
            status: schema.sessions.status,
            startedAt: schema.sessions.startedAt,
            endedAt: schema.sessions.endedAt,
            tldr: schema.sessions.tldr,
          })
          .from(schema.sessions)
          .where(where)
          // The project's recency convention: last finish, falling back to
          // start while a session is still going.
          .orderBy(
            desc(
              sql`coalesce(${schema.sessions.endedAt}, ${schema.sessions.startedAt})`,
            ),
          )
          .limit(limit)
          .all();
        return rows.map((row) => ({
          name: row.name,
          status: row.status,
          live: LIVE_STATUSES.includes(row.status as never),
          title: row.title,
          tldr: row.tldr,
          activityAt: row.endedAt ?? row.startedAt,
          ...(row.id === run.sessionId ? { self: true } : {}),
        }));
      },
    });

    ctx.tools.register(ctx, {
      name: "post_to_master",
      description:
        "Post a message to the project's master thread. Untargeted posts are broadcast notes every session sees at its next turn; pass to_session to address one running session. Use this to coordinate with sibling sessions (advisory, not locking).",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          to_session: {
            type: "string",
            description: "Session id or name to address (omit to broadcast)",
          },
        },
        required: ["text"],
      },
      async execute(args: { text: string; to_session?: string }, run) {
        const master = ctx.threads.ensureMaster();
        const entry = ctx.threads.append({
          threadId: master.id,
          kind: "session_message",
          sessionId: run.sessionId,
          toSessionId: args.to_session ? resolveSession(args.to_session) : null,
          message: {
            role: "user",
            content: `message from session ${nameOf(run.sessionId)}${
              args.to_session
                ? ` to session ${nameOf(resolveSession(args.to_session))}`
                : " (broadcast)"
            }: ${args.text}`,
          },
        });
        return { posted: true, seq: entry.seq };
      },
    });
  },
};

export default recallTools;
