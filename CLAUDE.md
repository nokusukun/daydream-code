# CLAUDE.md — building features in daydream-code

daydream-code is a coding harness built on a Cordis-style microkernel. **The kernel
(`packages/kernel`) is the only thing that is not a plugin.** Storage, the journal, the
master-thread policy, the compactor, the summarizer, the drivers, the harness tools, the
session loop itself, and the HTTP/WS server are all plugins mounted from configuration.

So: **a new feature is a new plugin, or a new provider for an existing seam. It is
almost never an edit to a core file.** Before writing code, decide which of the six
shapes below the feature takes. If you cannot fit it into one, that is the signal to add
a *seam*, not the signal to patch a consumer.

---

## 1. The kernel contract

Read `packages/kernel/src/` once before your first plugin. Everything below is enforced
there, not by convention.

**A plugin** is a function, a class, or an `{ apply }` object, default-exported from a
module:

```ts
export const name = "my-thing";
export const inject = ["journal", "threads"] as const;
export const Config = z.object({ … }).prefault({});
export function apply(ctx: Context, config: z.infer<typeof Config>): void { … }
export default { name, inject, Config, apply };
```

- `inject` — service names the plugin *requires*. The fiber sits in `pending` until all
  are present, loads when they arrive, and **unwinds back to `pending`** if a provider
  later unloads. Use this for hard dependencies. Use `ctx.get(name)` only for genuinely
  optional ones.
- `Config` — any Standard Schema validator (zod 3.24+, valibot, arktype). Validated
  before `apply` runs; invalid config fails the fiber loudly rather than half-loading.
  Give every field a default and end with `.prefault({})` so the plugin still boots when
  its config row has no `config:` key. **Declare it with `defineConfig` from
  `@daydream-code/config`** rather than hand-rolling zod (§2.1) — that is what makes the
  setting appear in the settings window.
- `apply(ctx, config)` — may be async. Register everything through `ctx`; never reach
  into globals.

**`ctx` is a proxy.** Any service name resolves as a property: `ctx.journal`,
`ctx.store.db`, `ctx.threads`. Assigning to a provided name throws (`NOT_PROVIDER`) —
services are replaced by swapping their provider, never by mutation.

**Everything you register must be an effect.** `ctx.on`, `ctx.provide`, and
`ctx.effect` all tie cleanup to the fiber, and disposers run in reverse registration
order when it unloads. If you start a timer, open a socket, or write to a registry
without `ctx.effect`, unloading the plugin leaks it.

```ts
ctx.effect(() => {
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}, "heartbeat");
```

**Events** are declared by declaration merging and documented with their dispatch mode:

```ts
declare module "@daydream-code/kernel" {
  interface Context { myThing: MyThing }
  interface Events {
    /** @mode emit — fired after the row is durably committed. */
    "mything/changed"(record: MyRecord): void;
  }
}
```

Five modes, and the mode is part of the event's public contract — pick it deliberately
and write `@mode` in the doc comment:

| Mode | Use it for |
|---|---|
| `emit` | fire-and-forget notification; sync; listener errors go to `onError` |
| `parallel` | awaited notification, all listeners concurrently |
| `serial` | awaited, in order, first non-`undefined` wins |
| `bail` | sync, in order, first non-`undefined` wins |
| `waterfall` | around-middleware: `(…args, next)`; listeners transform, or veto by not calling `next()` |

Name events `family/verb`: `journal/append`, `session/pre-dispatch`,
`normalize/persist`.

**Isolation.** `ctx.isolate("store")` gives a subtree its own realm for one service name,
so two providers of the same service can coexist (that is how the desktop app could host
several projects). A config entry can request it with `isolate: [store, journal]`.

---

## 2.1 Declaring configuration

A plugin's config is declared once, with `defineConfig`, and that one declaration
produces both the validator the kernel enforces and the descriptors the settings window
renders:

