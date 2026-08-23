import { eq } from "@daydream-code/store/drizzle";
import { z } from "zod";
import type { Context } from "@daydream-code/kernel";
// Side-effect type imports: pull in the Context/Events declaration merges for
// every seam this runner touches through ctx.*.
import type {} from "@daydream-code/journal";
import type {} from "@daydream-code/thread";
import type {} from "@daydream-code/tools";
import type {} from "@daydream-code/summarize";
import type {} from "@daydream-code/compaction";
import {
  SessionId,
  newId,
  nowIso,
  zeroUsage,
  addUsage,
  ThreadId,
  type JournalEvent,
  type SessionRecord,
  type Usage,
} from "@daydream-code/shared";
import { schema } from "@daydream-code/store";
import type { Injection } from "@daydream-code/driver";
import {
  Sessions,
  type DispatchRequest,
  type SessionHandle,
} from "./index.js";

interface ActiveRun {
  abort: AbortController;
  injections: Injection[];
  done: Promise<SessionRecord>;
  stopping: boolean;
}

type SessionRow = typeof schema.sessions.$inferSelect;

function rowToRecord(row: SessionRow): SessionRecord {
  return {
    id: SessionId(row.id),
    projectId: row.projectId as SessionRecord["projectId"],
    threadId: ThreadId(row.threadId),
    title: row.title,
    task: row.task,
    driver: row.driver,
    modelId: row.modelId,
    status: row.status,
    lastSeenMasterSeq: row.lastSeenMasterSeq,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    summary: row.summary,
    tldr: row.tldr,
    usage: {
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      costUsd: row.costUsd,
    },
  };
}

/**
 * Default provider of the Sessions seam: dispatch = fork master + drive via a
 * registered driver + journal everything + write summaries back to master.
 * Replace this plugin in config to replace the whole loop.
 */
export default class SessionRunner extends Sessions {
  static inject = [
    "store",
    "journal",
    "threads",
    "drivers",
    "tools",
    "summarizer",
    "tokens",
    "compaction",
  ];
  static Config = z.object({}).default({});

  #active = new Map<string, ActiveRun>();

  constructor(ctx: Context) {
    super(ctx);
    this.#recoverAbandoned();
  }

