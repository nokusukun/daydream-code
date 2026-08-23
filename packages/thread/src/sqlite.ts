import type { Context } from "@daydream-code/kernel";
import {
  ProjectId,
  SessionId,
  ThreadId,
  newId,
  nowIso,
  type ModelMessage,
  type Thread,
  type ThreadEntry,
  type ThreadEntryInput,
} from "@daydream-code/shared";
import { schema } from "@daydream-code/store";
import {
  and,
  asc,
  eq,
  gte,
  lte,
  sql,
  type SQL,
} from "@daydream-code/store/drizzle";
import type { Normalizer } from "@daydream-code/normalize";
import "@daydream-code/tokens";
import { Threads, type EntryRange } from "./index.js";

const threads = schema.threads;
const entries = schema.threadEntries;

type ThreadRow = typeof threads.$inferSelect;
type EntryRow = typeof entries.$inferSelect;

/**
 * Default threads provider on the project store. Threads are append-only;
 * compaction folds copy-on-write via `supersedesThroughSeq`, and forks
 * reference the parent snapshot by seq — nothing is ever deleted.
 */
export default class ThreadsSqlite extends Threads {
  static inject = ["store", "tokens"];

  constructor(ctx: Context) {
    super(ctx);
  }

  get #db() {
    return this.ctx.store.db;
  }

  ensureMaster(): Thread {
    const projectId = this.ctx.store.project.id;
    const existing = this.#db
      .select()
      .from(threads)
      .where(and(eq(threads.projectId, projectId), eq(threads.kind, "master")))
      .get();
    if (existing) return this.#toThread(existing);
    return this.#createThread({
      id: newId("thr"),
      projectId,
      kind: "master",
      forkedFromThread: null,
      forkedAtSeq: null,
    });
  }

  fork(from: ThreadId, atSeq?: number): Thread {
    const parent = this.get(from);
    if (!parent) throw new Error(`cannot fork unknown thread "${from}"`);
    return this.#createThread({
      id: newId("thr"),
      projectId: parent.projectId,
      kind: "session",
      forkedFromThread: from,
      forkedAtSeq: atSeq ?? this.maxSeq(from),
    });
  }

  get(id: ThreadId): Thread | undefined {
    const row = this.#db.select().from(threads).where(eq(threads.id, id)).get();
    return row ? this.#toThread(row) : undefined;
  }

  append(input: ThreadEntryInput): ThreadEntry {
    const normalizer = this.ctx.get<Normalizer>("normalizer");
    const message = normalizer?.forPersist(input.message) ?? input.message;
    const tokenEstimate =
      input.tokenEstimate ?? this.ctx.tokens.estimateMessage(message);
    const insert = this.ctx.store.sqlite.transaction((): EntryRow => {
      const seqRow = this.#db
        .select({ next: sql<number>`coalesce(max(${entries.seq}), 0) + 1` })
        .from(entries)
        .where(eq(entries.threadId, input.threadId))
        .get();
      return this.#db
        .insert(entries)
        .values({
          threadId: input.threadId,
          seq: seqRow?.next ?? 1,
          kind: input.kind,
          sessionId: input.sessionId ?? null,
          toSessionId: input.toSessionId ?? null,
          supersedesThroughSeq: input.supersedesThroughSeq ?? null,
          messageJson: JSON.stringify(message),
          tokenEstimate,
          createdAt: nowIso(),
        })
        .returning()
        .get();
    });
    const entry = this.#toEntry(insert());
    this.ctx.emit("thread/append", entry);
    return entry;
  }

  entries(id: ThreadId, range: EntryRange = {}): ThreadEntry[] {
    const conditions: SQL[] = [eq(entries.threadId, id)];
    if (range.fromSeq !== undefined) conditions.push(gte(entries.seq, range.fromSeq));
    if (range.toSeq !== undefined) conditions.push(lte(entries.seq, range.toSeq));
    const query = this.#db
      .select()
      .from(entries)
      .where(and(...conditions))
      .orderBy(asc(entries.seq));
    const rows =
      range.limit !== undefined ? query.limit(range.limit).all() : query.all();
    return rows.map((row) => this.#toEntry(row));
  }

  maxSeq(id: ThreadId): number {
    const row = this.#db
      .select({ max: sql<number>`coalesce(max(${entries.seq}), 0)` })
      .from(entries)
      .where(eq(entries.threadId, id))
      .get();
    return row?.max ?? 0;
  }

  liveContext(id: ThreadId): ThreadEntry[] {
    const folded = this.#contextUpTo(id, undefined);
    const normalizer = this.ctx.get<Normalizer>("normalizer");
    if (!normalizer) return folded;
    return folded.map((entry) => ({
      ...entry,
      message: normalizer.forLoad(entry.message),
    }));
  }

  /**
   * Folded context of one thread restricted to seq <= rangeEnd, with the fork
   * chain resolved recursively: the parent contributes its own folded context
   * up to the fork point first.
   */
  #contextUpTo(id: ThreadId, rangeEnd: number | undefined): ThreadEntry[] {
    const thread = this.get(id);
    if (!thread) throw new Error(`unknown thread "${id}"`);
    const inherited =
      thread.forkedFromThread !== null
        ? this.#contextUpTo(
            thread.forkedFromThread,
            thread.forkedAtSeq ?? this.maxSeq(thread.forkedFromThread),
          )
        : [];
    const own = this.entries(id, rangeEnd !== undefined ? { toSeq: rangeEnd } : {});
    return [...inherited, ...this.#fold(own, rangeEnd)];
  }

  /**
   * Fold compaction within one thread's entry range (entries sorted asc):
   * the newest compaction entry whose cut fits the range replaces everything
   * it supersedes; entries past the cut follow in seq order.
   */
  #fold(range: ThreadEntry[], rangeEnd: number | undefined): ThreadEntry[] {
    let cut: ThreadEntry | undefined;
    for (const entry of range) {
      if (entry.kind !== "compaction") continue;
      const through = entry.supersedesThroughSeq ?? 0;
      if (rangeEnd !== undefined && through > rangeEnd) continue;
      if (cut === undefined || entry.seq > cut.seq) cut = entry;
    }
    if (cut === undefined) {
      return range.filter((entry) => entry.kind !== "compaction");
    }
    const through = cut.supersedesThroughSeq ?? 0;
    return [
      cut,
      ...range.filter(
        (entry) => entry.kind !== "compaction" && entry.seq > through,
      ),
    ];
  }

  #createThread(row: {
    id: string;
    projectId: ProjectId;
    kind: "master" | "session";
    forkedFromThread: ThreadId | null;
    forkedAtSeq: number | null;
  }): Thread {
    const values = { ...row, createdAt: nowIso() };
    this.#db.insert(threads).values(values).run();
    return this.#toThread(values);
  }

  #toThread(row: ThreadRow): Thread {
    return {
      id: ThreadId(row.id),
      projectId: ProjectId(row.projectId),
      kind: row.kind,
      forkedFromThread:
        row.forkedFromThread !== null ? ThreadId(row.forkedFromThread) : null,
      forkedAtSeq: row.forkedAtSeq,
      createdAt: row.createdAt,
    };
  }

  #toEntry(row: EntryRow): ThreadEntry {
    return {
      id: row.id,
      threadId: ThreadId(row.threadId),
      seq: row.seq,
      kind: row.kind,
      message: JSON.parse(row.messageJson) as ModelMessage,
      tokenEstimate: row.tokenEstimate,
      createdAt: row.createdAt,
      ...(row.sessionId !== null ? { sessionId: SessionId(row.sessionId) } : {}),
      ...(row.toSessionId !== null
        ? { toSessionId: SessionId(row.toSessionId) }
        : {}),
      ...(row.supersedesThroughSeq !== null
        ? { supersedesThroughSeq: row.supersedesThroughSeq }
        : {}),
    };
  }
}
