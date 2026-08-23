import { Threads, type EntryRange } from "@daydream-code/thread";
import {
  ProjectId,
  ThreadId,
  nowIso,
  type Thread,
  type ThreadEntry,
  type ThreadEntryInput,
} from "@daydream-code/shared";

/**
 * In-memory Threads provider for tests. Append-only, per-thread seq,
 * liveContext folds compaction exactly per the seam doc comment: the newest
 * compaction entry whose supersedesThroughSeq applies replaces everything
 * with seq <= that value; raw entries() never loses anything.
 */
export class FakeThreads extends Threads {
  #threads = new Map<ThreadId, Thread>();
  #entries = new Map<ThreadId, ThreadEntry[]>();
  #nextId = 1;
  #nextThread = 1;

  ensureMaster(): Thread {
    for (const thread of this.#threads.values()) {
      if (thread.kind === "master") return thread;
    }
    return this.#create("master", null, null);
  }

  fork(from: ThreadId, atSeq?: number): Thread {
    if (!this.#threads.has(from)) throw new Error(`unknown thread ${from}`);
    return this.#create("session", from, atSeq ?? this.maxSeq(from));
  }

  #create(
    kind: "master" | "session",
    forkedFromThread: ThreadId | null,
    forkedAtSeq: number | null,
  ): Thread {
    const thread: Thread = {
      id: ThreadId(`t_${this.#nextThread++}`),
      projectId: ProjectId("p_test"),
      kind,
      forkedFromThread,
      forkedAtSeq,
      createdAt: nowIso(),
    };
    this.#threads.set(thread.id, thread);
    this.#entries.set(thread.id, []);
    return thread;
  }

  get(id: ThreadId): Thread | undefined {
    return this.#threads.get(id);
  }

  append(input: ThreadEntryInput): ThreadEntry {
    const list = this.#entries.get(input.threadId);
    if (!list) throw new Error(`unknown thread ${input.threadId}`);
    const entry: ThreadEntry = {
      ...input,
      id: this.#nextId++,
      seq: (list[list.length - 1]?.seq ?? 0) + 1,
      tokenEstimate: input.tokenEstimate ?? 0,
      createdAt: nowIso(),
    };
    list.push(entry);
    this.ctx.emit("thread/append", entry);
    return entry;
  }

  entries(id: ThreadId, range?: EntryRange): ThreadEntry[] {
    let list = [...(this.#entries.get(id) ?? [])];
    if (range?.fromSeq !== undefined) list = list.filter((e) => e.seq >= range.fromSeq!);
    if (range?.toSeq !== undefined) list = list.filter((e) => e.seq <= range.toSeq!);
    if (range?.limit !== undefined) list = list.slice(0, range.limit);
    return list;
  }

  maxSeq(id: ThreadId): number {
    const list = this.#entries.get(id);
    return list?.[list.length - 1]?.seq ?? 0;
  }

  liveContext(id: ThreadId): ThreadEntry[] {
    return this.#resolve(id, Number.POSITIVE_INFINITY);
  }

  #resolve(id: ThreadId, upToSeq: number): ThreadEntry[] {
    const thread = this.#threads.get(id);
    if (!thread) return [];
    const parent =
      thread.forkedFromThread !== null
        ? this.#resolve(
            thread.forkedFromThread,
            thread.forkedAtSeq ?? Number.POSITIVE_INFINITY,
          )
        : [];
    const own = (this.#entries.get(id) ?? []).filter((e) => e.seq <= upToSeq);
    return [...parent, ...fold(own)];
  }
}

function fold(entries: ThreadEntry[]): ThreadEntry[] {
  let newest: ThreadEntry | undefined;
  for (const e of entries) {
    if (e.kind === "compaction" && e.supersedesThroughSeq !== undefined) newest = e;
  }
  if (!newest) return entries;
  const cutoff = newest.supersedesThroughSeq!;
  return entries.filter((e) => e.seq > cutoff);
}
