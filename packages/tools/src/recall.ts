import type { Context } from "@daydream-code/kernel";
import { SessionId } from "@daydream-code/shared";
import type {} from "./index.js";
import type {} from "@daydream-code/journal";
import type {} from "@daydream-code/thread";

/**
 * Consumer plugin: the recall + inter-session communication tools every
 * session gets. Summaries on the master thread reference session ids; these
 * tools let the agent follow a summary into the full journal in one hop, and
 * post to the master thread (the message bus) for siblings.
 */
const recallTools = {
  name: "recall-tools",
  inject: ["tools", "journal", "threads"],
  apply(ctx: Context) {
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
            description: "Restrict to one session",
          },
          limit: { type: "number", description: "Max hits (default 20)" },
        },
        required: ["query"],
      },
      async execute(args: {
        query: string;
        session_id?: string;
        limit?: number;
      }) {
        return ctx.journal.search(args.query, {
          ...(args.session_id
            ? { sessionId: SessionId(args.session_id) }
            : {}),
          limit: args.limit ?? 20,
        });
      },
    });

    ctx.tools.register(ctx, {
      name: "read_session",
      description:
        "Replay a past session's journal (turns, tool calls, results) oldest first. Paginate with after_id.",
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
      async execute(args: {
        session_id: string;
        after_id?: number;
        limit?: number;
      }) {
        return ctx.journal.read({
          sessionId: SessionId(args.session_id),
          ...(args.after_id !== undefined ? { afterId: args.after_id } : {}),
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
      name: "post_to_master",
      description:
        "Post a message to the project's master thread. Untargeted posts are broadcast notes every session sees at its next turn; pass to_session to address one running session. Use this to coordinate with sibling sessions (advisory, not locking).",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          to_session: {
            type: "string",
            description: "Session id to address (omit to broadcast)",
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
          toSessionId: args.to_session ? SessionId(args.to_session) : null,
          message: {
            role: "user",
            content: `message from session ${run.sessionId}${
              args.to_session ? ` to session ${args.to_session}` : " (broadcast)"
            }: ${args.text}`,
          },
        });
        return { posted: true, seq: entry.seq };
      },
    });
  },
};

export default recallTools;
