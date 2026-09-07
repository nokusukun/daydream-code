import { and, desc, eq, inArray, sql } from "@daydream-code/store/drizzle";
import { defineConfig, field, type ConfigOf } from "@daydream-code/config";
import type { Context } from "@daydream-code/kernel";
// Side-effect type imports: pull in the Context/Events declaration merges for
// every seam this runner touches through ctx.*.
import type {} from "@daydream-code/journal";
import type {} from "@daydream-code/thread";
import type {} from "@daydream-code/tools";
import type {} from "@daydream-code/summarize";
import type {} from "@daydream-code/compaction";
import type {} from "@daydream-code/questions";
import type { PendingAsk } from "@daydream-code/asks";
import { imagePart } from "@daydream-code/blobs";
import {
  SessionId,
  newId,
  slugifyName,
  titleFromTask,
  uniqueName,
  nowIso,
  LIVE_STATUSES,
  zeroUsage,
  addUsage,
  ThreadId,
  type ImagePart,
  type JournalEvent,
  type SessionRecord,
  type Usage,
} from "@daydream-code/shared";
import { schema } from "@daydream-code/store";
import type { Injection } from "@daydream-code/driver";
import { onAbort } from "@daydream-code/driver/abort";
import {
  Sessions,
  type AttachmentInput,
  type DeliveryOutcome,
  type DispatchRequest,
  type HandoffRequest,
  type ModelChange,
  type NextMessage,
  type SessionHandle,
} from "./index.js";
import {
  lastEditableMessage,
  transcriptMessages,
  transcriptText,
} from "./transcript.js";

interface ActiveRun {
  abort: AbortController;
  injections: Injection[];
  done: Promise<SessionRecord>;
  stopping: boolean;
}

interface HeldNextMessage {
  view: NextMessage;
  attachments: AttachmentInput[];
}

interface ModelUndoState {
  from: {
    driver: string;
    modelId: string | null;
    effort: string | null;
    /** Missing only in an undo row written by a pre-fast-mode build. */
    fastMode?: boolean;
  };
  resumeToken: string | null;
}

type SessionRow = typeof schema.sessions.$inferSelect;

function rowToRecord(row: SessionRow): SessionRecord {
  return {
    id: SessionId(row.id),
    projectId: row.projectId as SessionRecord["projectId"],
    threadId: ThreadId(row.threadId),
    name: row.name,
    title: row.title,
    task: row.task,
    driver: row.driver,
    modelId: row.modelId,
    effort: row.effort,
    fastMode: row.fastMode,
    status: row.status,
    lastSeenMasterSeq: row.lastSeenMasterSeq,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    summary: row.summary,
    tldr: row.tldr,
    archivedAt: row.archivedAt,
    usage: {
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      costUsd: row.costUsd,
    },
  };
}

