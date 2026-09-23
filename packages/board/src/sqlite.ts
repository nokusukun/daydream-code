import { asc, eq, inArray } from "@daydream-code/store/drizzle";
import type { Context } from "@daydream-code/kernel";
import { schema } from "@daydream-code/store";
import {
  DeferredError,
  LIVE_STATUSES,
  newId,
  nowIso,
  titleFromTask,
  ProjectId,
  SessionId,
  type SessionRecord,
} from "@daydream-code/shared";
import type {
  AttachmentInput,
  ContinueRequest,
  DispatchRequest,
  SessionHandle,
} from "@daydream-code/session";
import type {} from "@daydream-code/session";
import type {} from "@daydream-code/journal";
import type {} from "@daydream-code/questions";
import type {} from "@daydream-code/blobs";
import {
  Board,
  BoardError,
  type BoardBlock,
  type BoardCard,
  type BoardColumn,
  type CardPatch,
  type CardRequest,
  type CreateCardInput,
  type Verdict,
  type VerdictInput,
} from "./index.js";

/**
 * The marker the board puts at the top of every evaluator's task. It is how
 * an evaluator session is tied back to its card *before* the dispatch
 * resolves: the mock driver can call `board_verdict` in the same tick the
 * session row appears, which is earlier than `beginEvaluation` gets to write
 * `evaluator_session_id`. The task is durable from the first instant, so it
 * is the tie that cannot race.
 */
export const EVALUATION_MARKER = /^\[board evaluation of card (\S+)\]/;

export function evaluationMarker(cardId: string): string {
  return `[board evaluation of card ${cardId}]`;
}

type Row = typeof schema.boardCards.$inferSelect;

/**
 * Default provider: sqlite rows, the column state machine, the queue pump,
 * and the two intercepts. See index.ts for what each move means.
 */
export default class BoardSqlite extends Board {
  static inject = ["store", "sessions", "questions", "journal", "blobs"] as const;

  /**
   * Dispatch requests this board made itself (a cleared card, an evaluator).
   * The intercept lets these through by identity; everything else becomes a
   * card. A WeakSet rather than a flag on the request, so the seam's request
   * type does not grow a field that means nothing to any other listener.
   */
  #owned = new WeakSet<object>();
  /** Sessions whose next idle continue is the board releasing a re-queued card. */
  #releasing = new Set<string>();
  /** Cards being force-started: their evaluator's end is not a failed evaluation. */
  #forcing = new Set<string>();
  /**
   * Evaluators whose card has moved on. A card can come back to Evaluating
   * (released from Blocked, re-queued by a follow-up) while its previous
   * evaluator is still finishing its turn; that session's end, and any late
   * verdict it tries, must not touch the new round. In memory only: across a
   * restart the runner has already killed every old evaluator.
   */
  #retired = new Set<string>();

