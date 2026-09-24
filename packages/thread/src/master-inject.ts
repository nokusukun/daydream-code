import { eq, inArray } from "@daydream-code/store/drizzle";
import type { Context } from "@daydream-code/kernel";
import { schema } from "@daydream-code/store";
import type { SessionId, SessionRecord, ThreadEntry } from "@daydream-code/shared";
import type {} from "./index.js";

/** Max entries delivered per turn; older backlog is pointed at, not inlined. */
const MAX_ENTRIES = 50;

/**
 * Lifecycle entries whose prose ends in a session's summary.
 *
 * The master thread stores that text verbatim — it is the durable record, and
 * the desktop timeline, `read_master_thread` and `read_session` all serve it —
 * but siblings are told only that the turn ended. A summary is written for the
 * user at the end of a session's turn; pushing one into every live session's
 * next turn spends thousands of tokens on prose that session did not ask for,
 * and it arrives as an interruption rather than an answer. Anything that
 * genuinely needs to reach a sibling goes through `post_to_master`, which is
 * addressed on purpose and is NOT elided here.
 */
function elidesSummary(kind: ThreadEntry["kind"]): boolean {
  return kind === "session_turn_end" || kind === "session_summary";
}

/**
 * Whether handing `entry` to `reader` would only tell it about itself.
 *
 * Automatic entries — turn ends, run ends, dispatches, board notes — record
 * which sessions they echo. Without this, two live sessions ping-pong: A's
 * turn end wakes B, B's "nothing for me here" turn end wakes A, and so on, each
 * round spending a turn on the other's reaction to itself. A deliberate
 * message (`session_message`) never carries `causedBy`, so a real reply always
 * gets through.
 */
function echoes(entry: ThreadEntry, reader: SessionId): boolean {
  return entry.causedBy?.includes(reader) ?? false;
}

/**
 * The sessions an automatic entry reports on: its author and everything the
 * author was itself echoing. Transitive on purpose — a turn woken by B's
 * reaction to A is still, at bottom, a reaction to A, and stopping only the
 * direct echo would leave a three-session loop running. Every hop adds a
 * session, so any chain dies once it has been through each of them.
 */
function causesOf(entry: ThreadEntry): SessionId[] {
  if (entry.kind === "session_message") return [];
  return [
    ...(entry.sessionId !== undefined ? [entry.sessionId] : []),
    ...(entry.causedBy ?? []),
  ];
}

type SessionLabel = { name: string; status: string };

/** Names/statuses for the elided entries, read live rather than from prose. */
function labelsFor(
  ctx: Context,
  entries: ThreadEntry[],
): Map<string, SessionLabel> {
  const ids = [
    ...new Set(
      entries
        .filter((e) => elidesSummary(e.kind) && e.sessionId != null)
        .map((e) => e.sessionId as string),
    ),
  ];
  const labels = new Map<string, SessionLabel>();
  if (ids.length === 0) return labels;
  const rows = ctx.store.db
    .select({
      id: schema.sessions.id,
      name: schema.sessions.name,
      status: schema.sessions.status,
    })
    .from(schema.sessions)
    .where(inArray(schema.sessions.id, ids))
    .all();
  for (const row of rows) {
    labels.set(row.id, { name: row.name, status: row.status });
  }
  return labels;
}

/**
 * The fact of the turn, never its text. The fallback is the raw id rather than
 * the entry's own prose: falling back to prose would make "no summary crosses
 * this seam" conditional on a row still existing, and a conditional guarantee
 * is not one.
 */
function lifecycleLine(entry: ThreadEntry, label?: SessionLabel): string {
  const who = label?.name ?? entry.sessionId ?? "unknown";
  if (entry.kind === "session_summary") {
    return `- session ${who} ended (${label?.status ?? "ended"})`;
  }
  return `- session ${who} turn end`;
}

function entryLine(entry: ThreadEntry, labels: Map<string, SessionLabel>): string {
  if (elidesSummary(entry.kind)) {
    return lifecycleLine(
      entry,
      entry.sessionId != null ? labels.get(entry.sessionId) : undefined,
    );
  }
  const content = entry.message.content;
  if (typeof content === "string") return `- ${content}`;
  // This text is injected verbatim into a sibling's prompt, so parts get a
  // readable rendering rather than raw JSON.
  const text = content
    .map((part) => {
      switch (part.type) {
        case "text":
        case "marker":
          return part.text;
        case "image":
          return `[image${part.alt ? ` ${part.alt}` : ""}]`;
        case "tool_call":
          return `[tool_call ${part.toolName}]`;
        case "tool_result":
          return `[tool_result ${part.toolName}]`;
      }
    })
    .join(" ");
  return `- ${text}`;
}

/**
 * Consumer plugin: live sibling awareness. At every turn boundary the runner
 * emits session/collect-injections; this plugin contributes a
 * `[master thread update]` block with everything on master past the session's
 * lastSeenMasterSeq cursor, then advances the cursor. Own entries, entries
 * that only echo this session back to itself, and session_messages addressed
 * to other sessions are filtered out, and turn-end and session-end entries are
 * reduced to the fact that they happened.
 */
const masterInject = {
  name: "master-inject",
  inject: ["threads", "store"],
  apply(ctx: Context) {
    ctx.on(
      "session/collect-injections",
      (session: SessionRecord, blocks: string[], causes?: Set<SessionId>) => {
        const master = ctx.threads.ensureMaster();
        const maxSeq = ctx.threads.maxSeq(master.id);
        if (maxSeq <= session.lastSeenMasterSeq) return;

        const fresh = ctx.threads
          .entries(master.id, { fromSeq: session.lastSeenMasterSeq + 1 })
          .filter((entry) => {
            if (entry.sessionId === session.id) return false; // it already knows
            if (echoes(entry, session.id)) return false;
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
        for (const entry of fresh) {
          for (const cause of causesOf(entry)) causes?.add(cause);
        }
        const shown = fresh.slice(-MAX_ENTRIES);
        const dropped = fresh.length - shown.length;
        const labels = labelsFor(ctx, shown);
        const lines = shown.map((entry) => entryLine(entry, labels));
        if (dropped > 0) {
          lines.unshift(
            `- (${dropped} older entries omitted; use read_master_thread to see them)`,
          );
        }
        if (shown.some((entry) => elidesSummary(entry.kind))) {
          lines.push(
            "- (summaries are not broadcast; use read_session <name> to read one)",
          );
        }
        blocks.push(`[master thread update]\n${lines.join("\n")}`);
      },
    );
  },
};

export default masterInject;
