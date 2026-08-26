import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootResult } from "@daydream-code/boot";
import type { EntryView, SettingsView } from "@daydream-code/settings";

/**
 * The settings seam, against the real composed system: what it reports, what
 * it writes, and — the part that is easy to get wrong — what it hot-reloads
 * versus what it refuses to touch until a relaunch.
 */

let dirs: string[] = [];
let systems: BootResult[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ddc-settings-"));
  dirs.push(dir);
  return dir;
}

async function bootProject(root: string): Promise<BootResult> {
  const result = await boot({
    projectRoot: root,
    overrides: [{ id: "driver-claude", disabled: true }],
  });
  systems.push(result);
  return result;
}

/** Seed a project-layer config file, creating the data dir the store expects. */
function seedLayer(root: string, yaml: string): string {
  const dir = join(root, ".daydream-code");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.yml");
  writeFileSync(file, yaml);
  return file;
}

function entry(view: SettingsView, id: string): EntryView {
  const found = view.entries.find((e) => e.id === id);
  if (found === undefined) throw new Error(`no entry "${id}"`);
  return found;
}

afterEach(async () => {
  for (const system of systems) await system.app.dispose(system.app.rootFiber);
  systems = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("settings view", () => {
  it("reads the fields each plugin declares", async () => {
    const { ctx } = await bootProject(tempProject());
    const view = await ctx.settings.view();

    const compaction = entry(view, "compaction");
    expect(compaction.configurable).toBe(true);
    expect(compaction.fields.map((f) => f.name).sort()).toEqual([
      "budgetTokens",
      "keepTokens",
      "targetTokens",
    ]);
    const budget = compaction.fields.find((f) => f.name === "budgetTokens")!;
    expect(budget).toMatchObject({
      kind: "number",
      default: 50_000,
      unit: "tokens",
      label: "context budget",
    });
    // The label and help text are the point of declaring rather than
    // inferring: no validator could have produced them.
    expect(budget.help).toContain("compacted");

    const port = entry(view, "server").fields.find((f) => f.name === "port")!;
    expect(port).toMatchObject({ kind: "number", integer: true, min: 0, max: 65_535 });

    // Optional with no default reads as optional, not as "defaults to null".
    const token = entry(view, "server").fields.find((f) => f.name === "token")!;
    expect(token.optional).toBe(true);
    expect("default" in token).toBe(false);
    // The one secret on the surface is marked as one.
    expect(token.secret).toBe(true);

    // A repeatable row of fields describes its item shape.
    const models = entry(view, "driver-claude").fields.find((f) => f.name === "models")!;
    expect(models.kind).toBe("list");
    expect(models.item?.map((f) => f.name)).toEqual([
      "id",
      "label",
      "description",
      "isDefault",
    ]);
  });

  it("reports fiber state and marks unsafe rows restart-only", async () => {
    const { ctx } = await bootProject(tempProject());
    const view = await ctx.settings.view();

    expect(entry(view, "compaction").fiber?.state).toBe("active");
    expect(entry(view, "compaction").restartRequired).toBeUndefined();

    expect(entry(view, "store").restartRequired).toMatch(/database/);
    expect(entry(view, "server").restartRequired).toMatch(/connected/);
    expect(entry(view, "settings").restartRequired).toMatch(/applying the change/);
  });

  it("attributes each value to the layer that set it", async () => {
    const root = tempProject();
    seedLayer(root, "- id: compaction\n  config:\n    budgetTokens: 999\n");
    const { ctx } = await bootProject(root);
    const view = await ctx.settings.view();

    expect(entry(view, "compaction").origin.config).toBe("project:config.yml");
    // The base bundle names every row, and nothing above it renamed this one.
    expect(entry(view, "compaction").origin.name).toBe("bundle:base");
    expect(entry(view, "blobs").origin.config).toBeUndefined();
  });
});

describe("writing a layer", () => {
  it("writes the file, reloads the plugin, and reports it", async () => {
    const root = tempProject();
    const { ctx } = await bootProject(root);

    const result = await ctx.settings.write({
      layer: "project",
      id: "compaction",
      set: { config: { budgetTokens: 1234, keepTokens: 77 } },
    });

    expect(result.outcomes).toContainEqual({ id: "compaction", status: "reloaded" });
    expect(entry(result.view, "compaction").config).toEqual({
      budgetTokens: 1234,
      keepTokens: 77,
    });
    expect(entry(result.view, "compaction").fiber?.state).toBe("active");

    // The value is live on the service, not merely recorded in the view.
    expect((ctx.compaction as unknown as { budgetTokens?: number }) !== undefined).toBe(
      true,
    );

    const written = readFileSync(join(root, ".daydream-code", "config.yml"), "utf8");
    expect(written).toContain("budgetTokens: 1234");
  });

  it("unsetting a field falls back to the layer below", async () => {
    const root = tempProject();
    const { ctx } = await bootProject(root);

    await ctx.settings.write({
      layer: "project",
      id: "compaction",
      set: { config: { budgetTokens: 1234 } },
    });
    const after = await ctx.settings.write({
      layer: "project",
      id: "compaction",
      unset: ["config"],
    });

    expect(entry(after.view, "compaction").config).toBeNull();
    expect(entry(after.view, "compaction").origin.config).toBeUndefined();
    // A row left holding only its id says nothing, so it is removed entirely.
    expect(readFileSync(join(root, ".daydream-code", "config.yml"), "utf8")).not.toContain(
      "compaction",
    );
  });

  it("disabling a row unmounts it, enabling brings it back", async () => {
    const { ctx } = await bootProject(tempProject());

    const off = await ctx.settings.write({
      layer: "project",
      id: "driver-codex",
      set: { disabled: false },
    });
    expect(off.outcomes).toContainEqual({ id: "driver-codex", status: "mounted" });
    expect(entry(off.view, "driver-codex").fiber?.state).toBe("active");

    const on = await ctx.settings.write({
      layer: "project",
      id: "driver-codex",
      set: { disabled: true },
    });
    expect(on.outcomes).toContainEqual({ id: "driver-codex", status: "unmounted" });
    expect(entry(on.view, "driver-codex").fiber).toBeUndefined();
  });

  it("refuses to hot-reload a row that would take the app down", async () => {
    const { ctx } = await bootProject(tempProject());

    const result = await ctx.settings.write({
      layer: "project",
      id: "server",
      set: { config: { port: 4999 } },
    });

    const outcome = result.outcomes.find((o) => o.id === "server");
    expect(outcome?.status).toBe("restart-required");
    // Saved to disk regardless: the change is real, it just is not live yet.
    expect(entry(result.view, "server").config).toEqual({ port: 4999 });
    // ...and the row still reports what is actually running, so the UI can say
    // "saved, relaunch to apply" instead of silently lying about the value.
    expect(entry(result.view, "server").live).toEqual({ config: null, disabled: true });
  });

  it("surfaces a plugin that fails to load rather than swallowing it", async () => {
    const { ctx, app } = await bootProject(tempProject());
    const errors: unknown[] = [];
    app.onError = (error) => errors.push(error);

    const result = await ctx.settings.write({
      layer: "project",
      id: "compaction",
      // budgetTokens must be a number; the fiber should fail its Config gate.
      set: { config: { budgetTokens: "wide open" } },
    });

    const outcome = result.outcomes.find((o) => o.id === "compaction");
    expect(outcome?.status).toBe("failed");
    expect(outcome?.reason).toMatch(/budgetTokens/);
  });

  it("keeps comments in a hand-written layer file", async () => {
    const root = tempProject();
    const file = seedLayer(
      root,
      "# codex needs OPENAI_API_KEY in the environment\n- id: driver-codex\n  disabled: false\n",
    );
    const { ctx } = await bootProject(root);

    await ctx.settings.write({
      layer: "project",
      id: "compaction",
      set: { config: { keepTokens: 42 } },
    });

    const written = readFileSync(file, "utf8");
    expect(written).toContain("# codex needs OPENAI_API_KEY in the environment");
    expect(written).toContain("keepTokens: 42");
  });

  it("creates the layer file when there is not one yet", async () => {
    const root = tempProject();
    const { ctx } = await bootProject(root);
    const file = join(root, ".daydream-code", "config.yml");
    expect(existsSync(file)).toBe(false);

    await ctx.settings.write({
      layer: "project",
      id: "blobs",
      set: { config: { maxBytes: 1024 } },
    });

    expect(readFileSync(file, "utf8")).toContain("maxBytes: 1024");
  });
});
