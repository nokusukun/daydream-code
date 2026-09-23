# kanban mode — plan

> **Status (2026-09-24): built.** `packages/board` (seam, sqlite provider, evaluator,
> master write-back, routes), migration v8, the two seam additions (`session/pre-continue`,
> `stream/publish`), the desktop Board mode and settings section, and the CLI's deferred
> output all exist; 12 end-to-end tests in `packages/board/tests` cover the state
> machine through the real composition with the mock driver. Deviations from the text
> below, made while building: the storage column is `lane` (`column` is an SQLite
> keyword) though the TypeScript field is still `column`; the `kind` column was dropped
> because evaluators turned out to need no card of their own; there is no `maxTurns`
> (no driver exposes one), only `timeoutMs`; a 202 is carried by `HttpError` growing an
> optional `body` rather than by widening the route contract; and evaluator sessions
> are tied to their card by a marker line at the top of their task, because a scripted
> driver can deliver a verdict before the dispatch that started it has returned.

Kanban mode turns each unit of work into a **card** that moves through fixed columns:

```
Drafts → Queued → Evaluating → Working → Done
                       ↘ Blocked ↗      ↘ Needs Attention ↗
```

A card is evaluated by a real session before it runs. The evaluator decides whether the
card can proceed alongside what is live, or must **block** on one or more Working
sessions. A blocked card re-evaluates when every blocker finishes. Vocabulary: "A blocks
B", "B is blocked by A".

Everything here is a plugin family, `packages/board`, plus one new event on the runner,
one on the server, and a desktop mode. No core behaviour changes when the board row is
disabled — which is the default.

---

## 1. Settled decisions

| Question | Decision |
|---|---|
| What is a card | New durable row wrapping `sessionId \| null`. Drafts and Queued cards have no session. |
| Where Drafts live | Server-side card rows. `drafts.ts` stays for unsent composer text on a *selected* card; the Drafts column itself is store-backed. |
| Mode toggle | Per project: the `board` row is `disabled: true` in the base bundle and enabled from the project config layer (or via `ctx.settings` from the UI). |
| Scope | Every new session in a kanban project becomes a card: desktop, CLI `run`, and agent-spawned. |
| Conflict model | Both file overlap (workspace changed files per live session) and semantic dependency. |
| Evaluator | A real session on the project default agent, visible in the rail. Decides alone; uses `ask_session` on a live thread only when unsure. |
| Parallelism | Evaluations run in parallel. The evaluator sees Queued and Evaluating cards for context. |
| Cycle rule | Only Working sessions may be named as blockers. A card may *defer* to an Evaluating card ahead of it in queue order, never behind. |
| Blockers | All must finish. Any terminal status of a blocker (completed, failed, killed) releases the card. |
| Release target | Back to Evaluating, never straight to Working. |
| Done | Automatic when the session ends `completed` and is not blocked on a person. |
| Needs Attention | `waiting` on ask_user, a permission request, `failed`, `killed`, or an evaluator that produced no verdict. On answer/continue the card returns straight to Working. |
| Follow-up on Done | Card returns to Queued and is re-evaluated. Cards it used to block do not re-block. |
| Queue order | Manual reorder. No WIP limit. |
| Manual moves | Force start (skip evaluation), edit blockers, cancel a queued card. No "un-done" drag. |
| Master thread | Every transition is a master entry. The blocker session is told which cards wait on it. |

## 2. Assumptions made without asking

Flag any of these and the design bends without breaking.

- **Two cards cleared in the same window can still collide.** A card that gets `proceed`
  is dispatched immediately and counts as Working for every verdict that lands after.
  Two verdicts landing within milliseconds of each other are not re-checked. The
  `defer` verdict (§5) is the mitigation the evaluator is told to use.
- **Evaluator asks a live thread and gets `unanswered`** (nudges exhausted): the
  evaluator is told to treat silence as "not blocked" and say so in its reason.
- **Sibling traffic bypasses the queue.** `send_session` and `ask_session` to a Done
  session wake it directly. Routing an `ask` through evaluation would deadlock the asker
  behind a queue it is itself part of. Only *user-authored* continues re-queue.
- **The evaluator session is tagged, not hidden.** It is a normal session with a
  `kind: "evaluator"` card of its own so the rail can show it, and the board can filter
  it out of the columns (it is never a card someone drags).
