# daydream-code — plan

> **Status (2026-08-23): built.** Kernel, boot/loader, sqlite storage, threads + master write-back + live sibling injection, compaction, recall tools, claude/codex/mock drivers, session runner, fastify server, CLI, and the Electron desktop app all exist and pass 101 tests (`pnpm test`, `pnpm exec tsc -b`). Verified live with real Claude sessions (dispatch, tool journaling, master write-back, SDK-native resume). Codex driver is implemented but not exercised against a live account. See README.md for usage.

A coding harness where every project has one continuous, journaled **master thread**. Sessions fork off it, do work through an agent SDK (Claude Agent SDK or Codex SDK), and stream summaries back. Nothing is ever lost: every tool call, turn, and thought lands in an append-only journal the agent can dig back into on demand.

**And everything is a plugin.** Philosophy imbued from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh, Cordis-based): there is no privileged core to patch — the drivers, the storage, the master-thread policy, the compactor, the recall tools, the UI panes, and the agent-session loop itself are all plugins, replaceable from configuration. Extending daydream-code means mounting a plugin beside the others; every registration is an effect that unwinds when its plugin unloads.

Prior art:
- `~/projects/daydream` — the two-store idea: immutable `events` journal beside mutable, compacted working memory; `durableMessage` normalizer; compaction cut logic.
- dsh (cloned at `/tmp/dsh`) — the plugin kernel, seams, config-as-entry-list, "model-visible means logged".

---

## 1. Kernel (the only thing that is NOT a plugin)

A small Cordis-style microkernel, `packages/kernel`, target < 2,500 LOC. No agent, no storage, no opinions:

- **`Context`** — a Proxy over a service store. `ctx.extend()`, `ctx.isolate(name)` (fresh scope for one service under this subtree), `ctx.intercept(name, config)`.
- **`Fiber`** — one loaded plugin instance: `PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED` (+ FAILED). A plugin with unsatisfied `inject` waits in PENDING; if a provider unloads later, dependents unwind and reload when it returns — that's what makes provider swapping-in-config work. Ship a `fiber-state` dump command day one (dsh's documented failure mode: the silently-PENDING plugin).
- **`ctx.effect(fn, label?)`** — registration-with-disposer; reverse-order disposal on unload. Every registry API in the harness attaches its disposer to the *calling* plugin's fiber.
- **`ctx.provide(name, value)`** — throws on duplicate within an isolation scope. Loud, not last-write-wins.
- **Events** with explicit dispatch modes: `emit` / `parallel` / `serial` / `bail` / `waterfall`. Waterfall = around-middleware (`(...args, next)`); the mode is part of each event's public contract.
- **Plugin shapes**: function / class / `{apply}`, with `name?`, `Config?` (Standard Schema — zod), `inject?`, `provide?`. Services are classes extending `Service`; `declare module` merging makes `ctx.foo` and new event names type-safe with no central registry file.

Rules stolen verbatim from dsh:
- **Three-role seams**: a seam = Service Definition (owns `ctx.<key>` + vocabulary types, an abstract class or concrete registry — never a bare TS interface) + Provider(s) + Consumer(s). Providers and consumers depend only on the definition, never on each other.
- `inject` for hard deps; `ctx.get(name)` for optional ones.
- A public service method with one internal caller is a smell — pass a private closure instead.
- Config docs are **generated from source** and CI-verified against the runtime schemas, so they can't lie.

Plus a boot package (`packages/boot`): create root context, mount the loader, apply config layers, fail loud.

## 2. Seams

Everything below is a plugin. Definition package / default provider(s):

| Seam | `ctx.` key | Default provider | Notes |
|---|---|---|---|
| Project store | `ctx.store` | `store-sqlite` (drizzle + better-sqlite3) | owns the per-project DB handle, migrations |
| Journal | `ctx.journal` | `journal-sqlite` | append-only, trigger-enforced; extensible event map via declaration merging |
| Threads | `ctx.threads` | `threads-sqlite` | master + session threads, fork/append/derive-context |
| Master-thread policy | — (consumer) | `master-writeback` | listens to session events, writes dispatch/turn-end/summary/`session_message` entries |
| Compaction | `ctx.compaction` | `compaction-two-tier` | tier 1: collapse completed sessions' chatter into their summary; tier 2: model-driven copy-on-write compaction under the 50k budget |
| Session driver | `ctx.drivers` (registry) | `driver-claude`, `driver-codex` | Claude Agent SDK / Codex SDK adapters register into the registry; config picks per-project/per-dispatch |
| Session runner | `ctx.sessions` | `session-runner` | the loop bundle: dispatch = fork + drive + journal; replaceable like dsh's `agentLoop` |
| Sibling awareness | — (consumer) | `master-inject` | at each turn boundary, injects `[master thread update]` since `lastSeenMasterSeq` |
| Recall tools | — (consumers) | `tool-search-journal`, `tool-read-session`, `tool-read-master`, `tool-post-to-master` | register into the driver's extra-tools surface (MCP-style for both SDKs) |
| Normalizer | `ctx.normalizer` | `normalize-durable` | daydream's `durableMessage` rules as a waterfall (`thread/persist`, `thread/load`) so providers can add rules |
| Token estimate | `ctx.tokens` | `tokens-estimate` (chars/4) | swap for a real tokenizer later |
| Summarizer | `ctx.summarizer` | `summarize-driver-model` | turn-end one-liners + final summaries; fallback provider `summarize-mechanical` |
| Server | `ctx.server` | `server-fastify` | REST + WS event stream, backpressure ladder |
| Settings/keys | `ctx.settings`, `ctx.credentials` | `settings-file`, `credentials-safestorage` | hot-reloaded user plane, separate from composition config |
| UI panes | client plugin graph | `ui-project-timeline`, `ui-session-view`, `ui-journal-browser` | renderer is a plugin graph too; panes mount/unmount with config |