```ts
import { defineConfig, field, type ConfigOf } from "@daydream-code/config";

export const { Config, settings } = defineConfig({
  budgetTokens: field.number({
    label: "context budget",
    help: "the master thread is compacted once its live context passes this.",
    default: 50_000,
    min: 0,
    unit: "tokens",
  }),
  token: field.string({ label: "bearer token", optional: true, secret: true, restart: true }),
});

// Classes: `static Config` / `static settings`.
// Object plugins: `export default { name, inject, Config, settings, apply }`.
```

Builders: `field.string` / `number` / `boolean` / `enum` / `list` (a repeatable row of
fields) / `json` (an escape hatch, still validated by a schema you supply). Every builder
takes `label` plus optional `help`, `group`, `advanced`, `secret`, and `restart`.

- **Export `settings` next to `Config`.** A plugin that exports only `Config` still loads
  and still validates; it simply shows up in the settings window as "declares no
  settings". Nothing is inferred from the validator — there is no introspection.
- **Do not tighten bounds you are not enforcing today.** `min`/`max`/`integer` become
  real validation, so adding one to an existing plugin can fail configs that used to
  load (and tests that used to pass).
- `ConfigOf<typeof Config>` is the value type, so plugins need no zod import.

---

## 2.2 Changing configuration at runtime

`ctx.settings` reads the whole composed surface (rows, declared fields, which layer set
each value, live fiber state) and writes one row into one layer. Writing recomposes,
diffs by id, and unloads/remounts only what changed — which works because registrations
are effects and the route registry resolves per request.

Three rows are **never** hot-reloaded, by policy in `packages/settings/src/live.ts`:
`store/*` (it owns the open database and everything depends on it), `server/*` (the
caller is connected through it), and `settings/*` (it is the plugin doing the reload).
`session/*`, `journal/*` and `thread/*` are refused while a session is running, because a
turn in flight writes through them. Those writes still land on disk and are reported as
`restart-required`, and the row keeps reporting what is actually running in `live`.

---

## 2. The seams you can plug into

Each seam lives in its package's `src/index.ts`; providers are sibling files exported on
a subpath (`@daydream-code/journal/sqlite`).

| Service | Kind | Seam | Default provider |
|---|---|---|---|
| `ctx.store` | exclusive | `@daydream-code/store` | `store/sqlite` |
| `ctx.settings` | exclusive | `@daydream-code/settings` | `settings/live` |
| `ctx.blobs` | exclusive | `@daydream-code/blobs` | `blobs/fs` |
| `ctx.tokens` | exclusive | `@daydream-code/tokens` | `tokens/estimate` |
| `ctx.normalizer` | exclusive + waterfalls | `@daydream-code/normalize` | `normalize/service` |
| `ctx.journal` | exclusive | `@daydream-code/journal` | `journal/sqlite` |
| `ctx.threads` | exclusive | `@daydream-code/thread` | `thread/sqlite` |
| `ctx.compaction` | exclusive | `@daydream-code/compaction` | `compaction/two-tier` |
| `ctx.summarizer` | exclusive | `@daydream-code/summarize` | `summarize/mechanical` |
| `ctx.questions` | registry | `@daydream-code/questions` | `questions/registry` |
| `ctx.asks` | registry | `@daydream-code/asks` | `asks/registry` |
| `ctx.tools` | registry | `@daydream-code/tools` | `tools/registry` |
| `ctx.routes` | registry | `@daydream-code/routes` | `routes/registry` |
| `ctx.drivers` | registry | `@daydream-code/driver` | `driver/claude`, `driver/codex`, `driver/mock` |
| `ctx.sessions` | exclusive | `@daydream-code/session` | `session/runner` |
| `ctx.routes` | registry | `@daydream-code/routes` | `routes/registry` |
| `ctx.server` | exclusive | `@daydream-code/server` | `server/fastify` |
| `ctx.composition` | exclusive | `@daydream-code/boot` | mounted by `boot()` |

