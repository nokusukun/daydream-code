import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootResult } from "@daydream-code/boot";
import type { JournalEvent } from "@daydream-code/shared";

/**
 * Boot repair for questions whose process died mid-block.
 *
 * A pending question is an in-memory promise. Clients derive the ask prompt by
 * folding the journal, so a `question_asked` with no closing row is offered
 * forever and every answer to it comes back 409 — the user-visible shape is
 * "stuck on the ask screen after the app crashed". A crash is simulated by
 * writing the `question_asked` row with no waiter behind it, which is exactly
 * the state a dead process leaves in sqlite.
 */

let dirs: string[] = [];
let systems: BootResult[] = [];

async function bootProject(dir: string): Promise<BootResult> {
  const result = await boot({
    projectRoot: dir,
    overrides: [
      { id: "driver-mock", disabled: false, config: { id: "mock", script: [] } },
      { id: "driver-claude", disabled: true },
    ],
  });
  systems.push(result);
  return result;
}

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ddc-restart-"));
  dirs.push(dir);
  return dir;
}

/** A finished session to hang journal rows off. The mock script is empty, so
 * the run completes immediately and the rows below are the only ones that
 * matter to the sweep. */
async function startedSession(system: BootResult) {
  const handle = await system.ctx.sessions.dispatch({
    task: "pick a store",
    driver: "mock",
  });
  await handle.done;
  return handle.record;
}

const settledFor = (events: JournalEvent[], requestId: string) =>
  events.filter(
    (event) =>
      event.type === "question_settled" &&
      (event.payload as { requestId?: string }).requestId === requestId,
  );

afterEach(async () => {
  for (const system of systems) {
    await system.app.dispose(system.app.rootFiber).catch(() => undefined);
  }
  systems = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("orphaned questions across a restart", () => {
  it("retires a question the crashed process left open", async () => {
    const dir = tempProject();
    const first = await bootProject(dir);
    const record = await startedSession(first);
    first.ctx.journal.append({
      sessionId: record.id,
      type: "question_asked",
      payload: {
        requestId: "qst_orphan",
        questions: [
          {
            id: "In project or shared?",
            header: "Storage",
            question: "In project or shared?",
            options: [
              { label: "In project", description: "Survives a sandbox boundary." },
              { label: "Shared cache", description: "Dedupes across projects." },
            ],
            multiSelect: false,
          },
        ],
      },
    });
    await first.app.dispose(first.app.rootFiber);

    const second = await bootProject(dir);
    const settled = settledFor(
      second.ctx.journal.read({ sessionId: record.id }),
      "qst_orphan",
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({ kind: "cancelled" });
  });

  it("is idempotent: a second restart adds nothing", async () => {
    const dir = tempProject();
    const first = await bootProject(dir);
    const record = await startedSession(first);
    first.ctx.journal.append({
      sessionId: record.id,
      type: "question_asked",
      payload: { requestId: "qst_orphan", questions: [] },
    });
    await first.app.dispose(first.app.rootFiber);

    const second = await bootProject(dir);
    await second.app.dispose(second.app.rootFiber);
    const third = await bootProject(dir);

    expect(
      settledFor(third.ctx.journal.read({ sessionId: record.id }), "qst_orphan"),
    ).toHaveLength(1);
  });

  it("leaves an already-settled question alone", async () => {
    const dir = tempProject();
    const first = await bootProject(dir);
    const record = await startedSession(first);
    first.ctx.journal.append({
      sessionId: record.id,
      type: "question_asked",
      payload: { requestId: "qst_done", questions: [] },
    });
    first.ctx.journal.append({
      sessionId: record.id,
      type: "question_settled",
      payload: { requestId: "qst_done", kind: "answered", answers: {} },
    });
    await first.app.dispose(first.app.rootFiber);

    const second = await bootProject(dir);
    const settled = settledFor(
      second.ctx.journal.read({ sessionId: record.id }),
      "qst_done",
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({ kind: "answered" });
  });
});