Event domains (mirroring dsh's three): **journal events** (durable facts — anything model-visible must be reconstructable from the journal, asserted by a runtime invariant), **session events** (`session/pre-dispatch` waterfall, `session/turn-end`, `session/ended` — live interception), **capability events** (`thread/persist`, `journal/append`, `driver/stream` — attach policy without importing the loop).

## 3. Core model (unchanged in substance, now expressed through seams)

### Master thread
- One per project, persisted for the project's lifecycle. Entries land **as sessions run**:
  - dispatch: `new session <id> with msg: "..."` / `continue session <id> with msg: "..."`
  - per turn: `session <id> turn end, summary: ...`
  - completion/kill: final structured summary (files touched, decisions, open threads; exact names/paths verbatim)
  - `session_message` entries (inter-session comms), user notes, decisions.
- Budget **50k tokens** (per-project config on the compaction plugin). Two-tier compaction; copy-on-write, never DELETE — live context is derived from the newest compaction marker; old rows stay for forks and recall. "Facts exact, interpretations weak" epistemic constraint in the compaction prompt.

### Sessions
- Dispatch forks master by reference (`forked_from_thread`, `forked_at_seq`); resumable via continue.
- Every driver event journaled DB-first, then broadcast. Streaming deltas WS-only.
- **Live sibling awareness**: every turn boundary, `master-inject` delivers all master entries past the session's `lastSeenMasterSeq` cursor (own entries and others' targeted messages filtered out), journaled as `master_injected`; long-idle sessions get newest-N + a `read_master_thread` pointer.
- **Inter-session comms**: `post_to_master(text, to_session?)` tool → `session_message` entry; the master thread is the bus — durable, ordered, visible in the timeline. Advisory only; conflicting-file exclusion is a dispatch concern.
- Crash recovery: boot marks orphaned `running` sessions `killed`, mechanical summary written back; open turns closed with a synthetic `interrupted` marker (dsh's non-truncating repair).

### Journals & recall
- One append-only table, SQL-trigger immutable, never compacted. Master thread is lossy for the model, lossless in the record.
- Recall tools: `search_journal` (LIKE + `json_extract`, FTS5 later), `read_session`, `read_master_thread`. Summary → full journal in one hop via `session_id`.

## 4. Schema (drizzle, inside `store-sqlite`/`journal-sqlite`/`threads-sqlite` providers)

```ts
projects        id, name, rootPath, config_json, createdAt
threads         id, projectId, kind ('master'|'session'), forkedFromThread?, forkedAtSeq?, createdAt
thread_entries  id, threadId, seq (unique per thread),
                kind ('message'|'compaction'|'session_dispatch'|'session_turn_end'
                      |'session_summary'|'session_message'|'note'),
                sessionId?, toSessionId?, supersedesThroughSeq?,
                message_json, tokenEstimate, createdAt        -- append-only by convention
sessions        id, projectId, threadId, title, task, driver, modelId,
                status ('running'|'completed'|'failed'|'killed'),
                lastSeenMasterSeq, startedAt, endedAt?, summary?, tldr?,
                tokensIn, tokensOut, costUsd
journal_events  id, sessionId, ts, type, payload_json, tokensIn?, tokensOut?, costUsd?
                -- append-only via BEFORE UPDATE/DELETE RAISE(ABORT) triggers (raw SQL migration)
                -- type vocabulary is merge-extensible; plugins add their own durable event types
settings        key, value_json, updatedAt
```

Journal event types (base set): `session_started`, `turn`, `thinking`, `tool_call`, `tool_result`, `tool_error`, `permission_request`, `user_injected`, `master_injected`, `context_assembled`, `compaction`, `driver_error`, `session_ended`.

## 5. Storage location

Per-project: `<projectRoot>/.daydream-code/store.sqlite` — history travels with the project. Self-written `.gitignore` (`*.sqlite*`; committing history is opt-in). App-level registry (`~/.daydream-code/registry.sqlite`): known project paths, window state, keys via safeStorage. Core opens project DBs lazily; drizzle migrations run per-DB on open. WAL + `synchronous=NORMAL` + `foreign_keys=ON` + `busy_timeout=5000`; network-drive caveat documented.

**Config lives beside the data**: `<projectRoot>/.daydream-code/config.yml` is a flat **entry list** (dsh style) — `{ id, name: <module specifier>, config, disabled?, isolate? }`. Layering: built-in base bundle (~the default seam table above) → `~/.daydream-code/config.yml` (user layer) → project's `config.yml` → runtime patches. A patch replaces a row's whole `config`, no deep-merge. `daydream-code --dump-config` composes through the same patch algorithm as boot. Swapping Codex for Claude, another compactor, or a different journal backend = editing one row, no source changes. Entries without stable `id`s remount on every edit — docs say so loudly.

## 6. Stack

| Layer | Choice |
|---|---|
| Language | TypeScript, ESM, Node 22+ |
| Kernel | own Cordis-style microkernel (`packages/kernel`), zod for plugin Config schemas |
| DB | SQLite via better-sqlite3, drizzle-orm + drizzle-kit (inside storage provider plugins) |
| Drivers | `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk` — registry providers |
| Desktop | Electron main (supervisor) + React renderer (Vite), renderer panes as client plugins |
| Server | Fastify + WS as the `server-fastify` plugin |
| Repo | pnpm workspace, grouped by **capability family** (seam + providers + tools together), not by layer |

```
daydream-code/
  packages/
    kernel/            # context, fiber, events, service, effect  (NOT a plugin)
    boot/              # root ctx, loader, config layers, fail-loud
    shared/            # branded types, wire protocol
    store/             #   store/ (seam) store-sqlite/
    journal/           #   journal/ journal-sqlite/
    thread/            #   threads/ threads-sqlite/ master-writeback/ master-inject/
    compaction/        #   compaction/ compaction-two-tier/
    driver/            #   drivers/ driver-claude/ driver-codex/
    session/           #   sessions/ session-runner/ summarize-driver-model/ summarize-mechanical/
    recall/            #   tool-search-journal/ tool-read-session/ tool-read-master/ tool-post-to-master/
    normalize/         #   normalizer/ normalize-durable/
    server/            #   server/ server-fastify/
    settings/          #   settings/ settings-file/ credentials-safestorage/
    client/            #   ui-* renderer plugins
    bundle/            #   base/ (default entry list), headless/
  apps/
    cli/               # thin bin: parse args, boot(configPath)
    desktop/           # electron main + react shell hosting client plugin graph
```

## 7. Driver seam detail

```ts
abstract class SessionDriverRegistry extends Service { register(d: SessionDriver): () => void }
interface SessionDriver {
  id: 'claude' | 'codex' | string
  run(input: {
    workdir: string
    context: ModelMessage[]            // forked master thread, normalized
    task: string
    tools: HarnessToolset              // recall + post_to_master, exposed MCP-style
    onEvent(e: JournalEvent): void     // persisted before ack
    inject(): AsyncIterable<Injection> // user messages + master-thread updates
    permissions: PermissionPolicy
    signal: AbortSignal
  }): Promise<SessionResult>           // { summary, tldr, usage }
}
```

Both SDKs manage in-session context themselves; the 50k budget governs the master thread only. Driver events are mapped into the shared journal vocabulary; `execute`-value vs rendered-content kept as separate contracts (dsh's tool pattern) so the journal stores canonical data and the UI renders it.

## 8. Build order

1. **M0 — kernel + boot**: context/fiber/events/effects, loader, entry-list config with layering + `--dump-config`, fiber-state dump command. Tests: PENDING/reload semantics, effect disposal, waterfall short-circuit, duplicate-provide throws.
2. **M1 — storage seams**: store/journal/threads providers (drizzle, triggers, fork math, derived context). Tests incl. trigger enforcement + fork-below-compaction-cut.
3. **M2 — one session headless**: driver-claude + session-runner + master-writeback + summarizers; CLI `daydream-code run "<task>"`. Prove dispatch → journaled run → live turn-end entries on master.
4. **M3 — compaction + recall + comms**: compaction-two-tier, recall tools, post_to_master, master-inject. Prove: 3 concurrent sessions coordinating via master; session 3 recalls a compacted-out session-1 detail.
5. **M4 — server + desktop**: server-fastify, Electron shell, client plugin graph (timeline / session view / journal browser).
6. **M5 — driver-codex** + per-row driver swap demo (edit one config entry, no source change).
7. **M6 — polish**: crash recovery, cost dashboards, config-catalog generator + CI verifier, export/backup, HMR for plugins.

## Open questions (defaults chosen, flag if wrong)
- Concurrent sessions: allowed; master interleaves in arrival order — that *is* the awareness mechanism.
- ~~Open~~ decided: **live sibling awareness every turn** via `lastSeenMasterSeq` cursor injection.
- ~~Open~~ decided: **we build our own kernel** (~2.5k LOC Cordis-style, no dependency on `@deepseek-ai/cordis` or upstream cordis). dsh's kernel stays reference reading only.
- Codex SDK summary extraction shape TBD in M6/M5; `summarize-mechanical` is the guaranteed fallback.
