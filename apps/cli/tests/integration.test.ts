import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, baseBundle, type BootResult } from "@daydream-code/boot";
import {
  SessionId,
  ThreadId,
  compareSessionRecency,
} from "@daydream-code/shared";

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

/** A real PNG header, so the sniffer reads genuine dimensions from it. */
function pngBytes(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.write("\x00\x00\x00\x0dIHDR", 8, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.from("pixels")]);
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
      `new session ${final.name} with msg:`,
    );
    expect(dispatch.message.content).toContain("test the harness");
  });

  it("names sessions from their task and numbers collisions", async () => {
    const { ctx } = await bootProject(tempProject(), [{ turn: "ok" }]);

    const first = await ctx.sessions.dispatch({
      task: "fix the failing tests",
      driver: "mock",
    });
    expect(first.record.name).toBe("fix-failing-tests");

    // Same task again — the name must stay unique within the project.
    const second = await ctx.sessions.dispatch({
      task: "fix the failing tests",
      driver: "mock",
    });
    expect(second.record.name).toBe("fix-failing-tests-2");

    // An explicit name is slugged, not taken verbatim.
    const third = await ctx.sessions.dispatch({
      task: "anything",
      name: "Ship The Release",
      driver: "mock",
    });
    expect(third.record.name).toBe("ship-release");

    await Promise.all([first.done, second.done, third.done]);
  });

  it("carries an attached image from dispatch through to the driver", async () => {
    const root = tempProject();
    const { ctx } = await bootProject(root, [{ turn: "looked at it" }]);
    const shot = join(root, "shot.png");
    writeFileSync(shot, pngBytes(1092, 800));

    const handle = await ctx.sessions.dispatch({
      task: "what is wrong in this screenshot?",
      driver: "mock",
      attachments: [{ path: shot }],
    });
    await handle.done;

    const attached = ctx.journal
      .read({ sessionId: handle.record.id })
      .find((e) => e.type === "images_attached");
    expect(attached).toBeDefined();
    const images = (attached!.payload as { images: Record<string, unknown>[] }).images;
    expect(images).toHaveLength(1);
    // Sniffed from the bytes, not guessed from the filename.
    expect(images[0]).toMatchObject({
      mediaType: "image/png",
      alt: "shot.png",
      width: 1092,
      height: 800,
    });

    // The driver got a real readable path inside the project — Codex needs
    // that, and its sandbox will not read outside the workspace.
    const path = images[0]!["path"] as string;
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(root)).toBe(true);
    expect(readFileSync(path)).toEqual(pngBytes(1092, 800));
  });

  it("stores images content-addressed, so the same paste costs one copy", async () => {
    const root = tempProject();
    const { ctx } = await bootProject(root, [{ turn: "ok" }]);
    const a = join(root, "a.png");
    const b = join(root, "b.png");
    writeFileSync(a, pngBytes(50, 50));
    writeFileSync(b, pngBytes(50, 50)); // identical bytes, different name

    const first = await ctx.sessions.dispatch({
      task: "one",
      driver: "mock",
      attachments: [{ path: a }],
    });
    await first.done;
    const second = await ctx.sessions.dispatch({
      task: "two",
      driver: "mock",
      attachments: [{ path: b }],
    });
    await second.done;

    const blobDir = join(root, ".daydream-code", "blobs");
    expect(readdirSync(blobDir)).toHaveLength(1);
  });

  it("attaches images to a mid-session message and prices them by pixels", async () => {
    const root = tempProject();
    const { ctx } = await bootProject(root, [{ turn: "first" }]);
    const handle = await ctx.sessions.dispatch({ task: "start", driver: "mock" });
    await handle.done;

    const shot = join(root, "later.png");
    writeFileSync(shot, pngBytes(300, 300));
    const continued = await ctx.sessions.continueSession(
      handle.record.id,
      "look at this",
      [{ path: shot }],
    );
    await continued.done;

    const attached = ctx.journal
      .read({ sessionId: handle.record.id })
      .filter((e) => e.type === "images_attached");
    expect(attached).toHaveLength(1);

    // A base64-derived estimate would have charged tens of thousands here.
    const estimate = ctx.tokens.estimateMessage({
      role: "user",
      content: [
        {
          type: "image",
          blobId: `${"c".repeat(64)}.png`,
          mediaType: "image/png",
          width: 300,
          height: 300,
        },
      ],
    });
    expect(estimate).toBe(124);
  });

  it("rejects a non-image attachment instead of sending it to the model", async () => {
    const root = tempProject();
    const { ctx } = await bootProject(root, [{ turn: "ok" }]);
    const notes = join(root, "notes.txt");
    writeFileSync(notes, "definitely not a png");

    await expect(
      ctx.sessions.dispatch({
        task: "read this",
        driver: "mock",
        attachments: [{ path: notes }],
      }),
    ).rejects.toThrow(/unsupported attachment/);
  });

  it("titles a session from its task, and retitles it when redirected", async () => {
    const { ctx } = await bootProject(tempProject(), [{ turn: "ok" }]);
    const handle = await ctx.sessions.dispatch({
      task: "fix the failing tests. start with auth.",
      driver: "mock",
    });
    await handle.done;
    expect(handle.record.title).toBe("fix the failing tests");
    expect(handle.record.name).toBe("fix-failing-tests");

    // A new instruction is the current task now — the title follows it.
    const continued = await ctx.sessions.continueSession(
      handle.record.id,
      "actually, update the changelog instead",
    );
    await continued.done;
    expect(continued.record.title).toBe(
      "actually, update the changelog instead",
    );

    // The name is an address: master-thread entries and links point at it, so
    // it must not drift when the title does.
    expect(continued.record.name).toBe("fix-failing-tests");
    expect(ctx.sessions.resolve("fix-failing-tests")?.id).toBe(handle.record.id);

    // And the change is durable, not just on the returned handle.
    expect(ctx.sessions.get(handle.record.id)?.title).toBe(
      "actually, update the changelog instead",
    );
    // The original dispatch task is preserved alongside the evolved title.
    expect(ctx.sessions.get(handle.record.id)?.task).toBe(
      "fix the failing tests. start with auth.",
    );
  });

  it("resolves sessions by name or id, and recall tools accept both", async () => {
    const { ctx } = await bootProject(tempProject(), [{ turn: "ok" }]);
    const handle = await ctx.sessions.dispatch({
      task: "audit the token budget",
      driver: "mock",
    });
    await handle.done;
    const { id, name } = handle.record;
    expect(name).toBe("audit-token-budget");

    expect(ctx.sessions.resolve(name)?.id).toBe(id);
    expect(ctx.sessions.resolve(id)?.id).toBe(id);
    expect(ctx.sessions.resolve("no-such-session")).toBeUndefined();

    // read_session is what the model reaches for after reading a master-thread
    // summary, which now names sessions rather than id-ing them.
    const readSession = ctx.tools.get("read_session")!;
    const run = { sessionId: id, projectRoot: "." };
    const byName = (await readSession.execute(
      { session_id: name },
      run,
    )) as unknown[];
    const byId = (await readSession.execute(
      { session_id: id },
      run,
    )) as unknown[];
    expect(byName.length).toBeGreaterThan(0);
    expect(byName).toEqual(byId);
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
    expect(texts.some((t) => t.includes(`new session ${first.record.name}`))).toBe(
      true,
    );
    expect(
      texts.some((t) => t.includes(`session ${first.record.name} ended`)),
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

  it("broadcasts that a sibling's turn ended, without its summary text", async () => {
    const root = tempProject();
    // The mock summary is built from the turn text, so this token appears in
    // A's summary but in neither session's task line.
    const { ctx } = await bootProject(root, [{ turn: "flibbertigibbet" }]);

    // B forks master first, so everything A writes lands after B's cut and has
    // to arrive by injection rather than through the fork context.
    const b = await ctx.sessions.dispatch({ task: "beta work", driver: "mock" });
    await b.done;
    const a = await ctx.sessions.dispatch({ task: "alpha work", driver: "mock" });
    const aRecord = await a.done;
    expect(aRecord.summary).toContain("flibbertigibbet"); // the token is real

    const revived = await ctx.sessions.continueSession(
      b.record.id,
      "keep going",
    );
    await revived.done;

    const injected = ctx.journal
      .read({ sessionId: b.record.id })
      .filter((e) => e.type === "user_injected");
    const blob = JSON.stringify(injected.map((e) => e.payload));

    expect(blob).toContain("master thread update");
    expect(blob).toContain(`session ${aRecord.name} turn end`);
    expect(blob).toContain(`session ${aRecord.name} ended (completed)`);
    expect(blob).toContain("read_session");
    // The dispatch line still carries the task verbatim; only summaries go.
    expect(blob).toContain(`new session ${aRecord.name} with msg:`);
    expect(blob).not.toContain("flibbertigibbet");
    expect(blob).not.toContain("mock summary");

    // ...but the master thread itself keeps the full text as the record.
    const entries = ctx.threads.entries(
      ThreadId(ctx.threads.ensureMaster().id),
    );
    const summary = entries.find(
      (e) => e.kind === "session_summary" && e.sessionId === aRecord.id,
    )!;
    expect(summary.message.content).toContain("flibbertigibbet");
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

  it("lists sessions most recently finished first, not most recently started", async () => {
    const { ctx } = await bootProject(tempProject(), [{ turn: "ok" }]);
    const alpha = await ctx.sessions.dispatch({ task: "alpha work", driver: "mock" });
    await alpha.done;
    const beta = await ctx.sessions.dispatch({ task: "beta work", driver: "mock" });
    await beta.done;
    // beta started last, so a start-time sort would put it on top. alpha then
    // does another turn and finishes after it.
    const revived = await ctx.sessions.continueSession(alpha.record.id, "more");
    await revived.done;

    const names = ctx.sessions.list().map((s) => s.name);
    expect(names).toEqual(["alpha-work", "beta-work"]);
    // The SQL order and the comparator the UIs sort with must not disagree.
    expect(names).toEqual(
      [...ctx.sessions.list()].sort(compareSessionRecency).map((s) => s.name),
    );
  });

  it("ranks a still-running session by its start time", async () => {
    const { ctx } = await bootProject(tempProject(), [{ turn: "ok" }]);
    const older = await ctx.sessions.dispatch({ task: "older done", driver: "mock" });
    await older.done;
    const newer = await ctx.sessions.dispatch({ task: "newer live", driver: "mock" });
    await newer.done;
    // Put the newer row back the way a mid-run session looks — ended_at NULL —
    // rather than racing a real run, so the fallback to start time is what is
    // under test and nothing here depends on timing.
    ctx.store.sqlite
      .prepare("UPDATE sessions SET status = 'running', ended_at = NULL WHERE id = ?")
      .run(newer.record.id as string);

    const rows = ctx.sessions.list();
    expect(rows.map((s) => s.name)).toEqual(["newer-live", "older-done"]);
    expect(rows[0]!.endedAt).toBe(null);
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
