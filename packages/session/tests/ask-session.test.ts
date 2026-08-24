import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootResult } from "@daydream-code/boot";
import type { AskOutcome, PendingAsk } from "@daydream-code/asks";
import type { JournalEvent } from "@daydream-code/shared";

/**
 * End-to-end for session-to-session asks, through the real composed system.
 * The mock driver awaits `tool.execute` exactly like the Claude adapter's MCP
 * callback does, so a blocked `ask_session` blocks a real run — and, because
 * the mock replays its whole script on a continue, a woken session really does
 * take another turn.
 *
 * Each session needs its own script, so the two mock driver rows are separate
 * plugin entries with distinct driver ids rather than one shared script.
 */

let dirs: string[] = [];
let systems: BootResult[] = [];

interface Scripts {
  a: unknown[];
  b: unknown[];
  nudgeAfterMs?: number;
  maxNudges?: number;
}

async function bootProject(scripts: Scripts): Promise<BootResult> {
  const dir = mkdtempSync(join(tmpdir(), "ddc-ask-session-"));
  dirs.push(dir);
  const result = await boot({
    projectRoot: dir,
    overrides: [
      { id: "driver-claude", disabled: true },
      {
        id: "driver-mock",
        disabled: false,
        config: { id: "mock-a", script: scripts.a },
      },
      {
        id: "driver-mock-b",
        name: "@daydream-code/driver/mock",
        config: { id: "mock-b", script: scripts.b },
      },
      {
        id: "asks",
        config: {
          // Long enough that the timer never fires on its own during a test:
          // every nudge these tests observe is the lifecycle one, fired when a
          // session ends still owing an answer.
          nudgeAfterMs: scripts.nudgeAfterMs ?? 600_000,
          maxNudges: scripts.maxNudges ?? 3,
        },
      },
    ],
  });
  systems.push(result);
  return result;
}

const askStep = (session: string, question: string) => ({
  tool: "ask_session",
  args: { session, question },
});

const answerStep = (answer: string, extra?: Record<string, unknown>) => ({
  tool: "answer_session",
  args: { answer, ...extra },
});

function resultOf(events: JournalEvent[], tool: string): any {
  const hit = events.filter(
    (e) => e.type === "tool_result" && (e.payload as any)?.name === tool,
  );
  return (hit.at(-1)?.payload as any)?.result;
}

