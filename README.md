# daydream-code

A coding harness built around a **continuous journaled thread**. Every project has one master thread; sessions fork it, do work through an agent SDK, and stream summaries back. Nothing is ever lost — every tool call, turn, and thought lands in an append-only journal the agent can dig back into on demand.

And **everything is a plugin**: the drivers, the storage, the master-thread policy, the compactor, the recall tools, the HTTP surface, and the session loop itself are all replaceable from configuration. There is no privileged core to patch.

## The model

- **Master thread** — one per project, persisted for the project's lifecycle. Entries land *as sessions run*: `new session <name> with msg: "..."` on dispatch, `session <name> turn end, summary: ...` after every turn, a structured summary on completion, plus notes and inter-session messages. Budget-capped (50k tokens by default) with copy-on-write compaction — a `compaction` entry supersedes a prefix; nothing is ever deleted, so forks below the cut and full-history reads keep working.
- **Sessions** — fork the master thread by reference, run through a driver (Claude Agent SDK, Codex SDK, or a scripted mock), and are resumable via provider-native resume tokens. Each one gets a human-readable name slugged from its task (`fix-failing-tests`, numbered on collision) and unique per project; the CLI, the API, and the recall tools take a name anywhere they take an id. At every turn boundary a session receives a `[master thread update]` block with everything siblings did since its cursor — live sibling awareness.
- **Journal** — one append-only table, immutability enforced by SQL triggers, never compacted. The master thread is lossy for the model; the record is lossless.
- **Attachments** — images (png/jpeg/gif/webp) attach to a dispatch or to any mid-session message. Bytes land content-addressed in `<project>/.daydream-code/blobs`, never in the database: the thread row keeps a reference, so journal search stays clean and token cost is charged by pixels rather than by base64 length. Each driver gets the form its SDK takes — base64 blocks for Claude, a `local_image` path for Codex.
- **Recall** — sessions get `search_journal`, `read_session`, `read_master_thread`, and `post_to_master` (the master thread doubles as a durable inter-session message bus).

## Layout

```
packages/
  kernel/       Cordis-style microkernel: Context proxy, fibers (PENDING→ACTIVE),
                effects, waterfall/serial/bail events. The only non-plugin.
  boot/         config layers (base bundle → user → project → overrides), loader
  shared/       vocabulary types
  store/        per-project sqlite (drizzle + better-sqlite3) + schema, ctx.store
  blobs/        content-addressed image store on disk, ctx.blobs
  journal/      append-only journal seam + sqlite provider, ctx.journal
  thread/       threads seam + sqlite provider + master-writeback + master-inject
  tokens/       token estimation seam, ctx.tokens
  normalize/    persistence-boundary message normalizer, ctx.normalizer
  compaction/   copy-on-write master compactor, ctx.compaction
  summarize/    turn/session summarizer seam (mechanical provider), ctx.summarizer
  driver/       driver registry + claude / codex / mock adapters, ctx.drivers
  tools/        harness tool registry + recall tools, ctx.tools
  routes/       transport-agnostic HTTP route registry, ctx.routes
  session/      session lifecycle seam + the runner, ctx.sessions
  server/       fastify + websocket transport for ctx.routes, ctx.server
apps/
  cli/          daydream-code CLI
  desktop/      Electron + React app
```

Project state lives in `<project>/.daydream-code/store.sqlite` — history travels with the project. Config is a flat entry list in `<project>/.daydream-code/config.yml`, layered over a base bundle; patching a row replaces its whole `config` (no deep merge). Swapping the driver, the compactor, or the journal backend is a one-row edit.

## Use

```powershell
pnpm install
pnpm build

node apps/cli/dist/bin.js run "fix the failing tests" --project C:\path\to\project
node apps/cli/dist/bin.js continue fix-failing-tests "also update the docs"
node apps/cli/dist/bin.js run "what is wrong here?" --image shot.png   # repeatable
node apps/cli/dist/bin.js sessions --project ...
node apps/cli/dist/bin.js models --project ...        # each driver's selectable models
node apps/cli/dist/bin.js master --project ...        # the master thread (--all for full history)
node apps/cli/dist/bin.js journal fix-failing-tests   # replay a session (name or id)
node apps/cli/dist/bin.js dump-config                 # composed plugin config (what actually boots)
node apps/cli/dist/bin.js fiber-state                 # find silently-pending plugins
node apps/cli/dist/bin.js serve                       # HTTP/WS API for UIs
```

The Claude driver uses your local Claude Code auth; the Codex driver (config row `driver-codex`, disabled by default) uses Codex env auth. `--driver mock --enable driver-mock` runs a scripted driver for tests.

Each driver ships a model catalog (`GET /api/models`, `daydream-code models`, and the desktop composer's model picker — searchable, grouped per driver, with starred favorites). A config row replaces a driver's list wholesale, e.g. `{ id: "driver-claude", config: { models: [{ id: "claude-opus-5", label: "Opus 5" }] } }`.

Example project `config.yml` swapping the driver default and budget:

```yaml
- id: driver-codex
  disabled: false
- id: compaction
  config: { budgetTokens: 80000, keepTokens: 15000 }
```

## Verify

```powershell
pnpm exec tsc -b     # strict, project references
pnpm test            # kernel, storage, threads, compaction, drivers, server, e2e
```