  /** Boot repair: sessions left `running` by a dead process become `killed`. */
  #recoverAbandoned(): void {
    const db = this.ctx.store.db;
    const orphans = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.status, "running"))
      .all();
    for (const row of orphans) {
      db.update(schema.sessions)
        .set({
          status: "killed",
          endedAt: nowIso(),
          summary:
            row.summary ??
            "session was interrupted by a process restart; its journal records everything up to the cut",
          tldr: row.tldr ?? "interrupted by restart",
        })
        .where(eq(schema.sessions.id, row.id))
        .run();
      const record = this.get(SessionId(row.id));
      if (record) this.ctx.emit("session/ended", record);
    }
  }

  get(id: SessionId): SessionRecord | undefined {
    const row = this.ctx.store.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id))
      .get();
    return row ? rowToRecord(row) : undefined;
  }

  list(): SessionRecord[] {
    return this.ctx.store.db
      .select()
      .from(schema.sessions)
      .all()
      .map(rowToRecord);
  }

  running(): SessionId[] {
    return [...this.#active.keys()].map(SessionId);
  }

  async dispatch(request: DispatchRequest): Promise<SessionHandle> {
    return (await this.ctx.waterfall(
      "session/pre-dispatch",
      [request],
      (req: DispatchRequest) => this.#dispatch(req),
    )) as SessionHandle;
  }

  async #dispatch(request: DispatchRequest): Promise<SessionHandle> {
    const ctx = this.ctx;
    const master = ctx.threads.ensureMaster();
    const fork = ctx.threads.fork(ThreadId(master.id));
    const id = newId("ses");
    const project = ctx.store.project;
    const driverId = request.driver ?? project.config.defaultDriver;
    const modelId = request.modelId ?? project.config.defaultModel;
    ctx.store.db
      .insert(schema.sessions)
      .values({
        id,
        projectId: project.id,
        threadId: fork.id,
        title: request.title ?? null,
        task: request.task,
        driver: driverId,
        modelId: modelId ?? null,
        status: "running",
        // The fork saw everything up to its cut; awareness starts after it.
        lastSeenMasterSeq: fork.forkedAtSeq ?? 0,
        startedAt: nowIso(),
      })
      .run();
    const record = this.get(SessionId(id))!;
    ctx.emit("session/dispatched", record, "new", request.task);
    return this.#startRun(record, request.task, request);
  }

  async continueSession(
    id: SessionId,
    message: string,
  ): Promise<SessionHandle> {
    const active = this.#active.get(id);
    const record = this.get(id);
    if (!record) throw new Error(`unknown session "${id}"`);
    if (active) {
      active.injections.push({ kind: "user", text: message });
      this.ctx.emit("session/dispatched", record, "continue", message);
      return { record, done: active.done };
    }
    this.ctx.store.db
      .update(schema.sessions)
      .set({ status: "running", endedAt: null })
      .where(eq(schema.sessions.id, id))
      .run();
    const revived = this.get(id)!;
    this.ctx.emit("session/dispatched", revived, "continue", message);
    return this.#startRun(revived, message, {
      task: message,
      driver: revived.driver,
      ...(revived.modelId ? { modelId: revived.modelId } : {}),
    });
  }

  async stop(id: SessionId): Promise<void> {
    const active = this.#active.get(id);
    if (!active) return;
    active.stopping = true;
    // Structural cast: @types/node's abort globals degrade to empty
    // interfaces when an ambient Bun types package leaks into the program.
    (active.abort as unknown as { abort(): void }).abort();
    await active.done.catch(() => undefined);
  }

  #resumeKey(id: string): string {
    return `driver_resume:${id}`;
  }

  #loadResumeToken(id: string): string | null {
    const row = this.ctx.store.db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, this.#resumeKey(id)))
      .get();
    return row ? (JSON.parse(row.valueJson) as string) : null;
  }

  #saveResumeToken(id: string, token: string): void {
    this.ctx.store.db
      .insert(schema.settings)
      .values({
        key: this.#resumeKey(id),
        valueJson: JSON.stringify(token),
        updatedAt: nowIso(),
      })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { valueJson: JSON.stringify(token), updatedAt: nowIso() },
      })
      .run();
  }

  #startRun(
    record: SessionRecord,
    task: string,
    request: DispatchRequest,
  ): SessionHandle {
    const ctx = this.ctx;
    const driver = ctx.drivers.get(record.driver);
    if (!driver) {
      throw new Error(
        `driver "${record.driver}" is not registered (available: ${ctx.drivers.list().join(", ") || "none"})`,
      );
    }
    const abort = new AbortController();
    const active: ActiveRun = {
      abort,
      injections: [],
      done: undefined as unknown as Promise<SessionRecord>,
      stopping: false,
    };

    const resumeToken = this.#loadResumeToken(record.id);
    // With a driver-native resume token the driver already holds the full
    // transcript; otherwise seed with the forked master-thread context.
    const context = resumeToken ? [] : ctx.threads.liveMessages(record.threadId);

    let turnEvents: JournalEvent[] = [];
    let usage: Usage = zeroUsage();

    const onEvent = (event: {
      type: string;
      payload: unknown;
      usage?: Partial<Usage>;
    }) => {
      const journaled = ctx.journal.append({
        sessionId: record.id,
        type: event.type,
        payload: event.payload,
        ...(event.usage ? { usage: event.usage } : {}),
      });
      turnEvents.push(journaled);
      if (event.usage) usage = addUsage(usage, event.usage);
      if (event.type === "turn_end") {
        const finished = turnEvents;
        turnEvents = [];
        void this.#onTurnEnd(record, finished);
      }
    };

    const drainInjections = (): Injection[] => {
      const queued = active.injections.splice(0);
      const blocks: string[] = [];
      ctx.emit("session/collect-injections", record, blocks);
      return [
        ...queued,
        ...blocks.map(
          (text): Injection => ({ kind: "master_update", text }),
        ),
      ];
    };

    active.done = (async (): Promise<SessionRecord> => {
      try {
        ctx.journal.append({
          sessionId: record.id,
          type: "session_started",
          payload: {
            task,
            driver: record.driver,
            modelId: record.modelId,
            contextMessages: context.length,
            resumed: resumeToken !== null,
          },
        });
        const result = await driver.run({
          sessionId: record.id,
          workdir: ctx.store.rootPath,
          context,
          task,
          modelId: record.modelId,
          tools: ctx.tools.list(),
          onEvent,
          drainInjections,
          signal: (abort as unknown as { signal: AbortSignal }).signal,
          permissionMode: request.permissionMode ?? "auto",
          resumeToken,
        });
        usage = addUsage(usage, result.usage);
        if (result.resumeToken) {
          this.#saveResumeToken(record.id, result.resumeToken);
        }
        return this.#finish(
          record,
          active.stopping ? "killed" : "completed",
          result.summary,
          result.tldr,
          usage,
        );
      } catch (error) {
        ctx.journal.append({
          sessionId: record.id,
          type: "driver_error",
          payload: { error: String(error) },
        });
        const { summary, tldr } = await ctx.summarizer
          .sessionSummary({
            session: record,
            events: ctx.journal.read({ sessionId: record.id }),
            reason: active.stopping ? "killed" : "failed",
          })
          .catch(() => ({
            summary: `session failed: ${String(error)}`,
            tldr: "session failed",
          }));
        return this.#finish(
          record,
          active.stopping ? "killed" : "failed",
          summary,
          tldr,
          usage,
        );
      } finally {
        this.#active.delete(record.id);
      }
    })();

    this.#active.set(record.id, active);
    return { record, done: active.done };
  }

  async #onTurnEnd(
    record: SessionRecord,
    turnEvents: JournalEvent[],
  ): Promise<void> {
    const ctx = this.ctx;
    try {
      const fresh = this.get(record.id) ?? record;
      fresh.lastSeenMasterSeq = record.lastSeenMasterSeq;
      const summary = await ctx.summarizer.turnSummary({
        session: fresh,
        turnEvents,
      });
      ctx.emit("session/turn-ended", fresh, summary);
      const master = ctx.threads.ensureMaster();
      await ctx.compaction.maybeCompact(ThreadId(master.id));
    } catch (error) {
      console.error("[session-runner] turn-end handling failed:", error);
    }
  }

  #finish(
    record: SessionRecord,
    status: "completed" | "failed" | "killed",
    summary: string,
    tldr: string,
    usage: Usage,
  ): SessionRecord {
    const ctx = this.ctx;
    ctx.store.db
      .update(schema.sessions)
      .set({
        status,
        endedAt: nowIso(),
        summary,
        tldr,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        costUsd: usage.costUsd,
      })
      .where(eq(schema.sessions.id, record.id))
      .run();
    const final = this.get(record.id)!;
    ctx.journal.append({
      sessionId: record.id,
      type: "session_ended",
      payload: { status, tldr },
      usage,
    });
    ctx.emit("session/updated", final);
    ctx.emit("session/ended", final);
    void ctx.compaction
      .maybeCompact(ThreadId(ctx.threads.ensureMaster().id))
      .catch(() => undefined);
    return final;
  }
}