  constructor(ctx: Context) {
    super(ctx);
    this.#repair();
    ctx.on(
      "session/pre-dispatch",
      (request: DispatchRequest, next: (r?: DispatchRequest) => Promise<SessionHandle>) =>
        this.#interceptDispatch(request, next),
    );
    ctx.on(
      "session/pre-continue",
      (request: ContinueRequest, next: (r?: ContinueRequest) => Promise<SessionHandle>) =>
        this.#interceptContinue(request, next),
    );
    ctx.on("session/updated", (session: SessionRecord) => this.#onUpdated(session));
    ctx.on("session/ended", (session: SessionRecord) => this.#onEnded(session));
    ctx.on("session/deleted", (session: SessionRecord) => this.#onDeleted(session));
    this.#pump();
  }

  // -------------------------------------------------------------------------
  // Reads

  list(): BoardCard[] {
    const rows = this.ctx.store.db
      .select()
      .from(schema.boardCards)
      .where(eq(schema.boardCards.projectId, this.#projectId))
      .orderBy(asc(schema.boardCards.position))
      .all();
    const blocks = this.#blocksFor(rows.map((r) => r.id));
    return rows.map((row) => this.#toCard(row, blocks.get(row.id) ?? []));
  }

  get(id: string): BoardCard | undefined {
    const row = this.#row(id);
    return row ? this.#toCard(row, this.#blocksFor([id]).get(id) ?? []) : undefined;
  }

  forSession(sessionId: SessionId): BoardCard | undefined {
    const row = this.ctx.store.db
      .select()
      .from(schema.boardCards)
      .where(eq(schema.boardCards.sessionId, sessionId))
      .get();
    return row ? this.get(row.id) : undefined;
  }

  forEvaluator(sessionId: SessionId): BoardCard | undefined {
    if (this.#retired.has(sessionId)) return undefined;
    const row = this.ctx.store.db
      .select()
      .from(schema.boardCards)
      .where(eq(schema.boardCards.evaluatorSessionId, sessionId))
      .get();
    if (row) return this.get(row.id);
    // Not linked yet — see EVALUATION_MARKER. Only an unlinked card can be
    // claimed this way: once a round has its evaluator, a session carrying
    // the marker from an earlier round is a stranger.
    const record = this.ctx.sessions.get(sessionId);
    const match = record?.task.match(EVALUATION_MARKER);
    const card = match ? this.get(match[1]!) : undefined;
    return card?.evaluatorSessionId === null ? card : undefined;
  }

  // -------------------------------------------------------------------------
  // Writes a person makes

  create(input: CreateCardInput): BoardCard {
    const now = nowIso();
    const id = newId("card");
    const request = this.#durableRequest(input.request ?? {});
    this.ctx.store.db
      .insert(schema.boardCards)
      .values({
        id,
        projectId: this.#projectId,
        column: input.draft === true ? "draft" : "queued",
        position: this.#tailPosition(),
        title: titleFromTask(input.task),
        task: input.task,
        requestJson: JSON.stringify(request),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const card = this.get(id)!;
    this.ctx.emit("board/moved", card, null);
    this.#pump();
    return card;
  }

  update(id: string, patch: CardPatch): BoardCard {
    const card = this.#require(id);
    this.#allow(card, ["draft", "queued"], "edit");
    const task = patch.task ?? card.task;
    const request =
      patch.request !== undefined ? this.#durableRequest(patch.request) : card.request;
    this.#write(id, {
      task,
      title: card.sessionId === null ? titleFromTask(task) : card.title,
      requestJson: JSON.stringify(request),
    });
    return this.get(id)!;
  }

  submit(id: string): BoardCard {
    const card = this.#require(id);
    this.#allow(card, ["draft"], "submit");
    const moved = this.#move(card, "queued");
    this.#pump();
    return moved;
  }

  reorder(id: string, before: string | null): BoardCard {
    const card = this.#require(id);
    this.#allow(card, ["draft", "queued", "blocked"], "reorder");
    let position: number;
    if (before === null) {
      position = this.#tailPosition();
    } else {
      const target = this.#require(before);
      if (target.id === card.id) return card;
      // Midpoint between the target and whatever sits just above it, over
      // every card regardless of column: the queue order is one sequence and
      // a card released from Blocked keeps the place it had.
      const above = this.ctx.store.db
        .select({ position: schema.boardCards.position })
        .from(schema.boardCards)
        .where(eq(schema.boardCards.projectId, this.#projectId))
        .orderBy(asc(schema.boardCards.position))
        .all()
        .map((r) => r.position)
        .filter((p) => p < target.position && p !== card.position)
        .at(-1);
      position = above === undefined ? target.position - 1 : (above + target.position) / 2;
    }
    this.#write(id, { position });
    const moved = this.get(id)!;
    this.ctx.emit("board/moved", moved, moved.column);
    return moved;
  }

  async start(id: string): Promise<BoardCard> {
    const card = this.#require(id);
    this.#allow(card, ["queued", "evaluating", "blocked"], "start");
    this.#forcing.add(id);
    try {
      if (card.column === "evaluating" && card.evaluatorSessionId !== null) {
        // Not awaited: a force start should not wait for a driver to die,
        // and the evaluator's end is harmless once the card has left
        // Evaluating ( checks the column, not just the link).
        void this.ctx.sessions.stop(card.evaluatorSessionId).catch(() => undefined);
      }
      this.#clearBlocks(id);
      return await this.#launch(this.get(id)!);
    } finally {
      this.#forcing.delete(id);
    }
  }

  setBlockers(
    id: string,
    blockers: Array<{ sessionId: SessionId; reason?: string }>,
  ): BoardCard {
    const card = this.#require(id);
    this.#allow(card, ["queued", "blocked"], "edit the blockers of");
    for (const blocker of blockers) this.#requireWorking(blocker.sessionId);
    this.#clearBlocks(id);
    this.#addBlocks(
      id,
      blockers.map((b) => ({
        sessionId: b.sessionId,
        source: "user" as const,
        reason: b.reason ?? null,
      })),
    );
    if (blockers.length === 0) {
      const moved = this.#move(this.get(id)!, "queued");
      this.#pump();
      return moved;
    }
    return this.#move(this.get(id)!, "blocked");
  }

  cancel(id: string): BoardCard {
    const card = this.#require(id);
    this.#allow(card, ["draft", "queued", "blocked"], "cancel");
    this.#delete(card);
    return card;
  }

  // -------------------------------------------------------------------------
  // Writes the evaluator makes

  async beginEvaluation(id: string, request: DispatchRequest): Promise<SessionHandle> {
    const card = this.#require(id);
    this.#allow(card, ["evaluating"], "evaluate");
    const marker = evaluationMarker(id);
    const owned: DispatchRequest = {
      ...request,
      task: EVALUATION_MARKER.test(request.task)
        ? request.task
        : `${marker}\n\n${request.task}`,
    };
    this.#owned.add(owned);
    const handle = await this.ctx.sessions.dispatch(owned);
    // The verdict may already have landed (see EVALUATION_MARKER); a stale
    // link would then point a Working card at an evaluator it no longer has.
    const fresh = this.get(id);
    if (
      fresh?.column === "evaluating" &&
      fresh.evaluatorSessionId === null &&
      !this.#retired.has(handle.record.id)
    ) {
      this.#write(id, { evaluatorSessionId: handle.record.id });
      // …and the evaluator may already have *ended* without a verdict, in
      // which case `#onEnded` found no link and did nothing.
      const record = this.ctx.sessions.get(handle.record.id);
      if (record && !LIVE_STATUSES.includes(record.status)) this.#onEnded(record);
    }
    return handle;
  }

  async verdict(id: string, input: VerdictInput, from: SessionId): Promise<BoardCard> {
    const card = this.#require(id);
    if (card.column !== "evaluating") {
      throw new BoardError(
        "illegal-move",
        `card ${id} is ${card.column}, not evaluating; its verdict is no longer wanted`,
      );
    }
    const evaluator = this.forEvaluator(from);
    if (evaluator?.id !== id) {
      throw new BoardError(
        "not-evaluator",
        `session ${from} is not the evaluator of card ${id}`,
      );
    }
    const at = nowIso();
    switch (input.decision) {
      case "proceed": {
        this.#write(id, {
          verdictJson: JSON.stringify({ ...input, at } satisfies Verdict),
          evaluatorSessionId: from,
        });
        return this.#launch(this.get(id)!);
      }
      case "block": {
        const sessions = input.blockedBy.map((name) => this.#resolveWorking(name));
        if (sessions.length === 0) {
          throw new BoardError("bad-blocker", "a block verdict must name at least one Working session");
        }
        this.#clearBlocks(id);
        this.#addBlocks(
          id,
          sessions.map((s) => ({ sessionId: s.id, source: "evaluator" as const, reason: input.reason })),
        );
        this.#write(id, {
          verdictJson: JSON.stringify({ ...input, blockedBy: sessions.map((s) => s.name), at } satisfies Verdict),
          evaluatorSessionId: from,
        });
        return this.#move(this.get(id)!, "blocked");
      }
      case "defer": {
        const target = this.get(input.deferTo);
        if (target === undefined || target.column !== "evaluating" || target.position >= card.position) {
          const ahead = this.list()
            .filter((c) => c.column === "evaluating" && c.position < card.position)
            .map((c) => c.id);
          throw new BoardError(
            "bad-defer",
            `"${input.deferTo}" is not an Evaluating card ahead of ${id} in the queue` +
              (ahead.length > 0 ? `; those are: ${ahead.join(", ")}` : "; there are none, so decide now"),
          );
        }
        this.#write(id, {
          verdictJson: JSON.stringify({ ...input, at } satisfies Verdict),
          evaluatorSessionId: from,
        });
        // Back to Queued with the defer on record; `#pump` skips it until
        // the target leaves Evaluating.
        return this.#move(this.get(id)!, "queued");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Intercepts

  #interceptDispatch(
    request: DispatchRequest,
    next: (r?: DispatchRequest) => Promise<SessionHandle>,
  ): Promise<SessionHandle> {
    if (this.#owned.has(request)) return next();
    const { task, ...rest } = request;
    const card = this.create({ task, request: rest });
    throw new DeferredError(card.id, "card", `queued on the board as card ${card.id}`);
  }

  #interceptContinue(
    request: ContinueRequest,
    next: (r?: ContinueRequest) => Promise<SessionHandle>,
  ): Promise<SessionHandle> {
    if (this.#releasing.delete(request.id)) return next();
    // Sibling traffic is the existing protocol and is not new work: an ask
    // routed through evaluation would park the asker behind a queue it is
    // itself part of.
    if (request.kind !== "continue") return next();
    const card = this.forSession(request.id);
    if (card === undefined || card.column !== "done") return next();
    const attachments = this.#durableAttachments(request.attachments);
    this.#write(card.id, {
      task: request.message,
      requestJson: JSON.stringify({
        ...card.request,
        ...(attachments !== undefined ? { attachments } : {}),
      } satisfies CardRequest),
      // A follow-up is new work: it joins the back of the queue.
      position: this.#tailPosition(),
      verdictJson: null,
    });
    // On the session's own transcript, so the message shows as pending there
    // and not only on the board.
    this.ctx.journal.append({
      sessionId: request.id,
      type: "user_message_deferred",
      payload: { text: request.message, cardId: card.id },
    });
    this.#move(this.get(card.id)!, "queued");
    this.#pump();
    throw new DeferredError(card.id, "card", `re-queued on the board as card ${card.id}`);
  }

  // -------------------------------------------------------------------------
  // Session lifecycle

  #onUpdated(session: SessionRecord): void {
    const card = this.forSession(session.id);
    if (card === undefined) return;
    if (session.status === "waiting") {
      // Only a question for a *person* is attention. A session waiting on a
      // sibling is still working as far as the board is concerned.
      if (card.column === "working" && this.ctx.questions.current(session.id) !== undefined) {
        this.#move(card, "attention", "waiting on a question for you");
      }
      return;
    }
    if (session.status === "running" && (card.column === "attention" || card.column === "done")) {
      this.#move(card, "working");
    }
  }

  #onEnded(session: SessionRecord): void {
    this.#releaseBlocker(session.id, `session ${session.name} ${session.status}`);
    const card = this.forSession(session.id);
    if (card !== undefined && card.column === "working") {
      if (session.status === "completed") this.#move(card, "done");
      else this.#move(card, "attention", `session ${session.name} ${session.status}: ${session.tldr ?? "no summary"}`);
    }
    const evaluating = this.forEvaluator(session.id);
    if (
      evaluating !== undefined &&
      evaluating.column === "evaluating" &&
      !this.#forcing.has(evaluating.id)
    ) {
      this.#write(evaluating.id, { evaluatorSessionId: session.id });
      this.#move(
        this.get(evaluating.id)!,
        "attention",
        `evaluator ended without a verdict (${session.status}): ${session.tldr ?? "no summary"}`,
      );
    }
  }