**Exclusive seam** = abstract class extending `Service`, one provider per realm; a
second provider throws `DUPLICATE_SERVICE`. **Registry seam** = concrete `Service` that
others register into, always taking the caller's `ctx` so the registration unwinds with
the *caller*:

```ts
register(owner: Context, definition: HarnessToolDefinition): Disposer {
  return owner.effect(() => { … }, `tool(${definition.name})`);
}
```

Follow that signature for any new registry. Registering against the registry's own ctx
is a bug: the entry would outlive the plugin that owns it.

---

## 3. Pick a shape

**a. Consumer plugin — listen to events, register into registries.** The default and by
far the most common. No new seam, no new package. Examples:
`packages/thread/src/master-writeback.ts` (turns session lifecycle events into
master-thread entries), `packages/thread/src/master-inject.ts`,
`packages/normalize/src/index.ts`'s `durableRules`.

**b. New harness tool** the agent can call. Register into `ctx.tools`. Example:
`packages/tools/src/recall.ts`, `packages/tools/src/ask.ts`.

**c. New driver / new provider for an existing seam.** Implement the interface, register
or `provide`, ship as a subpath. Example: `packages/driver/src/mock.ts`.

**d. New seam.** Only when the feature is a *capability with more than one plausible
implementation* and consumers must not know which one they got. Costs a package. Write
the abstract `Service`, the `declare module` block, and at least one provider.

**e. New HTTP route.** Register into `ctx.routes`. Each capability package ships its own
surface next to the thing it exposes — `packages/journal/src/routes.ts`,
`packages/session/src/routes.ts`. **Never add a route by editing the server.**

**f. Host-app surface (CLI command, desktop view).** `apps/cli` and `apps/desktop` are
hosts, not plugins: they boot the composed system and consume it. The backend capability
still has to exist as a plugin first.

---

## 4. Recipes

### Consumer plugin (start here)

`packages/<family>/src/my-feature.ts`:

```ts
import type { Context } from "@daydream-code/kernel";
import type { SessionRecord } from "@daydream-code/shared";
// Type-only side-effect imports pull in the `declare module` blocks that make
// ctx.threads / ctx.journal exist. Without them the proxy properties don't typecheck.
import type {} from "@daydream-code/thread";
import type {} from "@daydream-code/journal";

/**
 * Consumer plugin: <what it does, and why it lives at this seam rather than
 * inside the runner>.
 */
const myFeature = {
  name: "my-feature",
  inject: ["threads", "journal"],
  apply(ctx: Context) {
    ctx.on("session/ended", (session: SessionRecord) => {
      ctx.threads.append({ … });
    });
  },
};

export default myFeature;
```

Then add a row to the base bundle (§5).

### Harness tool

```ts
const myTools = {
  name: "my-tools",
  inject: ["tools", "journal"],
  apply(ctx: Context) {
    ctx.tools.register(ctx, {
      name: "do_the_thing",
      description: "One paragraph the model reads. Say when NOT to call it.",
      parameters: {
        type: "object",
        properties: { target: { type: "string", description: "…" } },
        required: ["target"],
      },
      async execute(args, run) {
        // Validate your own arguments. The Claude adapter's JSON-Schema -> zod
        // conversion is structural, not enforcing: bounds do not survive it.
        return { ok: true };
      },
    });
  },
};
export default myTools;
```

`execute` returns the canonical JSON value; formatting is the consumer's problem.
`run` carries `{ sessionId, projectRoot }`.

### HTTP route

Routes are data in a registry, not calls against a framework. The transport mounts one
catch-all and resolves each request through `ctx.routes`, so a route plugin that loads
after the server is listening — or unloads when its provider goes away — takes effect
like any other effect.

`packages/<family>/src/routes.ts`:

