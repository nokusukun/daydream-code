import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig, field, settingsOf } from "@daydream-code/config";

/**
 * The declaration DSL. The property worth protecting is that one call produces
 * a validator and a descriptor list that agree — so these tests assert on both
 * sides of every case rather than on the descriptors alone.
 */

describe("defineConfig", () => {
  it("validates and describes the same fields", () => {
    const { Config, settings } = defineConfig({
      host: field.string({ label: "bind address", default: "127.0.0.1" }),
      port: field.number({ label: "port", default: 4870, integer: true, min: 0, max: 65_535 }),
    });

    expect(Config.parse(undefined)).toEqual({ host: "127.0.0.1", port: 4870 });
    expect(Config.parse({ port: 9000 })).toEqual({ host: "127.0.0.1", port: 9000 });
    expect(settings.map((s) => s.name)).toEqual(["host", "port"]);
    expect(settings[1]).toMatchObject({ kind: "number", integer: true, min: 0, max: 65_535 });
  });

  it("rejects what the descriptor says it would reject", () => {
    const { Config } = defineConfig({
      port: field.number({ label: "port", default: 4870, integer: true, min: 0, max: 65_535 }),
    });

    expect(Config.safeParse({ port: 70_000 }).success).toBe(false);
    expect(Config.safeParse({ port: 1.5 }).success).toBe(false);
    expect(Config.safeParse({ port: "8080" }).success).toBe(false);
  });

  it("carries the metadata a validator cannot express", () => {
    const { settings } = defineConfig({
      token: field.string({
        label: "bearer token",
        help: "required on every request.",
        optional: true,
        secret: true,
        restart: true,
      }),
    });

    expect(settings[0]).toMatchObject({
      label: "bearer token",
      secret: true,
      restart: true,
      optional: true,
    });
    // No default declared means no default reported, which is not the same as
    // a default of undefined.
    expect("default" in settings[0]!).toBe(false);
  });

  it("treats an omitted optional field as absent, not as undefined", () => {
    const { Config } = defineConfig({
      token: field.string({ label: "token", optional: true }),
      host: field.string({ label: "host", default: "localhost" }),
    });

    const parsed = Config.parse({});
    expect("token" in parsed).toBe(false);
    expect(parsed.host).toBe("localhost");
  });

  it("describes a list by the shape of one item", () => {
    const { Config, settings } = defineConfig({
      models: field.list({
        label: "model catalog",
        item: {
          id: field.string({ label: "model id" }),
          isDefault: field.boolean({ label: "preselected", optional: true }),
        },
        default: [{ id: "a" }],
      }),
    });

    expect(settings[0]?.kind).toBe("list");
    expect(settings[0]?.item?.map((f) => f.name)).toEqual(["id", "isDefault"]);
    expect(Config.parse(undefined)).toEqual({ models: [{ id: "a" }] });
    expect(Config.safeParse({ models: [{ isDefault: true }] }).success).toBe(false);
  });

  it("passes a json field through to the plugin's own schema", () => {
    const { Config, settings } = defineConfig({
      script: field.json({
        label: "script",
        schema: z.array(z.object({ kind: z.string() })),
        default: [],
      }),
    });

    expect(settings[0]?.kind).toBe("json");
    expect(Config.parse(undefined)).toEqual({ script: [] });
    expect(Config.safeParse({ script: [{ kind: "turn" }] }).success).toBe(true);
    expect(Config.safeParse({ script: [{ nope: 1 }] }).success).toBe(false);
  });
});

describe("settingsOf", () => {
  it("reads declarations off a plugin, and tolerates their absence", () => {
    const { settings } = defineConfig({ a: field.boolean({ label: "a", default: true }) });

    expect(settingsOf({ name: "x", settings })).toBe(settings);
    expect(settingsOf({ name: "x" })).toBeUndefined();
    expect(settingsOf(undefined)).toBeUndefined();
    // A plugin whose `settings` is not a list is ignored rather than trusted.
    expect(settingsOf({ settings: "nope" })).toBeUndefined();
  });
});