  #onDeleted(session: SessionRecord): void {
    this.#releaseBlocker(session.id, `session ${session.name} deleted`);
    const card = this.forSession(session.id);
    if (card !== undefined) this.#delete(card);
  }

  /**
   * Boot repair. The runner has already turned every session that was live
   * at the crash into `killed` and emitted nothing this plugin could hear.
   */
  #repair(): void {
    for (const card of this.list()) {
      if (card.column === "evaluating") {
        // Nothing about the card is half-done; only the evaluator died.
        this.#move(card, "queued");
        continue;
      }
      if (card.column === "working" && card.sessionId !== null) {
        const session = this.ctx.sessions.get(card.sessionId);
        if (session === undefined) this.#delete(card);
        else if (session.status === "completed") this.#move(card, "done");
        else if (!LIVE_STATUSES.includes(session.status)) {
          this.#move(card, "attention", `session ${session.name} ${session.status} across a restart`);
        }
      }
    }
    // Blockers that are no longer Working release their cards.
    const blocks = this.ctx.store.db.select().from(schema.boardBlocks).all();
    for (const blockerId of new Set(blocks.map((b) => b.blockerSessionId))) {
      const session = this.ctx.sessions.get(SessionId(blockerId));
      if (session === undefined || !LIVE_STATUSES.includes(session.status)) {
        this.#releaseBlocker(blockerId, "blocker is no longer running");
      }
    }
  }

  // -------------------------------------------------------------------------
  // The machine

  /** Move every Queued card that is not deferring into Evaluating. */
  #pump(): void {
    const cards = this.list();
    const evaluating = new Set(cards.filter((c) => c.column === "evaluating").map((c) => c.id));
    for (const card of cards) {
      if (card.column !== "queued") continue;
      if (card.verdict?.decision === "defer" && evaluating.has(card.verdict.deferTo)) continue;
      this.#move(card, "evaluating");
    }
  }

  async #launch(card: BoardCard): Promise<BoardCard> {
    let handle: SessionHandle;
    if (card.sessionId !== null) {
      this.#releasing.add(card.sessionId);
      try {
        handle = await this.ctx.sessions.continueSession(
          card.sessionId,
          card.task,
          card.request.attachments,
        );
      } finally {
        this.#releasing.delete(card.sessionId);
      }
    } else {
      const request: DispatchRequest = { task: card.task, ...card.request };
      this.#owned.add(request);
      handle = await this.ctx.sessions.dispatch(request);
    }
    void handle.done.catch(() => undefined);
    this.#write(card.id, {
      sessionId: handle.record.id,
      title: handle.record.title,
      attentionReason: null,
    });
    const moved = this.#move(this.get(card.id)!, "working");
    // The run may have raced ahead of the link (a scripted driver finishes in
    // a tick); catch up on anything `#onUpdated`/`#onEnded` missed.
    const record = this.ctx.sessions.get(handle.record.id);
    if (record !== undefined) {
      if (LIVE_STATUSES.includes(record.status)) this.#onUpdated(record);
      else this.#onEnded(record);
    }
    return this.get(card.id) ?? moved;
  }

  #releaseBlocker(sessionId: string, why: string): void {
    const affected = this.ctx.store.db
      .select({ cardId: schema.boardBlocks.cardId })
      .from(schema.boardBlocks)
      .where(eq(schema.boardBlocks.blockerSessionId, sessionId))
      .all()
      .map((r) => r.cardId);
    if (affected.length === 0) return;
    this.ctx.store.db
      .delete(schema.boardBlocks)
      .where(eq(schema.boardBlocks.blockerSessionId, sessionId))
      .run();
    for (const id of new Set(affected)) {
      const card = this.get(id);
      if (card === undefined || card.column !== "blocked") continue;
      if (card.blockedBy.length > 0) {
        // Still blocked by someone else; say so on the stream all the same.
        this.ctx.emit("board/moved", card, "blocked");
        continue;
      }
      // Released cards re-evaluate: what is live has changed since the verdict.
      this.#write(id, { attentionReason: why });
      this.#move(this.get(id)!, "queued");
    }
    this.#pump();
  }

  #move(card: BoardCard, to: BoardColumn, attentionReason: string | null = null): BoardCard {
    // Entering Evaluating starts a fresh round: the previous evaluator, if
    // any, is retired and the link cleared so the evaluator plugin (which
    // acts on unlinked Evaluating cards) picks the card up again.
    const rounds = to === "evaluating" || card.column === "evaluating";
    if (rounds && card.evaluatorSessionId !== null) this.#retired.add(card.evaluatorSessionId);
    this.#write(card.id, {
      column: to,
      attentionReason,
      ...(to === "evaluating" ? { evaluatorSessionId: null } : {}),
    });
    const moved = this.get(card.id)!;
    this.ctx.emit("board/moved", moved, card.column);
    // Leaving Evaluating may unblock a deferred card waiting on this one.
    if (card.column === "evaluating" && to !== "evaluating") this.#pump();
    return moved;
  }

  #delete(card: BoardCard): void {
    this.#clearBlocks(card.id);
    this.ctx.store.db.delete(schema.boardCards).where(eq(schema.boardCards.id, card.id)).run();
    this.ctx.emit("board/removed", card);
    this.#pump();
  }

  // -------------------------------------------------------------------------
  // Helpers

  get #projectId(): string {
    return this.ctx.store.project.id;
  }

  #row(id: string): Row | undefined {
    return this.ctx.store.db
      .select()
      .from(schema.boardCards)
      .where(eq(schema.boardCards.id, id))
      .get();
  }

  #require(id: string): BoardCard {
    const card = this.get(id);
    if (card === undefined) throw new BoardError("not-found", `unknown card: ${id}`);
    return card;
  }

  #allow(card: BoardCard, columns: BoardColumn[], verb: string): void {
    if (!columns.includes(card.column)) {
      throw new BoardError(
        "illegal-move",
        `cannot ${verb} card ${card.id}: it is ${card.column}, and only ${columns.join("/")} cards can be`,
      );
    }
  }

  #write(id: string, patch: Partial<typeof schema.boardCards.$inferInsert>): void {
    this.ctx.store.db
      .update(schema.boardCards)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(schema.boardCards.id, id))
      .run();
  }

  #tailPosition(): number {
    const rows = this.ctx.store.db
      .select({ position: schema.boardCards.position })
      .from(schema.boardCards)
      .where(eq(schema.boardCards.projectId, this.#projectId))
      .all();
    return rows.reduce((max, r) => Math.max(max, r.position), 0) + 1;
  }

  #blocksFor(cardIds: string[]): Map<string, BoardBlock[]> {
    const grouped = new Map<string, BoardBlock[]>();
    if (cardIds.length === 0) return grouped;
    const rows = this.ctx.store.db
      .select()
      .from(schema.boardBlocks)
      .where(inArray(schema.boardBlocks.cardId, cardIds))
      .all();
    for (const row of rows) {
      const list = grouped.get(row.cardId) ?? [];
      list.push({
        blockerSessionId: SessionId(row.blockerSessionId),
        blockerName: this.ctx.sessions.get(SessionId(row.blockerSessionId))?.name ?? row.blockerSessionId,
        source: row.source,
        reason: row.reason,
        createdAt: row.createdAt,
      });
      grouped.set(row.cardId, list);
    }
    return grouped;
  }

  #clearBlocks(cardId: string): void {
    this.ctx.store.db.delete(schema.boardBlocks).where(eq(schema.boardBlocks.cardId, cardId)).run();
  }

  #addBlocks(
    cardId: string,
    blocks: Array<{ sessionId: SessionId; source: "evaluator" | "user"; reason: string | null }>,
  ): void {
    const now = nowIso();
    for (const block of blocks) {
      this.ctx.store.db
        .insert(schema.boardBlocks)
        .values({
          cardId,
          blockerSessionId: block.sessionId,
          source: block.source,
          reason: block.reason,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
  }

  /** Every session a card may be blocked by: those of Working cards. */
  #working(): SessionRecord[] {
    return this.list()
      .filter((c) => c.column === "working" && c.sessionId !== null)
      .map((c) => this.ctx.sessions.get(c.sessionId!))
      .filter((s): s is SessionRecord => s !== undefined);
  }

  #requireWorking(sessionId: SessionId): SessionRecord {
    const session = this.#working().find((s) => s.id === sessionId);
    if (session === undefined) {
      throw new BoardError(
        "bad-blocker",
        `${sessionId} is not the session of a Working card` + this.#workingHint(),
      );
    }
    return session;
  }

  #resolveWorking(name: string): SessionRecord {
    const record = this.ctx.sessions.resolve(name);
    const working = record === undefined ? undefined : this.#working().find((s) => s.id === record.id);
    if (working === undefined) {
      throw new BoardError(
        "bad-blocker",
        `"${name}" is not a Working session, so it cannot block` + this.#workingHint(),
      );
    }
    return working;
  }

  #workingHint(): string {
    const names = this.#working().map((s) => s.name);
    return names.length > 0
      ? `; Working sessions right now: ${names.join(", ")}`
      : "; nothing is Working right now, so nothing can block";
  }

  /**
   * Attachments become blob references before they are stored: a card can
   * wait for hours, and a base64 image in a row that every board read
   * returns is exactly the bloat `drafts.ts` keeps out of localStorage.
   */
  #durableRequest(request: CardRequest): CardRequest {
    const attachments = this.#durableAttachments(request.attachments);
    return {
      ...request,
      ...(attachments !== undefined ? { attachments } : {}),
    };
  }

  #durableAttachments(
    attachments: AttachmentInput[] | undefined,
  ): AttachmentInput[] | undefined {
    if (attachments === undefined) return undefined;
    return attachments.map((attachment): AttachmentInput => {
      if ("blobId" in attachment) return attachment;
      const ref =
        "path" in attachment
          ? this.ctx.blobs.putFile(attachment.path)
          : this.ctx.blobs.put(Buffer.from(attachment.data, "base64"), attachment.alt);
      const alt = "alt" in attachment ? attachment.alt : undefined;
      return { blobId: ref.id, ...(alt !== undefined ? { alt } : {}) };
    });
  }

  #toCard(row: Row, blockedBy: BoardBlock[]): BoardCard {
    return {
      id: row.id,
      projectId: ProjectId(row.projectId),
      column: row.column,
      position: row.position,
      title: row.title,
      task: row.task,
      request: JSON.parse(row.requestJson) as CardRequest,
      sessionId: row.sessionId === null ? null : SessionId(row.sessionId),
      evaluatorSessionId: row.evaluatorSessionId === null ? null : SessionId(row.evaluatorSessionId),
      blockedBy,
      attentionReason: row.attentionReason,
      verdict: row.verdictJson === null ? null : (JSON.parse(row.verdictJson) as Verdict),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
