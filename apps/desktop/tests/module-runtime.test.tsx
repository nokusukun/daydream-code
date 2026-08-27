import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  DesktopModuleRuntime,
  type DesktopModule,
  type DesktopModuleLoader,
} from "../src/modules/runtime.js";

function View(): ReactNode {
  return null;
}

function loader(module: DesktopModule): DesktopModuleLoader {
  return { id: module.id, load: async () => ({ default: module }) };
}

async function loaded(runtime: DesktopModuleRuntime): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  // Import resolution, activation, and publication are one microtask chain.
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(
    runtime.getSnapshot().statuses.some((entry) => entry.state === "loading"),
  ).toBe(false);
}

describe("DesktopModuleRuntime", () => {
  it("keeps loading siblings when a module import fails", async () => {
    const runtime = new DesktopModuleRuntime();
    runtime.load([
      {
        id: "broken",
        load: async () => {
          throw new Error("top-level module failure");
        },
      },
      loader({
        id: "healthy",
        activate(context) {
          context.registerMode({
            id: "healthy",
            label: "Healthy",
            splitId: "healthy",
            panel: View,
          });
        },
      }),
    ]);
    await loaded(runtime);

    expect(runtime.getSnapshot().modes.map((mode) => mode.id)).toEqual(["healthy"]);
    expect(runtime.getSnapshot().statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "broken",
          state: "failed",
          error: "top-level module failure",
        }),
        expect.objectContaining({ id: "healthy", state: "active" }),
      ]),
    );
  });

  it("reports duplicate loaders without preventing unrelated modules", async () => {
    const runtime = new DesktopModuleRuntime();
    const duplicate = loader({ id: "duplicate", activate() {} });
    expect(() =>
      runtime.load([
        duplicate,
        duplicate,
        loader({ id: "healthy", activate() {} }),
      ]),
    ).not.toThrow();
    await loaded(runtime);

    expect(runtime.getSnapshot().statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "duplicate", state: "failed" }),
        expect.objectContaining({ id: "healthy", state: "active" }),
      ]),
    );
  });

  it("rolls back partial registrations when activation fails", async () => {
    const runtime = new DesktopModuleRuntime();
    const cleanup: string[] = [];
    runtime.load([
      loader({
        id: "broken",
        activate(context) {
          context.effect(() => () => cleanup.push("effect"));
          context.registerMode({
            id: "temporary",
            label: "Temporary",
            splitId: "temporary",
            panel: View,
          });
          throw new Error("activation failed");
        },
      }),
    ]);
    await loaded(runtime);

    expect(runtime.getSnapshot().modes).toEqual([]);
    expect(cleanup).toEqual(["effect"]);
    expect(runtime.getSnapshot().statuses[0]).toEqual(
      expect.objectContaining({
        id: "broken",
        state: "failed",
        error: "activation failed",
      }),
    );
  });

  it("activates dependents only after their required module is active", async () => {
    const runtime = new DesktopModuleRuntime();
    runtime.load([
      loader({
        id: "consumer",
        requires: ["provider"],
        activate(context) {
          context.registerOverlay({ id: "consumer", Component: View });
        },
      }),
      loader({ id: "provider", activate() {} }),
    ]);
    await loaded(runtime);

    expect(runtime.getSnapshot().statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "provider", state: "active" }),
        expect.objectContaining({
          id: "consumer",
          state: "active",
          missing: [],
        }),
      ]),
    );
    expect(runtime.getSnapshot().overlays.map((overlay) => overlay.id)).toEqual(["consumer"]);
  });

  it("does not let a duplicate contribution replace its owner", async () => {
    const runtime = new DesktopModuleRuntime();
    runtime.load([
      loader({
        id: "first",
        activate(context) {
          context.registerMode({
            id: "shared",
            label: "First",
            splitId: "first",
            panel: View,
          });
        },
      }),
      loader({
        id: "second",
        activate(context) {
          context.registerMode({
            id: "shared",
            label: "Second",
            splitId: "second",
            panel: View,
          });
        },
      }),
    ]);
    await loaded(runtime);

    expect(runtime.getSnapshot().modes).toEqual([
      expect.objectContaining({ id: "shared", label: "First" }),
    ]);
    expect(
      runtime.getSnapshot().statuses.find((entry) => entry.id === "second"),
    ).toEqual(expect.objectContaining({ state: "failed" }));
  });
});
