import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, baseBundle, type BootResult } from "@daydream-code/boot";
import { SessionId, ThreadId } from "@daydream-code/shared";

/**
 * End-to-end: boot the real composed system (mock driver) against a temp
 * project and prove the master-thread model — dispatch entries, turn-end
 * write-back, sibling awareness, inter-session messages, recall tools,
 * compaction, journal immutability.
 */

let dirs: string[] = [];
let systems: BootResult[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ddc-e2e-"));
  dirs.push(dir);
  return dir;
}

async function bootProject(
  root: string,
  script: unknown[],
): Promise<BootResult> {
  const result = await boot({
    projectRoot: root,
    overrides: [
      { id: "driver-mock", disabled: false, config: { id: "mock", script } },
      { id: "driver-claude", disabled: true },
    ],
  });
  systems.push(result);
  return result;
}

afterEach(async () => {
  for (const system of systems) {
    await system.app.dispose(system.app.rootFiber).catch(() => undefined);
  }
  systems = [];
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  dirs = [];
});

describe("headless end-to-end (mock driver)", () => {
  it("boots the full base bundle with no pending fibers", async () => {
    const { app } = await bootProject(tempProject(), [{ turn: "hi" }]);
    const dump = app.dumpState();
    const notActive = dump.filter(
      (f) => f.state !== "active" && f.name !== "root",
    );
    expect(notActive, JSON.stringify(notActive, null, 2)).toEqual([]);
  });

  it("dispatch journals the run and writes dispatch/turn-end/summary to master", async () => {
    const { ctx } = await bootProject(tempProject(), [
      { turn: "working on it" },
      { turn: "done now" },
    ]);
    const handle = await ctx.sessions.dispatch({
      task: "test the harness",
      driver: "mock",
    });
    const final = await handle.done;
    expect(final.status).toBe("completed");
    expect(final.summary).toContain("mock summary");

    const events = ctx.journal.read({ sessionId: final.id });
    const types = events.map((e) => e.type);
    expect(types).toContain("session_started");
    expect(types).toContain("turn");
    expect(types).toContain("turn_end");
    expect(types).toContain("session_ended");

    const master = ctx.threads.ensureMaster();
    const entries = ctx.threads.entries(ThreadId(master.id));
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toContain("session_dispatch");
    expect(kinds).toContain("session_turn_end");
    expect(kinds).toContain("session_summary");
    const dispatch = entries.find((e) => e.kind === "session_dispatch")!;
    expect(dispatch.message.content).toContain(
      `new session ${final.id} with msg:`,
    );
    expect(dispatch.message.content).toContain("test the harness");
  });

  it("a second session sees the first session's activity (sibling awareness via fork)", async () => {
    const root = tempProject();
    const system = await bootProject(root, [{ turn: "first session did a thing" }]);
    const { ctx } = system;
    const first = await ctx.sessions.dispatch({
      task: "be the first",
      driver: "mock",
    });
    await first.done;

    // Second dispatch forks master AFTER first's entries exist.
    const second = await ctx.sessions.dispatch({
      task: "be the second",
      driver: "mock",
    });
    await second.done;
    const secondStart = ctx.journal
      .read({ sessionId: second.record.id })
      .find((e) => e.type === "session_started")!;
    expect(
      (secondStart.payload as { contextMessages: number }).contextMessages,
    ).toBeGreaterThan(0);

    const fork = ctx.threads.get(second.record.threadId)!;
    const context = ctx.threads.liveContext(second.record.threadId);
    const texts = context.map((e) =>
      typeof e.message.content === "string"
        ? e.message.content
        : JSON.stringify(e.message.content),
    );
    expect(fork.forkedFromThread).toBe(ctx.threads.ensureMaster().id);
    expect(texts.some((t) => t.includes(`new session ${first.record.id}`))).toBe(
      true,
    );
    expect(
      texts.some((t) => t.includes(`session ${first.record.id} ended`)),
    ).toBe(true);
  });

  it("post_to_master reaches a sibling as a master_injected block at its next turn", async () => {
    const root = tempProject();
    const system = await bootProject(root, []);
    const { ctx } = system;

    // Session A: posts a broadcast via the real tool, then keeps going for
    // two more turns so it survives long enough for assertions.
    const a = await ctx.sessions.dispatch({
      task: "post a note",
      driver: "mock",
    });
    // Mock driver script is fixed at mount; instead drive session B first and
    // use the tool surface directly to simulate A's post between B's turns.
    await a.done;
    const postTool = ctx.tools.get("post_to_master")!;
    await postTool.execute(
      { text: "heads up: schema migration in progress, avoid db/" },
      { sessionId: a.record.id, projectRoot: root },
    );

    const b = await ctx.sessions.dispatch({
      task: "receive the note",
      driver: "mock",
    });
    await b.done;
    // B forked after the post existed... the post was before B's fork, so it
    // arrives via fork context, not injection. Post ANOTHER note now and
    // continue B: continuation drains injections -> master_injected event.
    await postTool.execute(
      { text: "second note after B forked", to_session: b.record.id },
      { sessionId: a.record.id, projectRoot: root },
    );
    const revived = await ctx.sessions.continueSession(
      b.record.id,
      "check your messages",
    );
    await revived.done;

    const bEvents = ctx.journal.read({ sessionId: b.record.id });
    const injected = bEvents.filter((e) => e.type === "user_injected");
    const blob = JSON.stringify(injected.map((e) => e.payload));
    expect(blob).toContain("master thread update");
    expect(blob).toContain("second note after B forked");
  });

  it("recall tools read journal and master history", async () => {
    const root = tempProject();
    const { ctx } = await bootProject(root, [
      { turn: "a very distinctive turn xyzzy" },
    ]);
    const s = await ctx.sessions.dispatch({ task: "do xyzzy", driver: "mock" });
    await s.done;

    const search = ctx.tools.get("search_journal")!;
    const hits = (await search.execute(
      { query: "xyzzy" },
      { sessionId: s.record.id, projectRoot: root },
    )) as unknown[];
    expect(hits.length).toBeGreaterThan(0);

    const readMaster = ctx.tools.get("read_master_thread")!;
    const entries = (await readMaster.execute(
      {},
      { sessionId: s.record.id, projectRoot: root },
    )) as Array<{ kind: string }>;
    expect(entries.some((e) => e.kind === "session_dispatch")).toBe(true);
  });

  it("journal is immutable at the SQL layer", async () => {
    const { ctx } = await bootProject(tempProject(), [{ turn: "x" }]);
    const s = await ctx.sessions.dispatch({ task: "t", driver: "mock" });
    await s.done;
    expect(() =>
      ctx.store.sqlite
        .prepare("UPDATE journal_events SET type = 'tampered' WHERE id = 1")
        .run(),
    ).toThrow(/append-only/);
    expect(() =>
      ctx.store.sqlite.prepare("DELETE FROM journal_events").run(),
    ).toThrow(/append-only/);
  });

  it("compaction folds master when over budget; forks below the cut still resolve", async () => {
    const root = tempProject();
    const system = await bootProject(root, [{ turn: "hello" }]);
    const { ctx } = system;
    const master = ctx.threads.ensureMaster();

    // Fork BEFORE compaction exists.
    await ctx.sessions.dispatch({ task: "early fork", driver: "mock" }).then((h) => h.done);
    const early = ctx.sessions.list()[0]!;
    const earlyContextBefore = ctx.threads.liveContext(early.threadId).length;

    // Shrink the budget by patching the compactor config live: instead,
    // stuff master with big notes and rely on the 50k default? Too slow —
    // append a lot of large entries then call maybeCompact via a tiny-budget
    // second boot? Simplest honest path: append ~60k tokens of notes.
    const big = "x".repeat(4000); // ~1000 tokens each
    for (let i = 0; i < 60; i++) {
      ctx.threads.append({
        threadId: ThreadId(master.id),
        kind: "note",
        message: { role: "user", content: `note ${i}: ${big}` },
      });
    }
    const results = await ctx.compaction.maybeCompact(ThreadId(master.id));
    expect(results.length).toBe(1);
    const live = ctx.threads.liveContext(ThreadId(master.id));
    expect(live[0]!.kind).toBe("compaction");
    expect(ctx.tokens.estimateEntries(live)).toBeLessThan(55_000);
    // Raw history intact (copy-on-write):
    expect(
      ctx.threads.entries(ThreadId(master.id)).filter((e) => e.kind === "note")
        .length,
    ).toBe(60);
    // The early fork still resolves its pre-compaction view:
    expect(ctx.threads.liveContext(early.threadId).length).toBe(
      earlyContextBefore,
    );
  });

  it("continue on an ended session revives it with the resume path", async () => {
    const { ctx } = await bootProject(tempProject(), [{ turn: "first run" }]);
    const s = await ctx.sessions.dispatch({ task: "start", driver: "mock" });
    await s.done;
    const revived = await ctx.sessions.continueSession(
      s.record.id,
      "and again",
    );
    const final = await revived.done;
    expect(final.status).toBe("completed");
    const dispatches = ctx.threads
      .entries(ThreadId(ctx.threads.ensureMaster().id))
      .filter((e) => e.kind === "session_dispatch");
    expect(
      dispatches.some((d) =>
        String(d.message.content).includes("continue session"),
      ),
    ).toBe(true);
  });

  it("crash recovery marks stale running sessions killed on next boot", async () => {
    const root = tempProject();
    const first = await bootProject(root, [{ turn: "x" }]);
    const s = await first.ctx.sessions.dispatch({ task: "t", driver: "mock" });
    await s.done;
    // Fake a crash artifact: force the row back to running, then reboot.
    first.ctx.store.sqlite
      .prepare("UPDATE sessions SET status = 'running', ended_at = NULL")
      .run();
    await first.app.dispose(first.app.rootFiber);

    const second = await bootProject(root, [{ turn: "x" }]);
    const record = second.ctx.sessions.get(SessionId(s.record.id))!;
    expect(record.status).toBe("killed");
    const summaries = second.ctx.threads
      .entries(ThreadId(second.ctx.threads.ensureMaster().id))
      .filter(
        (e) => e.kind === "session_summary" && e.sessionId === s.record.id,
      );
    expect(summaries.length).toBeGreaterThanOrEqual(1);
  });
});
