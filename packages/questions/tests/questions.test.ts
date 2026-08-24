import { describe, expect, it } from "vitest";
import { App } from "@daydream-code/kernel";
import { SessionId } from "@daydream-code/shared";
import { Questions, type PendingQuestion, type Question } from "@daydream-code/questions";

const SESSION = SessionId("ses_one");
const OTHER = SessionId("ses_two");

function question(text: string): Question {
  return {
    id: text,
    header: "Pick",
    question: text,
    options: [
      { label: "a", description: "first" },
      { label: "b", description: "second" },
    ],
    multiSelect: false,
  };
}

async function harness(): Promise<{ questions: Questions; asked: PendingQuestion[]; app: App }> {
  const app = new App();
  const ctx = app.rootCtx;
  ctx.plugin(Questions);
  await app.settle();
  const asked: PendingQuestion[] = [];
  ctx.on("question/asked", (pending) => asked.push(pending));
  return { questions: ctx.questions, asked, app };
}

describe("Questions", () => {
  it("blocks until settled and resolves with the outcome", async () => {
    const { questions } = await harness();
    const promise = questions.ask(SESSION, [question("which one?")]);

    let settled = false;
    void promise.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    const pending = questions.current(SESSION)!;
    expect(questions.settle(pending.requestId, { kind: "answered", answers: { "which one?": "a" } })).toBe(true);
    await expect(promise).resolves.toEqual({ kind: "answered", answers: { "which one?": "a" } });
  });

  it("emits question/asked only after the waiter is registered", async () => {
    const app = new App();
    const ctx = app.rootCtx;
    ctx.plugin(Questions);
    await app.settle();
    // A listener that answers synchronously — the shape the CLI's attached
    // mode uses — must find the request already registered.
    ctx.on("question/asked", (pending) => {
      ctx.questions.settle(pending.requestId, { kind: "declined" });
    });
    await expect(ctx.questions.ask(SESSION, [question("now?")])).resolves.toEqual({
      kind: "declined",
    });
  });

  it("reports an unknown requestId rather than throwing", async () => {
    const { questions } = await harness();
    expect(questions.settle("qst_gone", { kind: "declined" })).toBe(false);
  });

  it("settles only once, so a late second answer is refused", async () => {
    const { questions } = await harness();
    const promise = questions.ask(SESSION, [question("which?")]);
    const id = questions.current(SESSION)!.requestId;
    expect(questions.settle(id, { kind: "declined" })).toBe(true);
    expect(questions.settle(id, { kind: "answered", answers: {} })).toBe(false);
    await expect(promise).resolves.toEqual({ kind: "declined" });
  });

  it("scopes pending questions per session", async () => {
    const { questions } = await harness();
    void questions.ask(SESSION, [question("mine?")]);
    void questions.ask(OTHER, [question("theirs?")]);
    expect(questions.pending(SESSION)).toHaveLength(1);
    expect(questions.pending(OTHER)).toHaveLength(1);
    expect(questions.pending()).toHaveLength(2);
    expect(questions.current(SESSION)!.questions[0]!.question).toBe("mine?");
  });

  it("settleCurrent answers the oldest question and leaves the rest", async () => {
    const { questions } = await harness();
    const first = questions.ask(SESSION, [question("first?")]);
    const second = questions.ask(SESSION, [question("second?")]);
    expect(questions.settleCurrent(SESSION, { kind: "replied", text: "prose" })).toBe(true);
    await expect(first).resolves.toEqual({ kind: "replied", text: "prose" });
    expect(questions.pending(SESSION)).toHaveLength(1);
    questions.cancelSession(SESSION, "cleanup");
    await expect(second).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("cancelSession releases every waiter for that session only", async () => {
    const { questions } = await harness();
    const mine = questions.ask(SESSION, [question("mine?")]);
    void questions.ask(OTHER, [question("theirs?")]);
    expect(questions.cancelSession(SESSION, "the run ended")).toBe(1);
    await expect(mine).resolves.toEqual({ kind: "cancelled", reason: "the run ended" });
    expect(questions.pending(OTHER)).toHaveLength(1);
  });

  it("releases every waiter when the plugin unloads", async () => {
    const app = new App();
    const ctx = app.rootCtx;
    const fiber = ctx.plugin(Questions);
    await app.settle();
    const promise = ctx.questions.ask(SESSION, [question("still there?")]);
    await app.dispose(fiber);
    await expect(promise).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("emits question/settled once, after question/asked", async () => {
    const app = new App();
    const ctx = app.rootCtx;
    ctx.plugin(Questions);
    await app.settle();
    const order: string[] = [];
    ctx.on("question/asked", () => order.push("asked"));
    ctx.on("question/settled", () => order.push("settled"));
    const promise = ctx.questions.ask(SESSION, [question("order?")]);
    ctx.questions.settleCurrent(SESSION, { kind: "declined" });
    ctx.questions.settleCurrent(SESSION, { kind: "declined" });
    await promise;
    expect(order).toEqual(["asked", "settled"]);
  });
});