```ts
import type { Context } from "@daydream-code/kernel";
import { HttpError, intParam, type RouteRequest } from "@daydream-code/routes";
import type {} from "./index.js";

const myRoutes = {
  name: "my-routes",
  inject: ["routes", "myThing"],
  apply(ctx: Context) {
    ctx.routes.registerAll(ctx, [
      { method: "GET", path: "/api/things", handle: () => ctx.myThing.list() },
      {
        method: "GET",
        path: "/api/things/:id",
        handle: (req: RouteRequest) => {
          const thing = ctx.myThing.get(req.params.id!);
          if (thing === undefined) throw new HttpError(404, `unknown thing: ${req.params.id}`);
          return thing;
        },
      },
    ]);
  },
};
export default myRoutes;
```

The contract is deliberately small, because a handler that could touch the reply object
would be written against one transport:

- The return value **is** the JSON body, sent with status 200. Returning nothing is a 204.
- Any other status is an `HttpError` thrown from the handler. Anything else that escapes
  is a 500 — an unrecognized throw is a bug, not a status a client should interpret.
- `path` takes static segments and `:name` params, no wildcards. Two routes that would
  match the same requests collide at registration; where patterns overlap, more literal
  segments win (`/api/journal/search` over `/api/journal/:id`).
- `public: true` exempts a route from the server's bearer token. `/health` is the only
  one that should ever set it.

Put the routes in the package that owns the capability, and let the dependency direction
decide when they cannot go there: `POST /api/sessions/:id/answer` lives on the session
routes rather than the questions routes because it has to resolve `:id` first, and
`session` depends on `questions`, not the reverse.

### New provider for an exclusive seam

```ts
export default class JournalPostgres extends Journal {
  static inject = ["store"];          // static on classes, exported const on objects
  constructor(ctx: Context) { super(ctx); }   // super() calls ctx.provide("journal", this)
  append(input: JournalEventInput): JournalEvent { … }
  …
}
```

Swap it in with a one-row config patch — no code changes anywhere else:

```yaml
- id: journal
  name: "@daydream-code/journal/postgres"
  config: { url: "postgres://…" }
```

### New seam (new package)

1. `packages/<name>/src/index.ts` — the `declare module` block, the interfaces, the
   abstract `Service` subclass whose constructor calls `super(ctx, "<name>")`.
2. `packages/<name>/src/<provider>.ts` — a default-exported provider.
3. Trivial re-export providers are fine: `export { MyThing as default } from "./index.js"`
   (see `packages/tools/src/registry.ts`).
4. Document every event's `@mode` at the declaration.

---

## 5. Wiring checklist

A new plugin is not reachable until all of these are done. Missing one produces either a
silent no-op or a loud mount failure — check `dump-config` and `fiber-state` when
something does not run.

For a **new file in an existing package**:
- [ ] If it takes config, declare it with `defineConfig` and export `settings` (§2.1).
- [ ] Add a row to `packages/boot/src/base.ts` — `{ id, name: "@daydream-code/<pkg>/<file>" }`.
  The `id` is stable identity: config layers patch by it and the loader diffs by it. New
  optional features ship `disabled: true`.
- [ ] Row order matters only for readability; load order is resolved by `inject`.

For a **new package**:
- [ ] `packages/<name>/package.json` — copy `packages/journal/package.json`: `"type": "module"`,
  `main`/`types` to `dist`, and the `"./*"` subpath export block so
  `@daydream-code/<name>/<provider>` resolves.
- [ ] `packages/<name>/tsconfig.json` — extend `../../tsconfig.base.json`, `rootDir: src`,
  `outDir: dist`, and a `references` entry for every workspace dep.
- [ ] Root `tsconfig.json` — add `{ "path": "./packages/<name>" }`.
- [ ] Add it as a `workspace:*` dependency of any package that imports it **and** of the
  host apps (`apps/cli`, `apps/desktop`), plus their tsconfig `references`. Bare
  specifiers in config rows resolve from `resolutionPaths` (the host app dir) and then
  the project root — a package the host does not depend on will not resolve.
- [ ] Base bundle row.
- [ ] `pnpm install` (workspace globs already cover `packages/*`).

