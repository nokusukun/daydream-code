import type { Context } from "@daydream-code/kernel";
import { newId, nowIso } from "@daydream-code/shared";
import { schema } from "@daydream-code/store";
import { and, asc, eq } from "@daydream-code/store/drizzle";
import {
  MAX_ACTIONS,
  QuickActionError,
  QuickActions,
  normalizeAction,
  type QuickActionInput,
  type QuickActionRecord,
} from "./index.js";
import type {} from "@daydream-code/store";

const rows = schema.quickActions;

/** The record's own columns: `project_id` is the scope, not part of a row. */
const COLUMNS = {
  id: rows.id,
  label: rows.label,
  command: rows.command,
  source: rows.source,
  createdAt: rows.createdAt,
} as const;

/**
 * Default provider: the project store's `quick_actions` table.
 *
 * The list is small and read on demand — a menu opening — so there is no cache
 * to invalidate and no frame on the event stream. That is deliberate: a
 * capability that needed the transport to learn a new frame kind to be usable
 * would be a capability the transport knows about.
 */
export default class QuickActionsSqlite extends QuickActions {
  static inject = ["store"];

  constructor(ctx: Context) {
    super(ctx);
  }

  get #db() {
    return this.ctx.store.db;
  }

  get #projectId(): string {
    return this.ctx.store.project.id;
  }

  list(): QuickActionRecord[] {
    return this.#db
      .select(COLUMNS)
      .from(rows)
      .where(eq(rows.projectId, this.#projectId))
      .orderBy(asc(rows.createdAt), asc(rows.id))
      .all();
  }

  get(id: string): QuickActionRecord | undefined {
    return this.#db
      .select(COLUMNS)
      .from(rows)
      .where(and(eq(rows.projectId, this.#projectId), eq(rows.id, id)))
      .get();
  }

  add(input: QuickActionInput): QuickActionRecord {
    const clean = normalizeAction(input);
    if (clean === null) {
      throw new QuickActionError(
        "a quick action needs a single-line command to run",
      );
    }

    // Adding a command this project already has returns what is there rather
    // than a second row. The unique index makes that true even if a caller
    // forgets; this makes it a value rather than an exception.
    const existing = this.#db
      .select(COLUMNS)
      .from(rows)
      .where(
        and(eq(rows.projectId, this.#projectId), eq(rows.command, clean.command)),
      )
      .get();
    if (existing !== undefined) return existing;

    const count = this.list().length;
    if (count >= MAX_ACTIONS) {
      throw new QuickActionError(
        `this project already has ${MAX_ACTIONS} quick actions; remove one before adding another`,
      );
    }

    const record: QuickActionRecord = {
      id: newId("act"),
      label: clean.label,
      command: clean.command,
      source: clean.source,
      createdAt: nowIso(),
    };
    this.#db.insert(rows).values({ ...record, projectId: this.#projectId }).run();
    this.ctx.emit("actions/changed", record);
    return record;
  }

  update(
    id: string,
    patch: { label?: string; command?: string },
  ): QuickActionRecord | undefined {
    const current = this.get(id);
    if (current === undefined) return undefined;

    // An emptied command is a removal, not a broken row: the only thing a row
    // is for is running it.
    const clean = normalizeAction({
      label: patch.label ?? current.label,
      command: patch.command ?? current.command,
      source: current.source,
    });
    if (clean === null) {
      this.remove(id);
      return undefined;
    }

    const collision = this.#db
      .select({ id: rows.id })
      .from(rows)
      .where(
        and(eq(rows.projectId, this.#projectId), eq(rows.command, clean.command)),
      )
      .get();
    if (collision !== undefined && collision.id !== id) {
      throw new QuickActionError("this project already has that command");
    }

    const next: QuickActionRecord = { ...current, label: clean.label, command: clean.command };
    this.#db
      .update(rows)
      .set({ label: next.label, command: next.command })
      .where(eq(rows.id, id))
      .run();
    this.ctx.emit("actions/changed", next);
    return next;
  }

  remove(id: string): boolean {
    const current = this.get(id);
    if (current === undefined) return false;
    this.#db.delete(rows).where(eq(rows.id, id)).run();
    this.ctx.emit("actions/changed", null);
    return true;
  }
}
