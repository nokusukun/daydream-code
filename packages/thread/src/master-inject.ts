import { eq } from "@daydream-code/store/drizzle";
import type { Context } from "@daydream-code/kernel";
import { schema } from "@daydream-code/store";
import type { SessionRecord, ThreadEntry } from "@daydream-code/shared";
import type {} from "./index.js";

/** Max entries delivered per turn; older backlog is pointed at, not inlined. */
const MAX_ENTRIES = 50;

function entryLine(entry: ThreadEntry): string {
  const text =
    typeof entry.message.content === "string"
      ? entry.message.content
      : JSON.stringify(entry.message.content);
  return `- ${text}`;
}

/**
 * Consumer plugin: live sibling awareness. At every turn boundary the runner
 * emits session/collect-injections; this plugin contributes a
 * `[master thread update]` block with everything on master past the session's
 * lastSeenMasterSeq cursor, then advances the cursor. Own entries and
 * session_messages addressed to other sessions are filtered out.
 */
const masterInject = {
  name: "master-inject",
  inject: ["threads", "store"],
  apply(ctx: Context) {
    ctx.on(
      "session/collect-injections",
      (session: SessionRecord, blocks: string[]) => {
        const master = ctx.threads.ensureMaster();
        const maxSeq = ctx.threads.maxSeq(master.id);
        if (maxSeq <= session.lastSeenMasterSeq) return;

        const fresh = ctx.threads
          .entries(master.id, { fromSeq: session.lastSeenMasterSeq + 1 })
          .filter((entry) => {
            if (entry.sessionId === session.id) return false; // it already knows
            if (entry.kind === "session_message") {
              return entry.toSessionId == null || entry.toSessionId === session.id;
            }
            return entry.kind !== "compaction";
          });

        // Advance the cursor even if everything filtered out.
        ctx.store.db
          .update(schema.sessions)
          .set({ lastSeenMasterSeq: maxSeq })
          .where(eq(schema.sessions.id, session.id))
          .run();
        session.lastSeenMasterSeq = maxSeq;

        if (fresh.length === 0) return;
        const shown = fresh.slice(-MAX_ENTRIES);
        const dropped = fresh.length - shown.length;
        const lines = shown.map(entryLine);
        if (dropped > 0) {
          lines.unshift(
            `- (${dropped} older entries omitted; use read_master_thread to see them)`,
          );
        }
        blocks.push(`[master thread update]\n${lines.join("\n")}`);
      },
    );
  },
};

export default masterInject;