- **Evaluator failure → Needs Attention** with the reason on the card, rather than an
  automatic retry. Retrying a model that just gave up costs money for the same answer.
- **Process death mid-Evaluating → Queued.** The evaluator session is killed by boot
  repair like any live session; the card is requeued because nothing about it is
  half-done.
- **Evaluator permission mode is the project default.** It needs to read the tree; it
  has no reason to write, but `readonly` is a driver-level mode and forcing it would
  refuse a `git status` on some drivers. Left as config (`evaluator.permissionMode`).

---

## 3. Data model

New migration **v8** in `packages/store/src/migrations.ts`, mirrored in `schema.ts`.

```sql
CREATE TABLE IF NOT EXISTS board_cards (
  id            TEXT PRIMARY KEY,           -- "card_…"
  project_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,              -- "work" | "evaluator"
  column        TEXT NOT NULL,              -- see §4
  position      REAL NOT NULL,              -- order within Queued; fractional so a
                                            -- reorder is one UPDATE, not a renumber
  title         TEXT NOT NULL,              -- titleFromTask until a session exists,
                                            -- then mirrors session.title
  task          TEXT NOT NULL,              -- the opening instruction, or the pending
                                            -- follow-up text for a re-queued card
  request_json  TEXT NOT NULL,              -- DispatchRequest minus task: driver,
                                            -- modelId, effort, fastMode, name,
                                            -- attachments (blob ids only)
  session_id    TEXT,                       -- null until Working
  evaluator_session_id TEXT,                -- current or last evaluator run
  attention_reason TEXT,                    -- why it sits in Needs Attention
  verdict_json  TEXT,                       -- last verdict, for the card face
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS board_cards_project_column
  ON board_cards (project_id, column, position);
CREATE UNIQUE INDEX IF NOT EXISTS board_cards_session
  ON board_cards (session_id) WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS board_blocks (
  card_id       TEXT NOT NULL,              -- the blocked card
  blocker_session_id TEXT NOT NULL,         -- a Working session
  source        TEXT NOT NULL,              -- "evaluator" | "user"
  reason        TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (card_id, blocker_session_id)
);
CREATE INDEX IF NOT EXISTS board_blocks_blocker ON board_blocks (blocker_session_id);
```

Why blockers key on **session id** and not card id: a blocker is by definition Working,
so it has a session, and `session/ended` carries a `SessionRecord` — the release path
needs no join. Attachments are stored as blob ids only, the same rule `drafts.ts`
follows and for the same reason.

Types go in `packages/board/src/index.ts`, not `shared`: nothing outside the board
family needs them, and `shared` is for words seams share.

```ts
export type BoardColumn =
  | "draft" | "queued" | "evaluating" | "blocked"
  | "working" | "attention" | "done";

export interface BoardCard {
  id: string; projectId: ProjectId; kind: "work" | "evaluator";
  column: BoardColumn; position: number;
  title: string; task: string; request: CardRequest;
  sessionId: SessionId | null; evaluatorSessionId: SessionId | null;
  blockedBy: BoardBlock[]; attentionReason: string | null;
  verdict: Verdict | null; createdAt: string; updatedAt: string;
}
```

`blocked` is a real column in storage even though the UI shows it as a badge inside
Queued: "waiting on blockers" and "waiting for its turn" are different states with
different exits, and a column string that has to be inferred from a join is the kind of
thing that drifts.

## 4. State machine

Columns and the only legal transitions. Anything else is an `HttpError(409)` from a
route or a thrown error from the service.