const { Config, settings } = defineConfig({
  wakeBudget: field.number({
    label: "wake budget",
    help:
      "consecutive harness-authored wakes allowed per session before it is " +
      "left alone until the user speaks to it. Bounds a chain of sessions " +
      "waking each other while nobody is watching.",
    default: 3,
    integer: true,
    min: 0,
  }),
});

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
    "questions",
    "summarizer",
    "tokens",
    "compaction",
    "blobs",
  ];
  static Config = Config;
  static settings = settings;

  /**
   * Consecutive harness-authored wakes allowed per session, from config.
   *
   * Read through an instance field rather than the old static so a change
   * takes effect on reload; the static remains as the default the schema
   * declares.
   */
  readonly #wakeBudget: number;

  #active = new Map<string, ActiveRun>();
  #nextMessages = new Map<string, HeldNextMessage[]>();

  /**
   * Harness-authored wakes spent per session since the user last spoke to it.
   *
   * Waking an idle session is self-exciting: the woken run ends a turn, which
   * is itself a trigger to wake it again, and a session several siblings are
   * asking at once multiplies that. Capping each *ask* does not bound it,
   * because the runaway lives on the session being woken rather than on any
   * one question. So the budget sits on the target.
   *
   * What it counts is wakes that produced *nothing*. A session that was woken
   * and actually answered did bounded, useful work and gets its budget back —
   * capping that would mean a helpful sibling going silent after three
   * questions, which reads as a broken tool rather than a safety rail. The
   * runaway this exists to stop is the other shape: woken, no answer, ends a
   * turn, which is itself a trigger to wake it again.
   *
   * Refills are on answers and on user-authored input only, never on time. A
   * clock would make the same chain slower rather than stopping it.
   */
  #wakesSinceUser = new Map<string, number>();

  constructor(ctx: Context, config: ConfigOf<typeof Config>) {
    super(ctx);
    this.#wakeBudget = config.wakeBudget;
    this.#recoverAbandoned();
    this.#retireOrphanedQuestions();
    this.#watchQuestions();
    this.#watchAsks();
  }

  /**
   * A blocked session is still live — its driver is up and its turn resumes on
   * an answer — but it is doing nothing until a human acts, and that has to be
   * visible without opening the transcript. The runner owns `status`, so it
   * flips the row here rather than letting the questions seam touch the store.
   */
  #watchQuestions(): void {
    const ctx = this.ctx;
    ctx.on("question/asked", (pending) => {
      ctx.journal.append({
        sessionId: pending.sessionId,
        type: "question_asked",
        payload: { requestId: pending.requestId, questions: pending.questions },
      });
      this.#setStatus(pending.sessionId, "waiting");
    });
    ctx.on("question/settled", (pending, outcome) => {
      ctx.journal.append({
        sessionId: pending.sessionId,
        type: "question_settled",
        payload: { requestId: pending.requestId, ...outcome },
      });
      // Only back to `running` if the run is still up: a cancel fired from the
      // teardown path must not resurrect a session that is on its way out.
      if (this.#active.has(pending.sessionId)) {
        this.#setStatus(pending.sessionId, "running");
      }
    });
  }

  /** Move a live session between `running` and `waiting`, and announce it. */
  #setStatus(id: SessionId, status: "running" | "waiting"): void {
    const changed = this.ctx.store.db
      .update(schema.sessions)
      .set({ status })
      // Guarded on a live status: a settle arriving from the teardown path
      // races the terminal write, and must not undo it.
      .where(
        and(
          eq(schema.sessions.id, id),
          inArray(schema.sessions.status, [...LIVE_STATUSES]),
        ),
      )
      .run();
    if (changed.changes === 0) return;
    const record = this.get(id);
    if (record) this.ctx.emit("session/updated", record);
  }

  /**
   * Session-to-session asks. The `asks` seam owns *whether* a session is
   * blocked and for how long; the runner owns everything about actually
   * reaching the other session, because only it knows whether that session is
   * mid-turn, idle, or gone — and only it may write `status`.
   *
   * Delivery is direct rather than through the master thread, which is the
   * obvious-looking alternative and is wrong twice over. `master-inject`
   * advances `lastSeenMasterSeq` to the head on every collect, including past
   * entries the filter dropped, so a message can be stepped over permanently;
   * and it only ever runs inside a live turn, so an idle target would never
   * see one at all. An ask has a caller blocked on it, so it cannot be
   * best-effort.
   */
  #watchAsks(): void {
    const ctx = this.ctx;
    ctx.on("ask/requested", (pending) => {
      ctx.journal.append({
        sessionId: pending.fromSessionId,
        type: "ask_requested",
        payload: {
          requestId: pending.requestId,
          to: pending.toName,
          question: pending.question,
        },
      });
      this.#setStatus(pending.fromSessionId, "waiting");
      // Deferred, not inline. Delivery can wake a session that answers in the
      // same tick, and settling from inside this emit would run every
      // `ask/settled` listener before the remaining `ask/requested` ones —
      // so a listener could see the answer before it hears about the question.
      queueMicrotask(() => void this.#deliverAsk(pending, 0));
    });

    ctx.on("ask/nudged", (pending, attempt) => {
      queueMicrotask(() => void this.#deliverAsk(pending, attempt));
    });

    ctx.on("ask/settled", (pending, outcome) => {
      ctx.journal.append({
        sessionId: pending.fromSessionId,
        type: "ask_settled",
        payload: { requestId: pending.requestId, from: pending.toName, ...outcome },
      });
      if (outcome.kind === "answered" || outcome.kind === "declined") {
        // The target responded, so the wakes spent reaching it bought
        // something. Only silence accumulates.
        this.#wakesSinceUser.delete(pending.toSessionId);
      }
      // Only back to `running` if the asker's run is still up, for the same
      // reason `question/settled` is guarded: a cancel fired from teardown must
      // not resurrect a session on its way out.
      if (this.#active.has(pending.fromSessionId)) {
        this.#setStatus(pending.fromSessionId, "running");
      }
    });

    ctx.on("session/ended", (session) => {
      // The asker died mid-ask (aborted or killed): nobody is listening for
      // the answer any more, so stop holding the target to it.
      ctx.asks.cancelSession(session.id, `session ${session.name} ended`);
      const owed = ctx.asks.inbound(session.id);
      if (owed.length === 0) return;
      if (session.status === "completed") {
        // It finished its turn still owing an answer. This is the honest
        // moment to nudge: the question was in its context and it moved on
        // without acting, which no timer could have known.
        for (const pending of owed) {
          ctx.asks.nudge(
            pending.requestId,
            `${session.name} finished its turn without answering`,
          );
        }
        return;
      }
      // `killed` or `failed`. A killed session was stopped on purpose, so
      // waking it back up would be overriding that decision; a failed one will
      // fail again. Release the askers instead of nudging a corpse.
      ctx.asks.abandonTarget(
        session.id,
        `${session.name} ended (${session.status}) without answering`,
      );
    });
  }

  /** The prose the target actually receives. */
  #askText(pending: PendingAsk, attempt: number): string {
    const reminder =
      attempt === 0
        ? ""
        : `[reminder ${attempt}] You have not answered this yet. `;
    return [
      `${reminder}Session "${pending.fromName}" is blocked waiting on you and cannot continue until you answer.`,
      "",
      `Question: ${pending.question}`,
      "",
      `Answer it with answer_session({ request_id: "${pending.requestId}", answer: "..." }), or decline with { decline: true, answer: "why" } if you cannot help. Answer before you resume your own work — the other session is stopped until you do.`,
    ].join("\n");
  }

  /**
   * Get the question in front of the target, whatever state it is in.
   *
   * The idle branch deliberately goes through the same `continueSession` a
   * human message uses, so an asked session wakes up exactly the way it would
   * if the user had typed to it.
   */
  async #deliverAsk(pending: PendingAsk, attempt: number): Promise<void> {
    const ctx = this.ctx;
    const target = this.get(pending.toSessionId);
    if (!target) {
      ctx.asks.settle(pending.requestId, {
        kind: "unanswered",
        reason: `session ${pending.toName} no longer exists`,
        nudges: pending.nudges,
      });
      return;
    }
    const active = this.#active.get(pending.toSessionId);
    if (active && !LIVE_STATUSES.includes(target.status)) {
      // The row is already terminal but the run has not been retired yet —
      // this is exactly where a nudge fired from `session/ended` lands, since
      // `#active` is only cleared in the run loop's `finally`. Queueing here
      // would push the question into a run that can never drain it, and the
      // asker would wait out its whole budget against a corpse. Awaiting
      // `done` is precise: the `finally` runs before it settles.
      await active.done.catch(() => undefined);
      return this.#deliverAsk(pending, attempt);
    }
    if (!active && !this.#mayWake(pending.toSessionId)) {
      // Out of wakes. Releasing the asker now rather than letting its nudges
      // expire against a session nothing will start: the budget only refills
      // on user input, so waiting changes nothing except how long it takes.
      ctx.asks.settle(pending.requestId, {
        kind: "unanswered",
        reason: `${pending.toName} has been woken ${this.#wakeBudget} times without the user speaking to it, and will not be woken again until they do`,
        nudges: pending.nudges,
      });
      return;
    }
    const text = this.#askText(pending, attempt);
    ctx.journal.append({
      sessionId: pending.toSessionId,
      type: "ask_received",
      payload: {
        requestId: pending.requestId,
        from: pending.fromName,
        question: pending.question,
        attempt,
      },
    });
    if (active) {
      // Mid-turn: queue it. Costs no wake — the run is already up, and the
      // question rides along at its next turn boundary. If the target is
      // itself `waiting` on a human question this will not drain until that
      // clears, which is why the ask has a nudge budget too.
      active.injections.push({ kind: "ask", text });
      return;
    }
    this.#spendWake(pending.toSessionId);
    try {
      const handle = await this.continueSession(
        pending.toSessionId,
        text,
        undefined,
        "ask",
      );
      // The revived run outlives this call; its failure is reported through
      // the target's own journal, and must not surface as an unhandled
      // rejection on the asker's stack.
      void handle.done.catch(() => undefined);
    } catch (error) {
      ctx.asks.settle(pending.requestId, {
        kind: "unanswered",
        reason: `could not reach ${pending.toName}: ${String(error)}`,
        nudges: pending.nudges,
      });
    }
  }

  /** Whether the harness may start a fresh run on this session unprompted. */
  #mayWake(id: SessionId): boolean {
    return (this.#wakesSinceUser.get(id) ?? 0) < this.#wakeBudget;
  }

  #spendWake(id: SessionId): void {
    this.#wakesSinceUser.set(id, (this.#wakesSinceUser.get(id) ?? 0) + 1);
  }

  /**
   * Boot repair: sessions left live by a dead process become `killed`. That
   * includes `waiting` — a pending question is an in-memory promise, so it
   * died with the process that held it and nothing can ever answer it now.
   */
  #recoverAbandoned(): void {
    const db = this.ctx.store.db;
    const orphans = db
      .select()
      .from(schema.sessions)
      .where(inArray(schema.sessions.status, [...LIVE_STATUSES]))
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

  /**
   * Boot repair, second half: retire questions whose answerer died with the
   * process that held them.
   *
   * A pending question is an in-memory promise, so a restart leaves the
   * `question_asked` row in the journal with nothing behind it. Clients derive
   * the prompt by folding that journal rather than from a stored flag, so
   * without a closing row they keep offering the question forever and every
   * answer comes back 409 — the shape a user hits as "stuck on the ask screen
   * after a crash".
   *
   * Swept from the journal, not from the session rows `#recoverAbandoned`
   * just walked: a session an earlier boot already marked `killed` is no
   * longer live and would never be revisited, but its question is just as
   * unanswerable. Folding by request id makes the sweep idempotent, so the
   * boot after this one finds nothing to do.
   */
  #retireOrphanedQuestions(): void {
    const events = this.ctx.journal.read({
      types: ["question_asked", "question_settled"],
    });
    const open = new Map<string, SessionId>();
    for (const event of events) {
      const payload = event.payload;
      const requestId =
        payload !== null &&
        typeof payload === "object" &&
        typeof (payload as { requestId?: unknown }).requestId === "string"
          ? ((payload as { requestId: string }).requestId)
          : null;
      if (requestId === null) continue;
      if (event.type === "question_asked") open.set(requestId, event.sessionId);
      else open.delete(requestId);
    }
    for (const [requestId, sessionId] of open) {
      this.ctx.journal.append({
        sessionId,
        type: "question_settled",
        payload: {
          requestId,
          kind: "cancelled",
          reason:
            "the harness restarted before this was answered; nothing could have delivered the answer",
        },
      });
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

  resolve(idOrName: string): SessionRecord | undefined {
    // Ids carry a `ses_` prefix and names never contain `_`, so the two spaces
    // cannot collide; try the primary key first regardless.
    const byId = this.get(SessionId(idOrName));
    if (byId !== undefined) return byId;
    const row = this.ctx.store.db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.projectId, this.ctx.store.project.id),
          eq(schema.sessions.name, idOrName),
        ),
      )
      .get();
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * Slug the opening title (or an explicit request) and number it past any
   * existing sibling. Naming off the title rather than the raw task keeps the
   * two consistent: a multi-sentence task titles to its first sentence, and
   * the name is that sentence slugged.
   */
  #mintName(request: DispatchRequest, title: string, projectId: string): string {
    const base = slugifyName(request.name ?? title);
    const taken = new Set(
      this.ctx.store.db
        .select({ name: schema.sessions.name })
        .from(schema.sessions)
        .where(eq(schema.sessions.projectId, projectId))
        .all()
        .map((row) => row.name),
    );
    return uniqueName(base, (candidate) => taken.has(candidate));
  }

  /**
   * Title for an instruction, via the summarizer seam. A provider that throws
   * (or a model-backed one that times out) must not take a dispatch or an
   * in-flight message down with it, so this falls back to the mechanical rule.
   */
  async #deriveTitle(
    task: string,
    session?: SessionRecord,
  ): Promise<string> {
    try {
      const title = await this.ctx.summarizer.title({
        task,
        ...(session ? { session } : {}),
      });
      const trimmed = title.trim();
      if (trimmed.length > 0) return trimmed;
    } catch (error) {
      console.error("[session-runner] titling failed:", error);
    }
    return titleFromTask(task);
  }

  /**
   * Move attachments into the blob store and return their durable parts.
   * Content-addressed, so re-sending the same screenshot costs no extra disk.
   */
  #ingest(attachments: AttachmentInput[] | undefined): ImagePart[] {
    if (attachments === undefined || attachments.length === 0) return [];
    return attachments.map((attachment) => {
      if ("path" in attachment) {
        return imagePart(
          this.ctx.blobs.putFile(attachment.path),
          attachment.path.split(/[\\/]/).pop(),
        );
      }
      if ("blobId" in attachment) {
        const ref = this.ctx.blobs.stat(attachment.blobId);
        if (ref === undefined) {
          throw new Error(`no such attachment: ${attachment.blobId}`);
        }
        return imagePart(ref, attachment.alt);
      }
      const bytes = Buffer.from(attachment.data, "base64");
      return imagePart(this.ctx.blobs.put(bytes, attachment.alt), attachment.alt);
    });
  }

  /**
   * Hand a driver the bytes for an attached image. Drivers get this through
   * `DriverRunInput` rather than injecting the blobs seam themselves, so the
   * driver package stays independent of how attachments are stored.
   */
  #resolveImage(part: ImagePart) {
    const blobs = this.ctx.blobs;
    if (!blobs.has(part.blobId)) {
      throw new Error(`blob ${part.blobId} is missing from the store`);
    }
    return {
      path: blobs.path(part.blobId),
      mediaType: part.mediaType,
      base64: () => blobs.read(part.blobId).toString("base64"),
    };
  }

  /**
   * A new instruction redirects the session, so the title follows it. `name`
   * deliberately does not move — it is the address other entries point at.
   */
  async #retitle(record: SessionRecord, task: string): Promise<SessionRecord> {
    const title = await this.#deriveTitle(task, record);
    if (title === record.title) return record;
    this.ctx.store.db
      .update(schema.sessions)
      .set({ title })
      .where(eq(schema.sessions.id, record.id))
      .run();
    const updated = this.get(record.id) ?? record;
    this.ctx.emit("session/updated", updated);
    return updated;
  }

  /**
   * Every session in the project, most recently active first — a session that
   * just finished outranks one that merely started earlier. `ended_at` is
   * nulled on continue and re-stamped on finish, so the coalesce is the last
   * turn's timestamp, not the original dispatch. ISO-8601 strings compare
   * lexicographically, so this needs no date parsing; the JS equivalent is
   * `compareSessionRecency` in @daydream-code/shared, and the two must agree.
   */
  list(): SessionRecord[] {
    return this.ctx.store.db
      .select()
      .from(schema.sessions)
      .orderBy(
        desc(
          sql`coalesce(${schema.sessions.endedAt}, ${schema.sessions.startedAt})`,
        ),
        schema.sessions.name,
      )
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
    const project = ctx.store.project;
    const driverId = request.driver ?? project.config.defaultDriver;
    const selectedDriver = ctx.drivers.get(driverId);
    if (request.fastMode === true && selectedDriver?.supportsFastMode !== true) {
      throw new Error(`driver "${driverId}" does not support fast mode`);
    }
    const title = await this.#deriveTitle(request.task);
    const master = ctx.threads.ensureMaster();
    const fork = ctx.threads.fork(ThreadId(master.id));
    const id = newId("ses");
    const modelId = request.modelId ?? project.config.defaultModel;
    ctx.store.db
      .insert(schema.sessions)
      .values({
        id,
        projectId: project.id,
        threadId: fork.id,
        name: this.#mintName(request, title, project.id),
        title,
        task: request.task,
        driver: driverId,
        modelId: modelId ?? null,
        // No project-level default, unlike modelId: null means the driver's
        // own default, which tracks the provider instead of freezing a level.
        effort: request.effort ?? null,
        fastMode: request.fastMode ?? false,
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
    attachments?: AttachmentInput[],
    /** How this continue is described on the master thread. */
    kind: "continue" | "ask" | "message" = "continue",
  ): Promise<SessionHandle> {
    const active = this.#active.get(id);
    const record = this.get(id);
    if (!record) throw new Error(`unknown session "${id}"`);
    // The new message is the current task now, so the title moves to it —
    // before the dispatch event, so listeners see the session as it now is.
    if (kind === "continue") {
      // The user spoke to this session, so it is theirs again: siblings may
      // wake it afresh. This is the only thing that refills the budget.
      this.#wakesSinceUser.delete(id);
    }
    // A delivered question retitles to what the session is now doing, not to
    // the question's own boilerplate — `titleFromTask` would otherwise make
    // every asked session read "Session "x" is blocked waiting on you...".
    // Sibling-authored text does not retitle, and — load-bearing beyond the
    // title — skipping the await keeps this method synchronous from the
    // `#active` read above through to `#startRun`. Two deliveries landing in
    // the same tick therefore serialise: the first registers the run, the
    // second sees it and queues. An await here would reopen that window and
    // let both start a run on one session.
    // A message that is only an attachment says nothing in words, so there is
    // nothing to retitle to: `titleFromTask("")` reads "untitled session",
    // which would replace a perfectly good title with a worse one for the
    // crime of pasting a screenshot without a caption.
    const retitled =
      kind === "continue" && message.trim().length > 0
        ? await this.#retitle(record, message)
        : record;
    if (active) {
      // A blocked session gets the message as its answer, not as an injection.
      // Injections are only drained at turn boundaries, and the question is
      // waiting mid-turn — queueing here would deadlock the two against each
      // other: the turn cannot reach a boundary until the question clears.
      // Prose beats the offered options, so it passes through verbatim.
      if (this.ctx.questions.settleCurrent(record.id, { kind: "replied", text: message })) {
        this.ctx.emit("session/dispatched", retitled, kind, message);
        return { record: retitled, done: active.done };
      }
      // Same trap, other seam: a session blocked on a *sibling* is equally
      // stuck mid-turn, so queueing here would swallow the user's message
      // until some other session happened to answer. The user outranks the
      // sibling — if they are telling this session something while it waits,
      // that is the answer, and the ask is released rather than left pending.
      const blockedOn = this.ctx.asks.outbound(record.id)[0];
      if (blockedOn) {
        this.ctx.asks.settle(blockedOn.requestId, {
          kind: "answered",
          text: `[answered by the user, not by ${blockedOn.toName}] ${message}`,
        });
        this.ctx.emit("session/dispatched", retitled, kind, message);
        return { record: retitled, done: active.done };
      }
      const images = this.#ingest(attachments);
      const deliveryId = newId("msg");
      const injection: Injection = {
        kind: "user",
        text: message,
        deliveryId,
        ...(images.length > 0 ? { images } : {}),
      };
      // Acceptance and consumption are different moments. A live driver only
      // reads this at its next injection boundary, which can be minutes away;
      // journal the accepted message now so every client can render it as
      // pending (and keep doing so through a reload).
      this.ctx.journal.append({
        sessionId: record.id,
        type: "user_message_queued",
        payload: {
          deliveryId,
          text: message,
          ...(images.length > 0 ? { images } : {}),
        },
      });
      active.injections.push(injection);
      this.ctx.emit("session/dispatched", retitled, kind, message);
      return { record: retitled, done: active.done };
    }
    this.ctx.store.db
      .update(schema.sessions)
      // Reviving un-shelves. A run that was archived and is now working again
      // has to be back on the rail: the alternative is a session spending
      // tokens somewhere the person cannot see it.
      .set({ status: "running", endedAt: null, archivedAt: null })
      .where(eq(schema.sessions.id, id))
      .run();
    const revived = this.get(id)!;
    this.ctx.emit("session/dispatched", revived, kind, message);
    return this.#startRun(revived, message, {
      task: message,
      ...(attachments !== undefined ? { attachments } : {}),
      driver: revived.driver,
      ...(revived.modelId ? { modelId: revived.modelId } : {}),
      ...(revived.effort ? { effort: revived.effort } : {}),
      ...(revived.fastMode ? { fastMode: true } : {}),
    });
  }

  async checkpointSession(
    id: SessionId,
    fromEventId: number,
    message: string,
    attachments?: AttachmentInput[],
  ): Promise<SessionHandle> {
    this.#requireIdle(id, "checkpoint");
    const events = this.ctx.journal.read({ sessionId: id });
    const previous = lastEditableMessage(events);
    if (previous === null || previous.eventId !== fromEventId) {
      throw new Error("the message changed before it could be checkpointed");
    }
    if (message.trim().length === 0 && (attachments?.length ?? 0) === 0) {
      throw new Error("a checkpoint message needs text or an image");
    }

    // A provider resume token points at the abandoned future. Retiring it
    // forces #beginRun to rebuild from the active journal branch instead.
    this.ctx.store.db.transaction((tx) => {
      tx
        .delete(schema.settings)
        .where(eq(schema.settings.key, this.#resumeKey(id)))
        .run();
      tx
        .delete(schema.settings)
        .where(eq(schema.settings.key, this.#modelUndoKey(id)))
        .run();
    });
    this.ctx.journal.append({
      sessionId: id,
      type: "session_checkpoint",
      payload: { fromEventId },
    });
    return this.continueSession(id, message, attachments);
  }

  nextMessages(id: SessionId): NextMessage[] {
    return (this.#nextMessages.get(id) ?? []).map((held) => held.view);
  }

  enqueueNextMessage(
    id: SessionId,
    message: string,
    attachments?: AttachmentInput[],
  ): NextMessage {
    const record = this.get(id);
    if (record === undefined) throw new Error(`unknown session "${id}"`);
    if (!this.#active.has(id) || !LIVE_STATUSES.includes(record.status)) {
      throw new Error("a next message can only wait behind a live run");
    }
    const images = this.#ingest(attachments);
    if (message.trim().length === 0 && images.length === 0) {
      throw new Error("a next message needs text or an image");
    }
    const normalized = images.map(
      (image): AttachmentInput => ({
        blobId: image.blobId,
        ...(image.alt !== undefined ? { alt: image.alt } : {}),
      }),
    );
    const view: NextMessage = {
      deliveryId: newId("msg"),
      message,
      images,
      createdAt: nowIso(),
      editing: false,
    };
    const queue = this.#nextMessages.get(id) ?? [];
    queue.push({ view, attachments: normalized });
    this.#nextMessages.set(id, queue);
    this.ctx.journal.append({
      sessionId: id,
      type: "user_message_deferred",
      payload: view,
    });
    return view;
  }

  #held(id: SessionId, deliveryId: string): HeldNextMessage {
    const held = this.#nextMessages
      .get(id)
      ?.find((candidate) => candidate.view.deliveryId === deliveryId);
    if (held === undefined) {
      throw new Error("that queued message is no longer waiting");
    }
    return held;
  }

  #announceUpdate(id: SessionId, held: HeldNextMessage): NextMessage {
    this.ctx.journal.append({
      sessionId: id,
      type: "user_message_updated",
      payload: held.view,
    });
    return held.view;
  }

  beginNextMessageEdit(id: SessionId, deliveryId: string): NextMessage {
    const held = this.#held(id, deliveryId);
    if (!held.view.editing) {
      held.view = { ...held.view, editing: true };
      this.#announceUpdate(id, held);
    }
    return held.view;
  }

  updateNextMessage(
    id: SessionId,
    deliveryId: string,
    message: string,
    attachments?: AttachmentInput[],
  ): NextMessage {
    const held = this.#held(id, deliveryId);
    if (!held.view.editing) throw new Error("claim the queued message before editing it");
    const images = this.#ingest(attachments);
    if (message.trim().length === 0 && images.length === 0) {
      throw new Error("a queued message needs text or an image");
    }
    held.attachments = images.map(
      (image): AttachmentInput => ({
        blobId: image.blobId,
        ...(image.alt !== undefined ? { alt: image.alt } : {}),
      }),
    );
    held.view = { ...held.view, message, images, editing: false };
    const updated = this.#announceUpdate(id, held);
    this.#releaseIfIdle(id);
    return updated;
  }

  cancelNextMessageEdit(id: SessionId, deliveryId: string): NextMessage {
    const held = this.#held(id, deliveryId);
    if (held.view.editing) {
      held.view = { ...held.view, editing: false };
      this.#announceUpdate(id, held);
    }
    this.#releaseIfIdle(id);
    return held.view;
  }

  cancelNextMessage(id: SessionId, deliveryId: string): boolean {
    const queue = this.#nextMessages.get(id);
    const at = queue?.findIndex((held) => held.view.deliveryId === deliveryId) ?? -1;
    if (queue === undefined || at < 0) return false;
    const [held] = queue.splice(at, 1);
    if (queue.length === 0) this.#nextMessages.delete(id);
    this.ctx.journal.append({
      sessionId: id,
      type: "user_message_cancelled",
      payload: { deliveryId: held!.view.deliveryId, reason: "cancelled by the user" },
    });
    this.#releaseIfIdle(id);
    return true;
  }

  /**
   * Release the held follow-up only after the active entry is gone.
   *
   * A killed run was stopped on purpose, and a failed run may fail again for
   * the same reason. Neither may silently restart. Successful completion is
   * the only terminal state that spends the queued follow-up.
   */
  #afterRun(id: SessionId): void {
    const status = this.get(id)?.status;
    if (status !== "completed") {
      this.#cancelQueue(id, `previous run ended ${status ?? "without a status"}`);
      return;
    }
    this.#releaseIfIdle(id);
  }

  #cancelQueue(id: SessionId, reason: string): void {
    const queue = this.#nextMessages.get(id) ?? [];
    this.#nextMessages.delete(id);
    for (const held of queue) {
      this.ctx.journal.append({
        sessionId: id,
        type: "user_message_cancelled",
        payload: { deliveryId: held.view.deliveryId, reason },
      });
    }
  }

  #releaseIfIdle(id: SessionId): void {
    if (this.#active.has(id) || this.get(id)?.status !== "completed") return;
    const queue = this.#nextMessages.get(id);
    const held = queue?.[0];
    if (queue === undefined || held === undefined || held.view.editing) return;
    queue.shift();
    if (queue.length === 0) this.#nextMessages.delete(id);

    this.ctx.journal.append({
      sessionId: id,
      type: "user_message_released",
      payload: { deliveryId: held.view.deliveryId },
    });
    queueMicrotask(() => {
      void this.continueSession(
        id,
        held.view.message,
        held.attachments,
      )
        .then((handle) => void handle.done.catch(() => undefined))
        .catch((error: unknown) => {
          this.#cancelQueue(id, "a queued message could not start");
          this.ctx.journal.append({
            sessionId: id,
            type: "driver_error",
            payload: { error: `next message could not start: ${String(error)}` },
          });
        });
    });
  }

  async deliver(
    id: SessionId,
    text: string,
    options: { kind?: Injection["kind"] } = {},
  ): Promise<DeliveryOutcome> {
    const kind = options.kind ?? "message";
    const record = this.get(id);
    if (!record) {
      return { kind: "gone", reason: `no session "${id}" in this project` };
    }
    const active = this.#active.get(id);
    if (active && !LIVE_STATUSES.includes(record.status)) {
      // Terminal row, run not yet retired — the same window `#deliverAsk`
      // guards. Queueing here would push text into a run that can never drain
      // it. `#active` is cleared in the run loop's `finally`, which completes
      // before `done` settles, so the retry sees an idle session.
      await active.done.catch(() => undefined);
      return this.deliver(id, text, options);
    }
    if (active) {
      const entry: Injection = { kind, text };
      active.injections.push(entry);
      // A run that has already taken its last turn boundary will never drain
      // this, and it would be lost without a sound: `#active` is not cleared
      // until the run loop's `finally`, so there is a window where a session
      // still looks live but can no longer read anything.
      //
      // The ask path survives that window by accident — an unanswered ask is
      // nudged when the target ends its turn, and the nudge redelivers. A
      // fire-and-forget send has no such retry, so it needs its own: if the
      // run retires without draining, wake the session instead. Redelivery
      // goes through `deliver`, so it is bounded by the wake budget rather
      // than able to spin.
      void active.done
        .catch(() => undefined)
        .then(() => {
          const at = active.injections.indexOf(entry);
          if (at < 0) return; // drained normally
          active.injections.splice(at, 1);
          void this.deliver(id, text, options).catch(() => undefined);
        });
      return { kind: "queued" };
    }
    if (!this.#mayWake(id)) {
      return {
        kind: "refused",
        reason: `${record.name} has been woken ${this.#wakeBudget} times without the user speaking to it, and will not be woken again until they do`,
      };
    }
    this.#spendWake(id);
    try {
      const handle = await this.continueSession(id, text, undefined, "message");
      // The revived run outlives this call; its failure belongs in the
      // target's own journal, not on the sender's stack.
      void handle.done.catch(() => undefined);
      return { kind: "woke" };
    } catch (error) {
      return { kind: "gone", reason: String(error) };
    }
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

  setArchived(id: SessionId, archived: boolean): SessionRecord {
    const record = this.#requireIdle(
      id,
      archived ? "archive" : "unarchive",
    );
    const archivedAt = archived ? nowIso() : null;
    this.ctx.store.db
      .update(schema.sessions)
      .set({ archivedAt })
      .where(eq(schema.sessions.id, id))
      .run();
    const updated: SessionRecord = { ...record, archivedAt };
    // Row first, then broadcast: nothing may observe the shelf state before it
    // is durable.
    this.ctx.emit("session/updated", updated);
    return updated;
  }

  /**
   * Re-point an idle thread at a different agent/model/effort/speed.
   *
   * The row update is the whole switch: every revive rebuilds its run from
   * `record.driver/modelId/effort/fastMode`, so nothing else has to know. The one
   * casualty is the active resume token — it is the *old* provider's handle,
   * keyed by session id alone, and the new provider would either choke on it
   * or, worse, accept it and overwrite it. It is set aside until the new run
   * starts so the switch can be undone; its absence from the active slot makes
   * `#beginRun` replay the journal for the incoming agent.
   */
  setModel(id: SessionId, change: ModelChange): SessionRecord {
    const record = this.#requireIdle(id, "switch the agent of");
    const driver = change.driver ?? record.driver;
    const modelId = change.modelId !== undefined ? change.modelId : record.modelId;
    const effort = change.effort !== undefined ? change.effort : record.effort;
    const driverChanged = driver !== record.driver;
    const target = this.ctx.drivers.get(driver);
    if (driverChanged && target === undefined) {
      // Validated here, not left to run start: a wrong model id fails one run
      // loudly, but an unknown driver would strand the thread un-runnable with
      // the mistake already durable.
      throw new Error(
        `driver "${driver}" is not registered (available: ${this.ctx.drivers.list().join(", ") || "none"})`,
      );
    }
    if (change.fastMode === true && target?.supportsFastMode !== true) {
      throw new Error(`driver "${driver}" does not support fast mode`);
    }
    // Fast mode is a provider capability, so crossing to a driver that does
    // not advertise it clears the flag instead of preserving an invisible,
    // ignored setting. Within one driver an omitted value keeps its state.
    const fastMode =
      target?.supportsFastMode === true
        ? change.fastMode !== undefined
          ? change.fastMode
          : driver === record.driver
            ? record.fastMode
            : false
        : false;
    if (
      driver === record.driver &&
      modelId === record.modelId &&
      effort === record.effort &&
      fastMode === record.fastMode
    ) {
      return record;
    }
    const resumeToken = driverChanged ? this.#loadResumeToken(id) : null;
    const undo: ModelUndoState = {
      from: {
        driver: record.driver,
        modelId: record.modelId,
        effort: record.effort,
        fastMode: record.fastMode,
      },
      resumeToken,
    };
    this.ctx.store.db.transaction((tx) => {
      tx
        .update(schema.sessions)
        .set({ driver, modelId, effort, fastMode })
        .where(eq(schema.sessions.id, id))
        .run();
      // A model choice is one action with one undo. Any later choice replaces
      // that action; only a cross-driver switch needs the context safeguard.
      tx
        .delete(schema.settings)
        .where(eq(schema.settings.key, this.#modelUndoKey(id)))
        .run();
      if (driverChanged) {
        tx
          .insert(schema.settings)
          .values({
            key: this.#modelUndoKey(id),
            valueJson: JSON.stringify(undo),
            updatedAt: nowIso(),
          })
          .run();
        tx
          .delete(schema.settings)
          .where(eq(schema.settings.key, this.#resumeKey(id)))
          .run();
      }
    });
    const updated = this.get(id)!;
    // Journaled so the transcript can say the agent changed at this point —
    // row first, then journal, then broadcast, same order as everything else.
    this.ctx.journal.append({
      sessionId: id,
      type: "model_changed",
      payload: {
        from: {
          driver: record.driver,
          modelId: record.modelId,
          effort: record.effort,
          fastMode: record.fastMode,
        },
        to: { driver, modelId, effort, fastMode },
        contextRebuilt: driverChanged,
      },
    });
    this.ctx.emit("session/updated", updated);
    return updated;
  }

  undoModelChange(id: SessionId): SessionRecord {
    const record = this.#requireIdle(id, "undo the context rebuild for");
    const row = this.ctx.store.db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, this.#modelUndoKey(id)))
      .get();
    if (row === undefined) {
      throw new Error(
        `there is no pending context rebuild to undo for ${record.name}`,
      );
    }
    const undo = JSON.parse(row.valueJson) as ModelUndoState;
    if (
      typeof undo?.from?.driver !== "string" ||
      !(
        undo.from.modelId === null || typeof undo.from.modelId === "string"
      ) ||
      !(undo.from.effort === null || typeof undo.from.effort === "string") ||
      !(
        undo.from.fastMode === undefined ||
        typeof undo.from.fastMode === "boolean"
      ) ||
      !(undo.resumeToken === null || typeof undo.resumeToken === "string")
    ) {
      throw new Error(`the saved context for ${record.name} cannot be restored`);
    }

    // Undo rows are intentionally short-lived, but one can survive an app
    // upgrade. A pre-fast-mode row has no key and means standard speed.
    const restored = { ...undo.from, fastMode: undo.from.fastMode ?? false };
    this.ctx.store.db.transaction((tx) => {
      tx
        .update(schema.sessions)
        .set(restored)
        .where(eq(schema.sessions.id, id))
        .run();
      tx
        .delete(schema.settings)
        .where(eq(schema.settings.key, this.#resumeKey(id)))
        .run();
      if (undo.resumeToken !== null) {
        tx
          .insert(schema.settings)
          .values({
            key: this.#resumeKey(id),
            valueJson: JSON.stringify(undo.resumeToken),
            updatedAt: nowIso(),
          })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: {
              valueJson: JSON.stringify(undo.resumeToken),
              updatedAt: nowIso(),
            },
          })
          .run();
      }
      tx
        .delete(schema.settings)
        .where(eq(schema.settings.key, this.#modelUndoKey(id)))
        .run();
    });

    const updated = this.get(id)!;
    this.ctx.journal.append({
      sessionId: id,
      type: "model_changed",
      payload: {
        from: {
          driver: record.driver,
          modelId: record.modelId,
          effort: record.effort,
          fastMode: record.fastMode,
        },
        to: restored,
        contextRebuilt: undo.resumeToken === null,
        undo: true,
      },
    });
    this.ctx.emit("session/updated", updated);
    return updated;
  }

  /**
   * Dispatch a new thread carrying this one's work: its journal replayed as a
   * transcript, or the summarizer's digest of it. A plain dispatch underneath,
   * so the new thread forks master, gets its own name and title from the
   * instruction line, and shows up everywhere a dispatched thread does.
   */
  async handoff(id: SessionId, request: HandoffRequest): Promise<SessionHandle> {
    const ctx = this.ctx;
    const source = this.get(id);
    if (source === undefined) throw new Error(`unknown session "${id}"`);
    const events = ctx.journal.read({ sessionId: id });
    let contextBlock: string;
    if (request.mode === "summary") {
      const reason =
        source.status === "failed" || source.status === "killed"
          ? source.status
          : "completed";
      const { summary } = await ctx.summarizer.sessionSummary({
        session: source,
        events,
        reason,
      });
      contextBlock = summary;
    } else {
      contextBlock = transcriptText(events);
    }
    // The instruction goes first because the title and name derive from the
    // task's opening line — a handoff titled after its boilerplate would read
    // as thirty identical threads.
    const instruction =
      request.task !== undefined && request.task.trim().length > 0
        ? request.task.trim()
        : `Take over the thread "${source.name}" (${source.title}) and continue its work.`;
    const task = [
      instruction,
      "",
      `## Handed off from thread "${source.name}"`,
      `original task: ${source.task}`,
      "",
      request.mode === "summary"
        ? "### Summary of its work"
        : "### Its transcript",
      contextBlock,
    ].join("\n");
    // The unspecified agent is the *source's*, not the project default: the
    // person is handing off this thread, and "same agent, fresh thread" is
    // the unsurprising reading. Model, effort and speed follow only while the driver
    // does — they are meaningless in another driver's vocabulary.
    const driver = request.driver ?? source.driver;
    const inherit = driver === source.driver;
    const modelId =
      request.modelId ?? (inherit ? source.modelId ?? undefined : undefined);
    const effort =
      request.effort ?? (inherit ? source.effort ?? undefined : undefined);
    const fastMode =
      request.fastMode ?? (inherit ? source.fastMode : undefined);
    const handle = await this.dispatch({
      task,
      driver,
      ...(modelId !== undefined ? { modelId } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
    });
    // Recorded on the source so its transcript names where the work went;
    // the reverse direction is already in the new thread's opening task.
    ctx.journal.append({
      sessionId: id,
      type: "handoff",
      payload: {
        toSessionId: handle.record.id,
        toName: handle.record.name,
        mode: request.mode,
      },
    });
    return handle;
  }

  /**
   * Purge a session: journal events, thread, thread entries, row.
   *
   * The order is load-bearing. Migration v4 scopes `journal_no_delete` to
   * journal rows whose session still exists, so the `sessions` row has to go
   * first or every event delete aborts. One transaction, so a failure part-way
   * cannot leave a session whose transcript is half gone.
   */
  remove(id: SessionId): SessionRecord {
    const record = this.#requireIdle(id, "delete");
    this.ctx.store.db.transaction((tx) => {
      tx.delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
      tx
        .delete(schema.journalEvents)
        .where(eq(schema.journalEvents.sessionId, id))
        .run();
      // The run's own forked thread. Master-thread entries *about* the session
      // are not touched: they are the project's memory, every later fork was
      // cut from that history, and rewriting it is the thing compaction is
      // copy-on-write to avoid.
      tx
        .delete(schema.threadEntries)
        .where(eq(schema.threadEntries.threadId, record.threadId))
        .run();
      tx.delete(schema.threads).where(eq(schema.threads.id, record.threadId)).run();
      tx
        .delete(schema.settings)
        .where(eq(schema.settings.key, this.#resumeKey(id)))
        .run();
      tx
        .delete(schema.settings)
        .where(eq(schema.settings.key, this.#modelUndoKey(id)))
        .run();
    });
    this.ctx.emit("session/deleted", record);
    return record;
  }

  /**
   * The record, or a throw naming why this session cannot be shelved or erased.
   *
   * Both callers refuse live sessions for the same reason: a running driver
   * holds this row and will write to it again. Archiving one hides work that is
   * still spending; deleting one races a process that is about to re-insert
   * journal events under an id that no longer exists.
   */
  #requireIdle(id: SessionId, verb: string): SessionRecord {
    const record = this.get(id);
    if (record === undefined) throw new Error(`unknown session: ${id}`);
    if (LIVE_STATUSES.includes(record.status) || this.#active.has(id)) {
      throw new Error(
        `cannot ${verb} ${record.name} while it is ${record.status}; stop it first`,
      );
    }
    return record;
  }

  #resumeKey(id: string): string {
    return `driver_resume:${id}`;
  }

  #modelUndoKey(id: string): string {
    return `model_undo:${id}`;
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

  /**
   * Start a run, and make sure a session that never got off the ground says so.
   *
   * Everything before the loop begins is synchronous and can throw — resolving
   * the driver, moving attachments into the blob store — and by the time we are
   * here the row already exists: dispatch inserted it, or a continue revived
   * it. Left alone, a throw would strand a session reading `running` with no
   * process running it, which nothing clears until the next boot's repair. The
   * error still reaches the caller; the record just stops lying in the meantime.
   */
  #startRun(
    record: SessionRecord,
    task: string,
    request: DispatchRequest,
  ): SessionHandle {
    try {
      return this.#beginRun(record, task, request);
    } catch (error) {
      this.ctx.journal.append({
        sessionId: record.id,
        type: "driver_error",
        payload: { error: String(error) },
      });
      this.#finish(
        record,
        "failed",
        `session failed to start: ${String(error)}`,
        "failed to start",
        { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      );
      throw error;
    }
  }

  #beginRun(
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
    // Release on abort, not merely when the run returns. `stop()` aborts and
    // then awaits `done` — but a run parked in `ask_user` cannot return until
    // the question settles, and the question would not settle until the run
    // returned. That is a deadlock, and it is why this listener exists rather
    // than relying on the release in the `finally` below.
    onAbort(
      (abort as unknown as { signal: AbortSignal }).signal,
      () => {
        ctx.questions.cancelSession(
          record.id,
          "the session was stopped before this was answered",
        );
      },
    );
    const active: ActiveRun = {
      abort,
      injections: [],
      done: undefined as unknown as Promise<SessionRecord>,
      stopping: false,
    };

    // Ingested once per run: the blob store is content-addressed, so this is
    // cheap on a re-run, and it fails loudly here rather than mid-turn.
    const taskImages = this.#ingest(request.attachments);

    // Starting the next run consumes a pending cross-driver switch. From this
    // point the new provider may append work of its own, so restoring the old
    // provider token would silently omit that work. Retire undo before any
    // driver code runs, including a run that fails during startup.
    this.ctx.store.db
      .delete(schema.settings)
      .where(eq(schema.settings.key, this.#modelUndoKey(record.id)))
      .run();
    const resumeToken = this.#loadResumeToken(record.id);
    // With a driver-native resume token the driver already holds the full
    // transcript; otherwise seed with the forked master-thread context.
    const context = resumeToken ? [] : ctx.threads.liveMessages(record.threadId);
    // A token-less run of a thread that has already spoken means the provider
    // holds none of its history — the agent was switched (setModel moves the
    // token aside) or the previous driver kept no state. Replay the journal so the
    // thread stays one conversation instead of restarting with amnesia. Fresh
    // dispatches have an empty journal, so this is [] exactly when it should be.
    const transcript = resumeToken
      ? []
      : transcriptMessages(ctx.journal.read({ sessionId: record.id }));

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

    // Registered before the run can emit anything. The first thing a driver
    // does may be a tool call, and a tool that asks about this session — or a
    // `continueSession` arriving from it — must not see its own run as idle
    // and start a second one.
    this.#active.set(record.id, active);

    active.done = (async (): Promise<SessionRecord> => {
      try {
        ctx.journal.append({
          sessionId: record.id,
          type: "session_started",
          payload: {
            // Snapshot the generated title with the cycle. The session row is
            // retitled on later continues, so reading it back cannot tell the
            // transcript what an older cycle was called.
            title: record.title,
            task,
            driver: record.driver,
            modelId: record.modelId,
            effort: record.effort,
            fastMode: record.fastMode,
            contextMessages: context.length,
            resumed: resumeToken !== null,
            ...(transcript.length > 0
              ? { transcriptMessages: transcript.length }
              : {}),
            ...(taskImages.length > 0 ? { images: taskImages } : {}),
          },
        });
        let result;
        try {
          result = await driver.run({
            resolveImage: (part) => this.#resolveImage(part),
            sessionId: record.id,
            workdir: ctx.store.rootPath,
            context,
            task,
            ...(taskImages.length > 0 ? { taskImages } : {}),
            modelId: record.modelId,
            effort: record.effort,
            fastMode: record.fastMode,
            tools: ctx.tools.list(),
            onEvent,
            drainInjections,
            signal: (abort as unknown as { signal: AbortSignal }).signal,
            permissionMode: request.permissionMode ?? "auto",
            resumeToken,
            ...(transcript.length > 0 ? { transcript } : {}),
          });
        } finally {
          // Released here rather than in the outer finally so the settle lands
          // before `session_ended` does. An abort mid-question tears the driver
          // down while the tool is still awaiting; without this the promise —
          // and the subprocess behind it — would outlive the run.
          ctx.questions.cancelSession(
            record.id,
            "the session ended before this was answered",
          );
        }
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
        this.#afterRun(record.id);
      }
    })();

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
      // The title can move while a run is active when the user redirects it.
      // Persist the final value as well as the opening snapshot so both cycle
      // boundaries remain truthful in the append-only transcript.
      payload: { status, title: final.title, tldr },
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
