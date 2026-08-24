import type { Context } from "@daydream-code/kernel";
import type { SessionRecord } from "@daydream-code/shared";

/**
 * Consumer plugin: translates session lifecycle events into master-thread
 * entries, so the master thread reflects in-flight work as it happens —
 * dispatches, per-turn summaries, final summaries. Any fork taken mid-flight
 * sees what sibling sessions are doing.
 *
 * Entries name sessions by their human-readable `name`, not their id — this
 * prose is read by models and humans alike, and `resolve` accepts either.
 */
const masterWriteback = {
  name: "master-writeback",
  inject: ["threads"],
  apply(ctx: Context) {
    const master = () => ctx.threads.ensureMaster().id;

    ctx.on(
      "session/dispatched",
      (
        session: SessionRecord,
        kind: "new" | "continue" | "ask" | "message",
        message: string,
      ) => {
        // A delivered question is recorded as the fact that it happened. The
        // question itself already reached the one session it was addressed to,
        // and its text is mechanical — reprinting it here would spend every
        // sibling's context on boilerplate written for somebody else.
        // Sibling-authored text is recorded as the fact that it arrived. It
        // was addressed to one session, so reprinting it here would spend
        // every *other* sibling's context on a message written for somebody
        // else — the same reason a delivered question is not reprinted.
        const content =
          kind === "ask"
            ? `session ${session.name} was asked a question by a sibling`
            : kind === "message"
              ? `session ${session.name} received a message from a sibling`
              : message.trim().length === 0
                ? // The only thing that sends a message with no text is one
                  // carrying an attachment — every composer and every route
                  // requires either words or an image — so `msg: ""` here
                  // would read as a bug rather than as what happened.
                  `${kind === "new" ? "new session" : "continue session"} ${
                    session.name
                  } with an attachment and no message`
                : `${kind === "new" ? "new session" : "continue session"} ${
                    session.name
                  } with msg: ${JSON.stringify(message)}`;
        ctx.threads.append({
          threadId: master(),
          kind: "session_dispatch",
          sessionId: session.id,
          message: { role: "user", content },
        });
      },
    );

    ctx.on("session/turn-ended", (session: SessionRecord, summary: string) => {
      ctx.threads.append({
        threadId: master(),
        kind: "session_turn_end",
        sessionId: session.id,
        message: {
          role: "user",
          content: `session ${session.name} turn end, summary: ${summary}`,
        },
      });
    });

    ctx.on("session/ended", (session: SessionRecord) => {
      ctx.threads.append({
        threadId: master(),
        kind: "session_summary",
        sessionId: session.id,
        message: {
          role: "user",
          content:
            `session ${session.name} ended (${session.status}).\n` +
            `task: ${session.task}\n` +
            `summary:\n${session.summary ?? "(none)"}`,
        },
      });
    });
  },
};

export default masterWriteback;
