import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootResult } from "@daydream-code/boot";
import { SessionId, type JournalEvent } from "@daydream-code/shared";

/**
 * End-to-end for the recall tools, through the real composed system with the
 * mock driver.
 *
 * The mock journals `tool_call` with its full arguments *before* awaiting
 * `tool.execute`, which is the same order the Claude adapter emits in — so the
 * self-match these tests pin is the real one, not a staged one.
 */

let dirs: string[] = [];
let systems: BootResult[] = [];

/** A string that exists nowhere in the corpus except where a test puts it. */
const TOKEN = "zqx-marker-4417";

async function bootProject(script: unknown[]): Promise<BootResult> {
  const dir = mkdtempSync(join(tmpdir(), "ddc-recall-"));
  dirs.push(dir);
  const result = await boot({
    projectRoot: dir,
    overrides: [
      { id: "driver-mock", disabled: false, config: { id: "mock", script } },
      { id: "driver-claude", disabled: true },
    ],
  });
  systems.push(result);
  return result;
}

/** The result payload of the nth tool_result in a session's journal. */
function toolResults(events: JournalEvent[]): unknown[] {
  return events
    .filter((e) => e.type === "tool_result")
    .map((e) => (e.payload as { result: unknown }).result);
}

afterEach(async () => {
  for (const system of systems) {
    await system.app.dispose(system.app.rootFiber).catch(() => undefined);
  }
  systems = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("search_journal self-exclusion", () => {
  it("does not match the call that invoked it", async () => {
    const { ctx } = await bootProject([
      { tool: "search_journal", args: { query: TOKEN } },
    ]);
    const handle = await ctx.sessions.dispatch({ task: "search", driver: "mock" });
    await handle.done;

    const events = ctx.journal.read({ sessionId: handle.record.id });
    // The bug this pins: the call's own arguments are in the corpus.
    const ownCall = events.find(
      (e) =>
        e.type === "tool_call" && JSON.stringify(e.payload).includes(TOKEN),
    );
    expect(ownCall).toBeDefined();

    const [hits] = toolResults(events) as Array<Array<{ eventId: number }>>;
    expect(hits).toEqual([]);
  });

  it("still returns a sibling session's events, including recent ones", async () => {
    const { ctx } = await bootProject([
      { tool: "search_journal", args: { query: TOKEN } },
    ]);
    const sibling = SessionId("ses_sibling");
    const planted = ctx.journal.append({
      sessionId: sibling,
      type: "turn",
      payload: { text: `decided on ${TOKEN}` },
    });

    const handle = await ctx.sessions.dispatch({ task: "search", driver: "mock" });
    await handle.done;

    const [hits] = toolResults(
      ctx.journal.read({ sessionId: handle.record.id }),
    ) as Array<Array<{ eventId: number; sessionId: string }>>;
    // Scoped exclusion: only the caller's own tail is hidden. A cutoff applied
    // globally would have swallowed this too.
    expect(hits.map((h) => h.eventId)).toEqual([planted.id]);
    expect(hits[0]!.sessionId).toBe(sibling);
  });

  /**
   * The exact edge of the guarantee, pinned deliberately.
   *
   * The cutoff hides the invoking step and everything after it. A search the
   * same session ran *earlier* is genuinely before that line, so it still
   * comes back — its snippet is that session's own old query. That is an echo
   * rather than a finding, and it grows with the number of searches, but
   * suppressing it means filtering on the *content* of a hit rather than its
   * position, which is a different rule than the one this cutoff implements.
   * Left as it is on purpose; this test is here so a change to it is a choice.
   */
  it("hides the invoking call but not the session's earlier searches", async () => {
    const { ctx } = await bootProject([
      { tool: "search_journal", args: { query: TOKEN } },
      { tool: "search_journal", args: { query: TOKEN } },
    ]);
    const handle = await ctx.sessions.dispatch({ task: "search", driver: "mock" });
    await handle.done;

    const events = ctx.journal.read({ sessionId: handle.record.id });
    const calls = events.filter(
      (e) =>
        e.type === "tool_call" && JSON.stringify(e.payload).includes(TOKEN),
    );
    expect(calls).toHaveLength(2);

    const results = toolResults(events) as Array<Array<{ eventId: number }>>;
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual([]);
    // The second search sees the first call, and still not itself.
    expect(results[1]!.map((h) => h.eventId)).toEqual([calls[0]!.id]);
  });
});

describe("session_event_read", () => {
  it("returns a window around an event, oldest first, focus included", async () => {
    const { ctx } = await bootProject([{ turn: "a" }]);
    const other = SessionId("ses_other");
    const ids = ["one", "two", "three", "four", "five"].map(
      (text) =>
        ctx.journal.append({ sessionId: other, type: "turn", payload: { text } })
          .id,
    );

    const tool = ctx.tools.get("session_event_read")!;
    const result = (await tool.execute(
      { event_id: ids[2], before: 2, after: 2 },
      { sessionId: SessionId("ses_caller"), projectRoot: "/tmp" },
    )) as { focusEventId: number; events: JournalEvent[] };

    expect(result.focusEventId).toBe(ids[2]);
    expect(result.events.map((e) => e.id)).toEqual(ids);
    expect(
      result.events.map((e) => (e.payload as { text: string }).text),
    ).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("clamps the window and reports an unknown id rather than throwing", async () => {
    const { ctx } = await bootProject([{ turn: "a" }]);
    const tool = ctx.tools.get("session_event_read")!;
    const missing = (await tool.execute(
      { event_id: 999_999 },
      { sessionId: SessionId("ses_caller"), projectRoot: "/tmp" },
    )) as { status: string };
    expect(missing.status).toBe("not-found");
  });
});

describe("list_sessions", () => {
  it("lists names, status and self, most recently active first", async () => {
    const { ctx } = await bootProject([{ turn: "a" }]);
    const first = await ctx.sessions.dispatch({ task: "alpha task", driver: "mock" });
    await first.done;
    const second = await ctx.sessions.dispatch({ task: "beta task", driver: "mock" });
    await second.done;

    const tool = ctx.tools.get("list_sessions")!;
    const rows = (await tool.execute(
      {},
      { sessionId: second.record.id, projectRoot: "/tmp" },
    )) as Array<{ name: string; status: string; live: boolean; self?: boolean }>;

    expect(rows.map((r) => r.name)).toEqual(["beta-task", "alpha-task"]);
    expect(rows[0]!.self).toBe(true);
    expect(rows[1]!.self).toBeUndefined();
    expect(rows.every((r) => r.live === false)).toBe(true);
  });

  it("live_only filters in SQL, so finished sessions cannot crowd out live ones", async () => {
    const { ctx } = await bootProject([{ turn: "a" }]);
    const done = await ctx.sessions.dispatch({ task: "finished one", driver: "mock" });
    await done.done;

    const tool = ctx.tools.get("list_sessions")!;
    const rows = (await tool.execute(
      { live_only: true, limit: 1 },
      { sessionId: SessionId("ses_caller"), projectRoot: "/tmp" },
    )) as Array<{ name: string }>;
    expect(rows).toEqual([]);
  });
});