| From | To | Trigger |
|---|---|---|
| — | draft | `create({ draft: true })` |
| — | queued | `create()` / `submit()` from any intake (§6) |
| draft | queued | `submit(cardId)` |
| draft, queued, blocked | *(deleted)* | `cancel(cardId)` — manual move "cancel" |
| queued | evaluating | scheduler picks it up (immediately; no WIP limit) |
| evaluating | working | verdict `proceed`; the board dispatches the real session |
| evaluating | blocked | verdict `block` naming ≥1 Working session |
| evaluating | queued | verdict `defer` naming an Evaluating card ahead in order; re-enters when that card leaves Evaluating |
| evaluating | attention | evaluator session ended with no verdict, or `failed`/`killed` |
| evaluating | working | `forceStart(cardId)` — kills the evaluator session first |
| blocked | evaluating | last blocker's `session/ended` |
| blocked | working | `forceStart(cardId)` |
| blocked | blocked | `setBlockers(cardId, sessionIds)` — manual edit; empty list is the same as release → evaluating |
| queued | working | `forceStart(cardId)` |
| working | done | `session/ended` with `completed` and no pending question |
| working | attention | `session/updated` to `waiting` (ask_user only — an `ask_session` wait is not a person's problem), a `permission_request` journal event, or `session/ended` with `failed`/`killed` |
| attention | working | `session/updated` back to `running`, or `question/settled` |
| done | queued | user continue (§6); the card's `task` becomes the follow-up text |

The Blocked → Evaluating hop is why the card keeps `request_json`: the evaluator prompt
is rebuilt from it each time, against the board as it is *now*.

Manual reorder is `reorder(cardId, beforeCardId | null)` and only touches `position`.
It is legal in Queued and Blocked. The scheduler reads Queued in `position` order when
deciding what "ahead" means for `defer`.

## 5. The evaluator protocol

The board dispatches a session through `ctx.sessions.dispatch()` with:

- `task`: a prompt built from the card and a board snapshot (below).
- `name`: `eval-<card slug>` so the rail and the master thread read sensibly.
- driver/model/effort from the board plugin config (`evaluator.*`), each falling back to
  the project default.

The evaluator gets one purpose-built harness tool, registered by the board plugin and
**only honoured when `run.sessionId` is the evaluator session of a card in Evaluating**.
Any other caller gets a refusal explaining that.

```ts
board_verdict({
  decision: "proceed" | "block" | "defer",
  blockedBy?: string[],   // session names; must all be Working sessions
  deferTo?: string,       // a card id from the snapshot, must be Evaluating and ahead
  reason: string,         // lands on the card face and the master thread
})
```

Validation is strict and the error text is written for the model: a `block` naming a
session that is not Working returns the current list of Working sessions and asks for a
retry. That is where the cycle rule is enforced, not in the prompt.

The prompt gives the evaluator:

1. The card's task and request (driver, model — so it knows what will run).
2. For each **Working** session: name, title, tldr, and the changed files from
   `ctx.workspace.status()` that the session's journal shows it touched (files named in
   `tool_call` payloads for write/edit tools). Cheap to compute and enough for a file
   overlap call.
3. For each **Queued / Evaluating** card ahead of this one: id, title, task. Context
   only — the model can `defer` to Evaluating ones, not block on them.
4. Instructions: judge file overlap and logical dependency; use `ask_session` only when
   a live session's *intent* is the deciding factor and the tldr does not settle it;
   treat `unanswered` as not blocked; finish by calling `board_verdict` exactly once;
   make no edits.

The evaluator session is a normal session: it can `read`, `grep`, run `git`, and it is
journaled. What it cannot do is end its turn without a verdict and have that count — the
board listens for `session/ended` on the evaluator id and, if no verdict landed, moves
the card to Needs Attention with the evaluator's tldr as the reason.

Cost guard: `evaluator.maxTurns` (default 8) is passed through to the driver where
supported, and the board kills the evaluator session itself if it is still live after
`evaluator.timeoutMs` (default 10 min). Both configurable with `defineConfig`.

## 6. Intake — how every dispatch becomes a card

Kanban mode has to catch three doors without patching any of them.

**Desktop.** `DispatchComposer` calls `POST /api/board/cards` instead of
`POST /api/sessions` when the board is enabled (it learns that from
`GET /api/board`, which 404s when the row is off). This is the one client change to
intake.

**CLI `run` and any other `ctx.sessions.dispatch()` caller** — including the desktop if
an old client hits the session route. The board plugin registers a
`session/pre-dispatch` waterfall listener. For a request it did not originate, it
creates a Queued card and **throws** `BoardQueued` carrying the card id, rather than
calling `next()`. The waterfall's return type is a `SessionHandle`; there is no session
to hand back, and a caller that expects a handle would hang on `done` forever if we
faked one. The session route maps `BoardQueued` to `202 { card }`; the CLI prints
`queued as card <id>`. Requests the board itself dispatches (evaluators, and cards that
got `proceed`) are recognised by object identity in a `WeakSet` the board holds, so no
field is added to `DispatchRequest`.

**`send_session` / the ask protocol** are not intake and are untouched (§2).

**User continues on a Done card.** `continueSession` has no waterfall today. Add one to
the runner, documented like `session/pre-dispatch`:

```ts
/** @mode waterfall — around a user-authored continue on an idle session. Not
 *  fired for sibling-authored kinds (`ask`, `message`) or for a session that is
 *  live: those paths queue an injection and never start a run. */
"session/pre-continue"(
  request: ContinueRequest,          // { id, message, attachments, kind }
  next: (request?: ContinueRequest) => Promise<SessionHandle>,
): Promise<SessionHandle>;
```

That is the one runner edit in this plan, and it is an event with a documented mode,
which is the sanctioned way to add a hook. The board's listener moves the session's card
from Done to Queued with the follow-up as `task`, journals `user_message_deferred` on
the session so the transcript shows the message as pending, and throws `BoardQueued`.
When the card is later cleared, the board calls `continueSession` itself (tagged), the
runner journals the release, and the message becomes the run's opening turn.

## 7. Events and the master thread

Declared in `packages/board/src/index.ts`:

```ts
/** @mode emit — after the card row is committed. Carries before/after column. */
"board/moved"(card: BoardCard, from: BoardColumn | null): void;
/** @mode emit — after the row is deleted. */
"board/removed"(card: BoardCard): void;
```

`packages/board/src/master-writeback.ts` (consumer plugin, own row) turns these into
`note` entries on the master thread, in the same prose register as
`thread/master-writeback.ts`:

- `card "fix flaky tests" queued`
- `card "fix flaky tests" blocked by session refactor-store: touches migrations.ts`
- `card "fix flaky tests" released; session refactor-store finished`
- `session fix-flaky-tests started from card`

Blockers are told through `session/collect-injections`: at the blocker's next turn
boundary the board contributes a `[board]` block listing the cards waiting on it and why.
Injected at most once per (card, blocker) pair — the block is a courtesy so the session
can wrap up cleanly, not a nag. The existing `master-inject` plugin already carries the
prose facts; this is the addressed version.

**Stream.** The server forwards a fixed list of events today. Add one generic event,
declared in `packages/server/src/index.ts`:

```ts
/** @mode emit — any plugin may push one frame to every open /stream socket. */
"stream/publish"(message: StreamMessage): void;
```

`StreamMessage` becomes an open union (`kind: string` plus known members). The board
publishes `{ kind: "board", card }` and `{ kind: "board-removed", id }`. The server
still serves no routes and knows nothing about boards.

## 8. Routes

`packages/board/src/routes.ts`, all under `/api/board`, absent entirely when the row is
disabled:

| Method | Path | Body / effect |
|---|---|---|
| GET | `/api/board` | `{ enabled: true, cards: BoardCard[] }` — one snapshot, columns computed client-side |
| POST | `/api/board/cards` | `DispatchBody & { draft?: boolean }` → card (`draft` lands in Drafts, else Queued) |
| PATCH | `/api/board/cards/:id` | `{ task?, request? }` — Drafts and Queued only |
| POST | `/api/board/cards/:id/submit` | draft → queued |
| POST | `/api/board/cards/:id/reorder` | `{ before: cardId \| null }` |
| POST | `/api/board/cards/:id/start` | force start |
| PUT | `/api/board/cards/:id/blockers` | `{ sessions: string[] }` — names or ids, resolved through `sessions.resolve` |
| DELETE | `/api/board/cards/:id` | cancel; 409 unless draft/queued/blocked |

Session routes get one change: `POST /api/sessions` and `/api/sessions/:id/message`
catch `BoardQueued` and answer `202 { card }`. The board package depends on `session`,
never the reverse, so the error class lives in `shared` as a two-line
`class DeferredError extends Error { constructor(readonly ref: string) }` that either
side can import.

## 9. Service and package layout

```
packages/board/
  src/index.ts          seam: abstract class Board extends Service ("board"),
                        BoardCard/BoardColumn/Verdict types, events
  src/sqlite.ts         default provider: rows, transitions, scheduler, listeners
  src/evaluator.ts      prompt builder + board_verdict tool (consumer plugin, own row)
  src/master-writeback.ts   board → master entries + blocker injections
  src/routes.ts
  tests/board.test.ts   state machine on a bare App with mock sessions
  tests/e2e.test.ts     boot() with mock driver scripted to call board_verdict
```

Base bundle rows, all `disabled: true`:

```ts
{ id: "board", name: "@daydream-code/board/sqlite", disabled: true },
{ id: "board-evaluator", name: "@daydream-code/board/evaluator", disabled: true },
{ id: "board-writeback", name: "@daydream-code/board/master-writeback", disabled: true },
{ id: "board-routes", name: "@daydream-code/board/routes", disabled: true },
```

