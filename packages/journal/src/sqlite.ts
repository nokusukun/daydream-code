import type { Context } from "@daydream-code/kernel";
import {
  SessionId,
  nowIso,
  type JournalEvent,
  type JournalEventInput,
  type Usage,
} from "@daydream-code/shared";
import { schema } from "@daydream-code/store";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "@daydream-code/store/drizzle";
import {
  Journal,
  type JournalReadOptions,
  type JournalSearchHit,
  type JournalSearchOptions,
} from "./index.js";

const t = schema.journalEvents;

type EventRow = typeof t.$inferSelect;

/**
 * Default journal provider on the project store. Append-only immutability is
 * enforced by the store's SQL triggers; `journal/append` is emitted only after
 * the row is durably committed (DB-first, then broadcast).
 */
export default class JournalSqlite extends Journal {
  static inject = ["store"];

  constructor(ctx: Context) {
    super(ctx);
  }

  get #db() {
    return this.ctx.store.db;
  }

  append(input: JournalEventInput): JournalEvent {
    const row = this.#db
      .insert(t)
      .values({
        sessionId: input.sessionId,
        ts: input.ts ?? nowIso(),
        type: input.type,
        payloadJson: JSON.stringify(input.payload ?? null),
        tokensIn: input.usage?.tokensIn ?? null,
        tokensOut: input.usage?.tokensOut ?? null,
        costUsd: input.usage?.costUsd ?? null,
      })
      .returning()
      .get();
    const event = this.#toEvent(row);
    this.ctx.emit("journal/append", event);
    return event;
  }

  read(options: JournalReadOptions = {}): JournalEvent[] {
    const conditions: SQL[] = [];
    if (options.sessionId !== undefined) {
      conditions.push(eq(t.sessionId, options.sessionId));
    }
    if (options.afterId !== undefined) conditions.push(gt(t.id, options.afterId));
    if (options.beforeId !== undefined) conditions.push(lt(t.id, options.beforeId));
    if (options.types !== undefined && options.types.length > 0) {
      conditions.push(inArray(t.type, options.types));
    }
    const query = this.#db
      .select()
      .from(t)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(options.latest ? desc(t.id) : asc(t.id));
    const rows =
      options.limit !== undefined ? query.limit(options.limit).all() : query.all();
    // `latest` pages from the end but the result stays in ascending order.
    if (options.latest) rows.reverse();
    return rows.map((row) => this.#toEvent(row));
  }

  search(query: string, options: JournalSearchOptions = {}): JournalSearchHit[] {
    const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);
    const conditions: SQL[] = [
      sql`${t.payloadJson} LIKE ${`%${escaped}%`} ESCAPE '\\'`,
    ];
    if (options.sessionId !== undefined) {
      conditions.push(eq(t.sessionId, options.sessionId));
    }
    if (options.excludeTail !== undefined) {
      const { sessionId, fromId } = options.excludeTail;
      // "Not (this session AND at/after the cutoff)" — a different session's
      // recent events still match, only the caller's own tail is dropped.
      conditions.push(
        or(ne(t.sessionId, sessionId), lt(t.id, fromId)) as SQL,
      );
    }
    const rows = this.#db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(asc(t.id))
      .limit(options.limit ?? 20)
      .all();
    const needle = query.toLowerCase();
    return rows.map((row) => {
      const text = row.payloadJson;
      const at = text.toLowerCase().indexOf(needle);
      const snippet =
        at < 0
          ? text.slice(0, 160)
          : text.slice(Math.max(0, at - 80), at + query.length + 80);
      return {
        eventId: row.id,
        sessionId: SessionId(row.sessionId),
        ts: row.ts,
        type: row.type,
        snippet,
      };
    });
  }

  maxId(): number {
    const row = this.#db
      .select({ max: sql<number>`coalesce(max(${t.id}), 0)` })
      .from(t)
      .get();
    return row?.max ?? 0;
  }

  #toEvent(row: EventRow): JournalEvent {
    const usage: Partial<Usage> = {};
    if (row.tokensIn !== null) usage.tokensIn = row.tokensIn;
    if (row.tokensOut !== null) usage.tokensOut = row.tokensOut;
    if (row.costUsd !== null) usage.costUsd = row.costUsd;
    return {
      id: row.id,
      sessionId: SessionId(row.sessionId),
      ts: row.ts,
      type: row.type,
      payload: JSON.parse(row.payloadJson) as unknown,
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    };
  }
}