---

## 6. Invariants

These are load-bearing. Violating one usually still passes tests locally and breaks a
different subsystem later.

- **Never patch a core file to add a feature.** If the change reads as "add a hook here",
  add the *event* (with a documented mode) and put the behavior in a plugin.
- **DB-first, then broadcast.** Persist, then emit. A subscriber must never see an event
  whose row is not durable (`packages/journal/src/sqlite.ts`).
- **The journal is append-only and never compacted.** Immutability is enforced by SQL
  triggers, not convention. Compaction is copy-on-write on the *master thread*: a
  `compaction` entry supersedes a prefix, nothing is deleted, so forks below the cut keep
  working.
- **Config patches replace whole fields; there is no deep merge.** A row's `config` lives
  in exactly one layer. Layer order: base bundle → `~/.daydream-code/config.yml` →
  `<project>/.daydream-code/config.yml` → CLI overrides.
- **`swap-by-config` is the test of a good design.** If a reviewer cannot replace your
  component with a one-row edit, it is wired too tightly.
- **Registrations belong to the caller's ctx**, not the registry's.
- **The server serves no routes of its own.** If a change adds an endpoint to
  `packages/server`, it is in the wrong package — the only things that live there are the
  transport and the `/stream` socket.
- **No import cycles.** They show up as build failures under project references. When two
  packages need each other, one of them reads the shared table directly instead —
  `packages/tools/src/recall.ts` resolves session names through `ctx.store` rather than
  `ctx.sessions` for exactly this reason, and says so in a comment.
- **Sessions are addressable by name anywhere they are addressable by id.** Master-thread
  prose names sessions, and models read that prose. Route lookups through
  `sessions.resolve(idOrName)`.
- **Adding a table**: append a new migration to `packages/store/src/migrations.ts` and
  mirror it exactly in `schema.ts`. Never edit a shipped migration; they are gated on
  `PRAGMA user_version` and each runs in one transaction.
- **`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on.** Write
  `...(x !== undefined ? { x } : {})` rather than `x: undefined`.
- **Comments explain the non-obvious *why*.** This codebase's comments carry reasoning
  (see `packages/journal/src/index.ts`'s `excludeTail`, `master-inject.ts`'s
  `elidesSummary`). Match that density; do not narrate what the code already says.

---

## 7. Testing

Tests live in `packages/<name>/tests/*.test.ts` and `apps/<app>/tests/`. Vitest aliases
`@daydream-code/*` straight to `src`, so no build step is needed.

**Unit**: mount the plugin on a bare `App` and settle.

```ts
const app = new App();
const ctx = app.rootCtx;
ctx.plugin(myFeature, { … });
await app.settle();
expect(fiber.state).toBe("active");
```

`app.settle()` is required — mounting is async and dependency-driven. Set
`app.onError = (e) => errors.push(e)` so a failing fiber does not just log.

**End-to-end**: boot the real composition against a temp project with the mock driver
(`apps/cli/tests/integration.test.ts` is the model):

```ts
await boot({
  projectRoot: tempDir,
  overrides: [
    { id: "driver-mock", disabled: false, config: { id: "mock", script } },
    { id: "driver-claude", disabled: true },
  ],
});
```

Always dispose (`app.dispose(app.rootFiber)`) in `afterEach` — the sqlite file stays
locked otherwise. `boot({ base })` replaces the bundle entirely when a test needs a
minimal composition.

---

## 8. Verify

```bash
pnpm exec tsc -b          # strict, project references — run this, not just tests
pnpm test
node apps/cli/dist/bin.js dump-config    # the composed config that actually boots
node apps/cli/dist/bin.js fiber-state    # find plugins silently stuck in `pending`
```

A plugin that is `pending` with a non-empty `missing` list means an `inject` name is
unprovided (typo, disabled row, or a missing base-bundle entry). A plugin that never
appears at all means no config row points at it.