Enabling kanban for a project is four `disabled: false` patches in
`<project>/.daydream-code/config.yml`. A "Kanban mode" toggle in the desktop settings
writes exactly those through `ctx.settings`; `sessions` is refused for hot reload while
a run is live, but `board/*` rows are not on that list, so the toggle takes effect
without a restart when nothing is running and reports `restart-required` otherwise.

Why a seam and not a consumer plugin: the state machine is a capability with more than
one plausible provider (a Postgres board for a shared server, a board that talks to
Linear). Routes and the evaluator depend on `ctx.board`, not on `sqlite.ts`.

Config (`defineConfig`) on `sqlite.ts`:

```ts
evaluator: { driver?, modelId?, effort?, permissionMode?, maxTurns: 8, timeoutMs: 600_000 }
```

Scheduler is a plain loop inside the provider: on `board/moved` into Queued, on
`session/ended`, and on boot, it walks Queued in `position` order and starts an evaluator
for every card that is not `defer`-waiting. There is no concurrency cap by decision.

## 10. Desktop

- **New mode** `board`, registered from `modules/features/board.tsx` in the pattern of
  `modules/features/code.tsx`, added to `modules/defaults.ts`. No `App.tsx` edit.
- **`board.ts` store** alongside `sessions.ts`: REST snapshot on `[api, resyncTick]`,
  merges `board` / `board-removed` frames. `stream.ts`'s frame union gains the two kinds.
- **`views/BoardView.tsx`**: six columns. Blocked cards render inside Queued with a
  "blocked by …" strip; Evaluating cards show a spinner and the evaluator's name as a
  link to its session. Card face reuses `run-card` styling and `runFacts`.
- **Drag and drop** with native HTML5 DnD (`draggable`, `onDragOver`, `onDrop`): the
  four legal manual moves are reorder within Queued, drop on Working (force start),
  drop on trash (cancel), and drag a Working card onto a Queued card (add blocker). Every
  other drop target is inert. No library.
- **Composer**: when `GET /api/board` answers, `DispatchComposer` posts to the board and
  selects the card; the per-session composer on a Done card posts a continue and shows
  the "re-queued" state from the `202`.
- The mode hides cards of `kind: "evaluator"`; the rail still lists their sessions.

## 11. Tests

`packages/board/tests/board.test.ts` — bare `App`, a stub `sessions` provider that
records dispatches and lets the test fire `session/updated` / `session/ended`:

- draft → queued → evaluating → working → done, each emitting `board/moved`
- verdict `block` with two blockers; first ends → still blocked; second ends → evaluating
- blocker ends `killed` → evaluating
- `defer` to a card behind in order → rejected; ahead → queued and re-entered on the
  ahead card's verdict
- `board_verdict` from a non-evaluator session → refused, card untouched
- evaluator ends without verdict → attention, reason set
- `waiting` on ask_user → attention; `running` → working; `waiting` on ask_session →
  stays working
- force start from evaluating kills the evaluator session
- boot with a card left in evaluating → queued

`packages/board/tests/e2e.test.ts` — `boot()` with the base bundle, board rows enabled,
mock driver scripted `[{ tool: "board_verdict", args: { decision: "proceed", reason } },
{ turn: "done" }]`: a `POST /api/board/cards` ends with a session in `completed` and the
card in Done, and the master thread carries the four expected notes.

`apps/cli/tests/integration.test.ts` gains one case: `run` in a kanban project prints
the queued line and exits 0 without waiting.

## 12. Build order

1. `shared`: `DeferredError`. `store`: migration v8 + schema.
2. `board/index.ts` seam + types + events. `board/sqlite.ts` with transitions and
   listeners, no scheduler. Unit tests for the state machine.
3. Runner: `session/pre-continue` waterfall. Server: `stream/publish`. Session routes:
   `202` mapping.
4. `board/evaluator.ts`: prompt builder, `board_verdict`, scheduler wired in. E2E test.
5. `board/master-writeback.ts` and blocker injections.
6. Routes. Base bundle rows. `dump-config` / `fiber-state` check.
7. Desktop: store, mode, view, DnD, composer switch, settings toggle.
8. CLI: print the queued line.

Steps 1–6 are shippable behind `disabled: true` before any UI exists.
