# Daydream Code

**A local, multi-session coding harness with a shared project memory.**

Daydream Code lets several coding-agent sessions work on the same project without losing the thread between them. Every project owns a durable master thread, every session journals its turns and tool calls, and completed work is summarized back into shared context for the sessions that follow.

The repository contains two interfaces over the same core:

- an Electron desktop app for day-to-day work across multiple projects; and
- a CLI for dispatching sessions, inspecting history, and running the local API.

> [!IMPORTANT]
> Daydream Code is currently a source-built project, not a packaged release. It is suitable for trusted local development environments. Review the [security model](#security-model) before running agents or exposing the API.

## What it does

- **Runs concurrent coding sessions.** Dispatch focused work to Claude or Codex and continue a session later without rebuilding its context from scratch.
- **Keeps a durable shared memory.** Sessions fork a project-level master thread and receive sibling updates at turn boundaries.
- **Records a lossless journal.** Prompts, assistant turns, tool calls, results, questions, errors, and usage are stored in an append-only SQLite journal.
- **Compacts without deleting history.** The live master context is reduced when it crosses its token budget, while full history and individual session journals remain available.
- **Supports multiple projects.** The desktop app retains loaded project cores, shows activity across them, and switches projects without stopping their running sessions.
- **Accepts images.** Paste, drop, or select PNG, JPEG, GIF, and WebP attachments.
- **Coordinates agents and people.** Sessions can ask the user, ask or message sibling sessions, search prior work, and publish durable notes to the master thread.
- **Exposes quick actions.** Save project commands as one-click actions; agents can suggest actions through the same tool surface.
- **Composes from plugins.** Storage, drivers, tools, compaction, routes, session orchestration, and the HTTP transport are replaceable configuration entries.

## Quick start

### Prerequisites

- [Node.js](https://nodejs.org/) 22 or newer
- [pnpm](https://pnpm.io/) 9 or newer
- Git
- Credentials for at least one model provider

The default driver is Claude and uses the local Claude Code authentication available to the process. The optional Codex driver uses `OPENAI_API_KEY`. Start Daydream Code from a shell where the provider you intend to use is already authenticated.

### Run the desktop app

```bash
git clone https://github.com/nokusukun/daydream-code.git
cd daydream-code
pnpm install
pnpm build
pnpm -C apps/desktop dev
```

On first launch, choose a project folder. Daydream Code creates that project’s local state on demand; it does not move or copy the project.

Useful desktop shortcuts on macOS:

| Shortcut | Action |
| --- | --- |
| `⌘N` | Start a new run |
| `⌘K` | Open the command palette |
| `⌘B` | Show or hide the sidebar |
| `⌘⇧O` | Switch project |
| `⌘⇧E` | Open the file tree |
| `⌘,` | Open settings |
| `⌘⌥I` | Open developer tools |

On Windows and Linux, use `Ctrl` in place of `⌘` for the in-app shortcuts.

### Build and run the production renderer locally

```bash
pnpm build
pnpm -C apps/desktop build
pnpm -C apps/desktop start
```

This produces and runs an unpackaged local build. Installer, signing, notarization, and release automation are not part of the repository yet.

## CLI

Build the workspace first, then invoke the CLI entry point:

```bash
pnpm build
node apps/cli/dist/bin.js --help
```

Common commands:

```bash
# Start a session in the current project.
node apps/cli/dist/bin.js run "fix the failing tests"

# Select a project, driver, model, and explicit session name.
node apps/cli/dist/bin.js run "audit the API" \
  --project /path/to/project \
  --driver claude \
  --model claude-sonnet-4-6 \
  --name audit-api

# Attach one or more images. Paths are resolved from the current directory.
node apps/cli/dist/bin.js run "recreate this layout" \
  --image ./reference.png \
  --image ./mobile.png

# Continue a session by its name or id.
node apps/cli/dist/bin.js continue audit-api "also document the findings"

# Inspect project state.
node apps/cli/dist/bin.js sessions
node apps/cli/dist/bin.js models
node apps/cli/dist/bin.js master
node apps/cli/dist/bin.js master --all
node apps/cli/dist/bin.js journal audit-api

# Diagnose the plugin composition.
node apps/cli/dist/bin.js dump-config
node apps/cli/dist/bin.js fiber-state
```

Every command accepts `--project <path>`; the default is the current working directory. `run` and `continue` stay attached until the session finishes and can present agent questions when the terminal is interactive. Add `--quiet` to suppress streamed journal events.

## How the memory model works

### Master thread

Each project has one long-lived master thread. Dispatches, turn summaries, completed-session summaries, notes, and inter-session messages are appended as work happens. A new session forks the current live context by reference, so it begins with the project’s accumulated knowledge rather than an isolated prompt.

The default compaction policy triggers above 50,000 estimated tokens and aims for a 30,000-token live context while retaining a 10,000-token verbatim tail. Compaction appends a digest that supersedes an older prefix; it never deletes the underlying thread entries or session journals.

### Sessions

A session is a resumable run owned by a model driver. Session names are derived from their task and are unique within the project. The CLI, API, desktop UI, and recall tools accept names anywhere they accept session ids.

At turn boundaries, a running session receives master-thread entries added since its last cursor. This is how concurrently running sessions learn what their siblings dispatched, decided, or completed.

### Journal

The journal is the source of truth for session activity. SQLite triggers enforce append-only behavior. Agents can search it, page through a session, inspect a window around a matching event, read full master history, and publish coordination notes without loading the entire database into context.

## Configuration

Configuration is a YAML list of plugin entries. Layers are composed in this order:

1. the built-in base bundle;
2. `~/.daydream-code/config.yml` for user-wide changes;
3. `<project>/.daydream-code/config.yml` for project changes; and
4. CLI `--enable` and `--disable` overrides.

Rows are matched by `id`. A later row replaces the earlier row’s entire `config` object; configuration is intentionally not deep-merged. Use `dump-config` to see the exact composition that will boot.

For example, this project configuration enables Codex and changes the master-thread budget:

```yaml
- id: driver-codex
  disabled: false

- id: compaction
  config:
    budgetTokens: 80000
    targetTokens: 45000
    keepTokens: 15000
```

To make Codex the default for new sessions, select it in desktop settings. The project’s default driver and model are stored in its SQLite project record; plugin implementation settings remain in the YAML layers.

## Local data

Daydream Code stores project-owned state under the project root:

```text
<project>/.daydream-code/
├── store.sqlite       # projects, sessions, journal, threads, and quick actions
├── store.sqlite-wal   # SQLite write-ahead log while the store is open
├── store.sqlite-shm
├── blobs/             # content-addressed image attachments
├── config.yml         # optional project plugin overrides
└── .gitignore         # generated exclusions for the database and blobs
```

Image bytes are kept out of SQLite. Thread and journal records store content-addressed references, while Claude receives base64 image blocks and Codex receives a workspace-local image path.

To back up an inactive project, copy its entire `.daydream-code` directory. For a live project, use a SQLite-aware backup rather than copying only `store.sqlite`, because committed data may still be in the WAL file.

## Local HTTP and WebSocket API

The server plugin is disabled by default. Start it for one project with:

```bash
node apps/cli/dist/bin.js serve --project /path/to/project
```

By default it listens on `127.0.0.1:4870`. `GET /health` is public; capability routes live under `/api/*`, and `/stream` provides live WebSocket events.

Set a bearer token in configuration before changing the bind address:

```yaml
- id: server
  config:
    host: 127.0.0.1
    port: 4870
    token: replace-with-a-long-random-secret
    bodyLimit: 25165824
```

Authenticated requests may send `Authorization: Bearer <token>`. Query-string tokens are supported for WebSocket clients but are easier to leak through logs and should be avoided where a header is possible.

## Architecture

The kernel is deliberately small: it provides contexts, services, fibers, lifecycle effects, and event dispatch. Nearly everything else is mounted as a plugin.

```text
apps/
├── cli/          command-line host
└── desktop/      Electron main process and React renderer

packages/
├── kernel/       contexts, fibers, effects, and events
├── boot/         configuration layers and plugin loading
├── config/       typed plugin-setting declarations
├── shared/       durable domain types
├── store/        per-project SQLite database and migrations
├── blobs/        content-addressed image storage
├── journal/      append-only event journal
├── thread/       master threads, forks, and writeback
├── tokens/       token estimation
├── normalize/    persistence-boundary message normalization
├── compaction/   copy-on-write master-thread compaction
├── summarize/    turn, title, and session summarization
├── questions/    user-question lifecycle
├── asks/         cross-session question lifecycle
├── actions/      persisted quick actions and agent tools
├── tools/        recall, user-question, and sibling tools
├── driver/       Claude, Codex, and scripted mock adapters
├── workspace/    read-only working-tree and diff views
├── routes/       transport-independent route registry
├── session/      session orchestration and recovery
├── settings/     live configuration inspection and writes
└── server/       Fastify HTTP and WebSocket transport
```

The default composition is defined in [`packages/boot/src/base.ts`](packages/boot/src/base.ts). A plugin with unmet dependencies remains `pending` rather than partially starting; `fiber-state` reports the missing services or load error.

## Security model

Daydream Code coordinates coding agents that can edit files and execute commands. Treat it as a local developer tool with the same trust level as the model provider’s coding agent.

- **Sessions default to `auto` permissions.** Claude runs with bypassed permission checks; Codex runs with `danger-full-access` and no approval prompts. Use only on repositories and tasks you trust.
- **Quick actions are host commands.** Clicking a saved command runs it at the active project root in the host login shell. It does not inherit the sandbox of the agent that suggested it. Review the command and its attribution before running it.
- **The API is not a public multi-tenant boundary.** It binds to loopback by default and has no token unless you configure one. Never bind it to a non-loopback interface without a strong token and an appropriate trusted-network boundary.
- **Keep provider credentials outside project config.** Use the providers’ normal environment or local authentication. If the server needs a token, prefer the user-level config file, restrict its file permissions, and never commit it or `.daydream-code` runtime state.
- **History is intentionally durable.** Prompts, tool arguments, tool results, and agent output can contain sensitive material. Protect backups and delete project state deliberately when retention is no longer appropriate.

## Development

```bash
# Type-check and compile all project references.
pnpm build

# Run the test suite.
pnpm test

# Build the Electron main process and production renderer.
pnpm -C apps/desktop build
```

The desktop app and Node test runner use different native ABIs for `better-sqlite3`. The desktop `dev` and `start` scripts switch to the Electron ABI automatically. Before running the Node-based test suite after launching Electron, switch it back:

```bash
pnpm -C apps/desktop rebuild:node
pnpm test
```

The next desktop `dev` or `start` command switches it to Electron again.

Tests live beside their owning workspace under `packages/*/tests`, `apps/cli/tests`, and `apps/desktop/tests`. The root Vitest configuration is the canonical full-suite entry point.

## Troubleshooting

### The desktop UI changed but a new API or IPC feature does not work

Vite can refresh the renderer, but it cannot replace the Electron main process or a running project core. Fully quit the app and restart `pnpm -C apps/desktop dev` after changes to Electron code, routes, migrations, drivers, or the base plugin bundle.

### `better-sqlite3` reports `NODE_MODULE_VERSION` mismatch

The native binding is built for the wrong runtime. Use the matching rebuild command:

```bash
# For tests and the CLI
pnpm -C apps/desktop rebuild:node

# For Electron (normally automatic)
pnpm -C apps/desktop rebuild:electron
```

### A plugin is missing even though it appears in config

Run:

```bash
node apps/cli/dist/bin.js dump-config
node apps/cli/dist/bin.js fiber-state
```

The first command shows which layer won; the second shows whether the plugin is active, pending on a missing service, disabled, or failed during load.

## Project status

Daydream Code is under active development. Database migrations are automatic, but there is not yet a stable public release contract, packaged installer, CI release pipeline, or published license. Pin deployments to a known commit and back up `.daydream-code` before testing migrations on important project history.
