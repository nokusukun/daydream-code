# daydream-code

A coding harness built around a **continuous journaled thread**. Every project has one master thread; sessions fork it, do work through an agent SDK, and stream summaries back. Nothing is ever lost — every tool call, turn, and thought lands in an append-only journal the agent can dig back into on demand.

And **everything is a plugin**: the drivers, the storage, the master-thread policy, the compactor, the recall tools, and the session loop itself are all replaceable from configuration. There is no privileged core to patch.

## The model

- **Master thread** — one per project, persisted for the project's lifecycle. Entries land *as sessions run*: `new session <id> with msg: "..."` on dispatch, `session <id> turn end, summary: ...` after every turn, a structured summary on completion, plus notes and inter-session messages. Budget-capped (50k tokens by default) with copy-on-write compaction — a `compaction` entry supersedes a prefix; nothing is ever deleted, so forks below the cut and full-history reads keep working.
- **Sessions** — fork the master thread by reference, run through a driver (Claude Agent SDK, Codex SDK, or a scripted mock), and are resumable via provider-native resume tokens. At every turn boundary a session receives a `[master thread update]` block with everything siblings did since its cursor — live sibling awareness.
- **Journal** — one append-only table, immutability enforced by SQL triggers, never compacted. The master thread is lossy for the model; the record is lossless.
- **Recall** — sessions get `search_journal`, `read_session`, `read_master_thread`, and `post_to_master` (the master thread doubles as a durable inter-session message bus).

## Layout

```
packages/
  kernel/       Cordis-style microkernel: Context proxy, fibers (PENDING→ACTIVE),
                effects, waterfall/serial/bail events. The only non-plugin.
  boot/         config layers (base bundle → user → project → overrides), loader
  shared/       vocabulary types
  store/        per-project sqlite (drizzle + better-sqlite3) + schema, ctx.store
  journal/      append-only journal seam + sqlite provider, ctx.journal
  thread/       threads seam + sqlite provider + master-writeback + master-inject
  tokens/       token estimation seam, ctx.tokens
  normalize/    persistence-boundary message normalizer, ctx.normalizer
  compaction/   copy-on-write master compactor, ctx.compaction
  summarize/    turn/session summarizer seam (mechanical provider), ctx.summarizer
  driver/       driver registry + claude / codex / mock adapters, ctx.drivers
  tools/        harness tool registry + recall tools, ctx.tools
  session/      session lifecycle seam + the runner, ctx.sessions
  server/       fastify + websocket API, ctx.server
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
node apps/cli/dist/bin.js continue <sessionId> "also update the docs"
node apps/cli/dist/bin.js sessions --project ...
node apps/cli/dist/bin.js master --project ...        # the master thread (--all for full history)
node apps/cli/dist/bin.js journal <sessionId>         # replay a session
node apps/cli/dist/bin.js dump-config                 # composed plugin config (what actually boots)
node apps/cli/dist/bin.js fiber-state                 # find silently-pending plugins
node apps/cli/dist/bin.js serve                       # HTTP/WS API for UIs
```

The Claude driver uses your local Claude Code auth; the Codex driver (config row `driver-codex`, disabled by default) uses Codex env auth. `--driver mock --enable driver-mock` runs a scripted driver for tests.

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