afterEach(async () => {
  for (const system of systems) {
    await system.app.dispose(system.app.rootFiber).catch(() => undefined);
  }
  systems = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("ask_session", () => {
  it("wakes an idle session, gets an answer, and resumes the asker", async () => {
    const { ctx } = await bootProject({
      a: [askStep("beta", "did you already migrate the schema?")],
      b: [answerStep("yes, migration v3 landed an hour ago")],
    });

    // Beta runs first and finishes; its script's answer_session finds nothing
    // waiting, which is the honest no-op.
    const beta = await ctx.sessions.dispatch({
      task: "own the schema",
      name: "beta",
      driver: "mock-b",
    });
    await beta.done;
    expect(ctx.sessions.get(beta.record.id)?.status).toBe("completed");

    // Alpha asks it. The runner has to revive beta for the answer to exist.
    const alpha = await ctx.sessions.dispatch({
      task: "add a column",
      name: "alpha",
      driver: "mock-a",
    });
    await alpha.done;

    const events = ctx.journal.read({ sessionId: alpha.record.id, limit: 200 });
    const result = resultOf(events, "ask_session");
    expect(result).toMatchObject({
      status: "answered",
      from: "beta",
      answer: "yes, migration v3 landed an hour ago",
    });

    // Beta really took another turn rather than being answered on paper.
    const betaEvents = ctx.journal.read({ sessionId: beta.record.id, limit: 200 });
    expect(betaEvents.map((e) => e.type)).toContain("ask_received");
    expect(resultOf(betaEvents, "answer_session")).toMatchObject({ status: "sent" });
  });

  it("parks the asker as `waiting` while it is blocked, then puts it back", async () => {
    const seen: string[] = [];
    const { ctx } = await bootProject({
      a: [askStep("beta", "are you done with styles.css?")],
      b: [answerStep("not yet, give me ten minutes")],
    });
    ctx.on("ask/requested", (pending: PendingAsk) => {
      seen.push(ctx.sessions.get(pending.fromSessionId)?.status ?? "gone");
    });
    ctx.on("ask/settled", (pending: PendingAsk) => {
      seen.push(`settled:${ctx.sessions.get(pending.fromSessionId)?.status}`);
    });

    const beta = await ctx.sessions.dispatch({
      task: "restyle",
      name: "beta",
      driver: "mock-b",
    });
    await beta.done;
    const alpha = await ctx.sessions.dispatch({
      task: "edit styles",
      name: "alpha",
      driver: "mock-a",
    });
    await alpha.done;

    // `ask/requested` fires before the runner flips the row, so the status
    // that matters is the one observed at settle time: back to running.
    expect(seen.at(-1)).toBe("settled:running");
    expect(ctx.sessions.get(alpha.record.id)?.status).toBe("completed");
  });

  it("gives up after the nudge budget when the target never answers", async () => {
    const { ctx } = await bootProject({
      a: [askStep("beta", "why is the build red?")],
      // Beta takes its turn and says nothing back.
      b: [{ turn: "busy with something else" }],
      maxNudges: 2,
    });

    const nudges: number[] = [];
    ctx.on("ask/nudged", (_pending: PendingAsk, attempt: number) =>
      nudges.push(attempt),
    );

    const beta = await ctx.sessions.dispatch({
      task: "unrelated work",
      name: "beta",
      driver: "mock-b",
    });
    await beta.done;
    const alpha = await ctx.sessions.dispatch({
      task: "fix the build",
      name: "alpha",
      driver: "mock-a",
    });
    await alpha.done;

    // Each time beta ends still owing an answer it is reminded, until the
    // budget runs out and alpha is released rather than parked forever.
    expect(nudges).toEqual([1, 2]);
    const result = resultOf(
      ctx.journal.read({ sessionId: alpha.record.id, limit: 200 }),
      "ask_session",
    );
    expect(result).toMatchObject({ status: "unanswered", nudges: 2 });
    expect(result.guidance).toContain("Proceed on your best judgement");
  });

  it("caps how often siblings may wake one idle session", async () => {
    const { ctx } = await bootProject({
      // Alpha asks four times in a row; beta never answers.
      a: [
        askStep("beta", "q1"),
        askStep("beta", "q2"),
        askStep("beta", "q3"),
        askStep("beta", "q4"),
      ],
      b: [{ turn: "not answering" }],
      maxNudges: 0,
    });

    const beta = await ctx.sessions.dispatch({
      task: "own the schema",
      name: "beta",
      driver: "mock-b",
    });
    await beta.done;

    const wakes: string[] = [];
    ctx.on("session/dispatched", (_s: unknown, kind: string) => {
      if (kind === "ask") wakes.push(kind);
    });

    const alpha = await ctx.sessions.dispatch({
      task: "ask repeatedly",
      name: "alpha",
      driver: "mock-a",
    });
    await alpha.done;

    // The budget is on beta, not on any one question, so the fourth ask is
    // refused rather than starting a fourth run.
    expect(wakes).toHaveLength(3);
    const results = ctx.journal
      .read({ sessionId: alpha.record.id, limit: 400 })
      .filter((e) => e.type === "tool_result")
      .map((e) => (e.payload as any).result);
    expect(results.at(-1)).toMatchObject({ status: "unanswered" });
    expect(results.at(-1).reason).toContain("without the user speaking to it");
  });

  it("does not spend the wake budget on a sibling that actually answers", async () => {
    const { ctx } = await bootProject({
      a: [
        askStep("beta", "q1"),
        askStep("beta", "q2"),
        askStep("beta", "q3"),
        askStep("beta", "q4"),
        askStep("beta", "q5"),
      ],
      b: [answerStep("answered")],
    });
    const beta = await ctx.sessions.dispatch({
      task: "own the schema",
      name: "beta",
      driver: "mock-b",
    });
    await beta.done;
    const alpha = await ctx.sessions.dispatch({
      task: "ask five times",
      name: "alpha",
      driver: "mock-a",
    });
    await alpha.done;

    // Five questions, all answered, past a budget of three — because a wake
    // that produced an answer is not what the cap is protecting against.
    const results = ctx.journal
      .read({ sessionId: alpha.record.id, limit: 500 })
      .filter(
        (e) =>
          e.type === "tool_result" && (e.payload as any).name === "ask_session",
      )
      .map((e) => (e.payload as any).result);
    expect(results).toHaveLength(5);
    expect(results.every((r: any) => r.status === "answered")).toBe(true);
  });

  it("refills the wake budget when the user speaks to the session", async () => {
    const { ctx } = await bootProject({
      a: [askStep("beta", "q1"), askStep("beta", "q2"), askStep("beta", "q3")],
      b: [{ turn: "not answering" }],
      maxNudges: 0,
    });
    const beta = await ctx.sessions.dispatch({
      task: "own the schema",
      name: "beta",
      driver: "mock-b",
    });
    await beta.done;

    const alpha = await ctx.sessions.dispatch({
      task: "ask repeatedly",
      name: "alpha",
      driver: "mock-a",
    });
    await alpha.done;

    // Budget spent. A user-authored continue hands the session back.
    const revived = await ctx.sessions.continueSession(
      beta.record.id,
      "carry on, and answer anyone who asks",
    );
    await revived.done;

    const wakes: string[] = [];
    ctx.on("session/dispatched", (_s: unknown, kind: string) => {
      if (kind === "ask") wakes.push(kind);
    });
    const gamma = await ctx.sessions.dispatch({
      task: "ask once more",
      name: "gamma",
      driver: "mock-a",
    });
    await gamma.done;

    expect(wakes.length).toBeGreaterThan(0);
  });

  it("refuses an unknown session immediately instead of blocking on nobody", async () => {
    const { ctx } = await bootProject({
      a: [askStep("no-such-session", "hello?")],
      b: [],
    });
    await ctx.sessions
      .dispatch({ task: "own it", name: "beta", driver: "mock-b" })
      .then((h) => h.done);
    const alpha = await ctx.sessions.dispatch({
      task: "ask nobody",
      name: "alpha",
      driver: "mock-a",
    });
    await alpha.done;

    const result = resultOf(
      ctx.journal.read({ sessionId: alpha.record.id, limit: 200 }),
      "ask_session",
    );
    expect(result).toMatchObject({ status: "refused", reason: "unknown-session" });
    expect(result.reachable).not.toContain("no-such-session");
  });

  it("refuses to answer a question addressed to someone else", async () => {
    const { ctx } = await bootProject({
      a: [askStep("beta", "who owns the composer?")],
      b: [answerStep("I do")],
    });
    const beta = await ctx.sessions.dispatch({
      task: "own composer",
      name: "beta",
      driver: "mock-b",
    });
    await beta.done;

    const outcomes: AskOutcome[] = [];
    ctx.on("ask/settled", (_p: PendingAsk, o: AskOutcome) => outcomes.push(o));

    // Intercept the ask and try to answer it as a third party.
    let refused: string | undefined;
    ctx.on("ask/requested", (pending: PendingAsk) => {
      refused = ctx.asks.answer(pending.requestId, beta.record.id, {
        kind: "answered",
        text: "real",
      });
      const imposter = ctx.asks.answer(pending.requestId, pending.fromSessionId, {
        kind: "answered",
        text: "forged",
      });
      expect(imposter).not.toBe("settled");
    });

    const alpha = await ctx.sessions.dispatch({
      task: "find the owner",
      name: "alpha",
      driver: "mock-a",
    });
    await alpha.done;
    expect(refused).toBe("settled");
    expect(outcomes.at(-1)).toEqual({ kind: "answered", text: "real" });
  });

  it("does not broadcast the question's boilerplate to every sibling", async () => {
    const { ctx } = await bootProject({
      a: [askStep("beta", "did you already migrate the schema?")],
      b: [answerStep("yes, v3 landed")],
    });
    const beta = await ctx.sessions.dispatch({
      task: "own the schema",
      name: "beta",
      driver: "mock-b",
    });
    await beta.done;
    const alpha = await ctx.sessions.dispatch({
      task: "add a column",
      name: "alpha",
      driver: "mock-a",
    });
    await alpha.done;

    const master = ctx.threads.ensureMaster();
    const prose = ctx.threads
      .entries(master.id, { fromSeq: 1 })
      .map((e) =>
        typeof e.message.content === "string"
          ? e.message.content
          : JSON.stringify(e.message.content),
      )
      .join("\n");

    // The delivery is recorded...
    expect(prose).toContain("session beta was asked a question by a sibling");
    // ...but the machine-written prompt is not reprinted for everyone else.
    expect(prose).not.toContain("answer_session({ request_id");
    expect(prose).not.toContain("cannot continue until you answer");

    // And the question did not become beta's title.
    expect(ctx.sessions.get(beta.record.id)?.title).not.toContain("blocked waiting");
  });

  it("queues the question as an injection when the target is mid-turn", async () => {
    const { ctx } = await bootProject({
      a: [askStep("beta", "may I edit styles.css?")],
      // Beta parks on a question of its own, so it is active but has not
      // reached a turn boundary — the injection path rather than the wake path.
      b: [
        {
          tool: "ask_user",
          args: {
            questions: [
              {
                question: "ship it?",
                header: "Ship",
                options: [
                  { label: "yes", description: "now" },
                  { label: "no", description: "later" },
                ],
              },
            ],
          },
        },
      ],
    });

    const parked = new Promise<string>((resolve) => {
      const off = ctx.on("question/asked", (pending: { requestId: string }) => {
        off();
        resolve(pending.requestId);
      });
    });
    const beta = await ctx.sessions.dispatch({
      task: "restyle",
      name: "beta",
      driver: "mock-b",
    });
    const questionId = await parked;
    expect(ctx.sessions.get(beta.record.id)?.status).toBe("waiting");

    // Alpha asks while beta is mid-turn. Nothing can drain yet.
    const asked = new Promise<PendingAsk>((resolve) => {
      const off = ctx.on("ask/requested", (pending: PendingAsk) => {
        off();
        resolve(pending);
      });
    });
    const alpha = await ctx.sessions.dispatch({
      task: "edit styles",
      name: "alpha",
      driver: "mock-a",
    });
    const pending = await asked;
    expect(ctx.asks.inbound(beta.record.id)).toHaveLength(1);

    // Beta's own question clears; its turn reaches a boundary and the queued
    // ask is finally handed to the driver.
    ctx.questions.settle(questionId, { kind: "declined" });
    await beta.done;

    const injected = ctx.journal
      .read({ sessionId: beta.record.id, limit: 200 })
      .filter((e) => e.type === "user_injected")
      .map((e) => e.payload as { kind: string; text: string });
    const askInjection = injected.find((p) => p.kind === "ask");
    expect(askInjection).toBeDefined();
    expect(askInjection!.text).toContain("may I edit styles.css?");
    expect(askInjection!.text).toContain(pending.requestId);
    expect(askInjection!.text).toContain("blocked waiting on you");

    // Release alpha so the run can finish; the mock acks injections rather
    // than calling answer_session, so nothing else would.
    ctx.asks.settle(pending.requestId, { kind: "answered", text: "go ahead" });
    await alpha.done;
  });

  it("lets the user unblock a session that is waiting on a sibling", async () => {
    const { ctx } = await bootProject({
      a: [askStep("beta", "is the API stable?")],
      b: [{ turn: "not answering" }],
    });
    const beta = await ctx.sessions.dispatch({
      task: "own api",
      name: "beta",
      driver: "mock-b",
    });
    await beta.done;

    ctx.on("ask/requested", (pending: PendingAsk) => {
      // The user types at alpha while it is parked. Without the asks branch in
      // continueSession this message would queue as an injection that never
      // drains, because alpha's turn cannot reach a boundary while blocked.
      void ctx.sessions.continueSession(
        pending.fromSessionId,
        "stop waiting, it is stable",
      );
    });

    const alpha = await ctx.sessions.dispatch({
      task: "use the api",
      name: "alpha",
      driver: "mock-a",
    });
    await alpha.done;

    const result = resultOf(
      ctx.journal.read({ sessionId: alpha.record.id, limit: 200 }),
      "ask_session",
    );
    expect(result.status).toBe("answered");
    expect(result.answer).toContain("stop waiting, it is stable");
    expect(result.answer).toContain("answered by the user");
  });
});
