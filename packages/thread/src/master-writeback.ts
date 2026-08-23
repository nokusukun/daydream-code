import type { Context } from "@daydream-code/kernel";
import type { SessionRecord } from "@daydream-code/shared";

/**
 * Consumer plugin: translates session lifecycle events into master-thread
 * entries, so the master thread reflects in-flight work as it happens —
 * dispatches, per-turn summaries, final summaries. Any fork taken mid-flight
 * sees what sibling sessions are doing.
 */
const masterWriteback = {
  name: "master-writeback",
  inject: ["threads"],
  apply(ctx: Context) {
    const master = () => ctx.threads.ensureMaster().id;

    ctx.on(
      "session/dispatched",
      (session: SessionRecord, kind: "new" | "continue", message: string) => {
        const verb = kind === "new" ? "new session" : "continue session";
        ctx.threads.append({
          threadId: master(),
          kind: "session_dispatch",
          sessionId: session.id,
          message: {
            role: "user",
            content: `${verb} ${session.id} with msg: ${JSON.stringify(message)}`,
          },
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
          content: `session ${session.id} turn end, summary: ${summary}`,
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
            `session ${session.id} ended (${session.status}).\n` +
            `task: ${session.task}\n` +
            `summary:\n${session.summary ?? "(none)"}`,
        },
      });
    });
  },
};

export default masterWriteback;
