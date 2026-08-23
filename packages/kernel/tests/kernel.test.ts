import { describe, expect, it } from "vitest";
import {
  App,
  KernelError,
  Service,
  type Context,
} from "../src/index.js";

function makeApp() {
  const app = new App();
  const errors: unknown[] = [];
  app.onError = (e) => errors.push(e);
  return { app, ctx: app.rootCtx, errors };
}

describe("plugin lifecycle", () => {
  it("loads a function plugin and disposes its effects in reverse order", async () => {
    const { app, ctx } = makeApp();
    const order: string[] = [];
    const fiber = ctx.plugin((ctx: Context) => {
      ctx.effect(() => {
        order.push("a+");
        return () => order.push("a-");
      });
      ctx.effect(() => {
        order.push("b+");
        return () => order.push("b-");
      });
    });
    await app.settle();
    expect(fiber.state).toBe("active");
    await app.dispose(fiber);
    expect(order).toEqual(["a+", "b+", "b-", "a-"]);
    expect(fiber.state).toBe("disposed");
  });

  it("stays PENDING until injected services appear, then loads", async () => {
    const { app, ctx } = makeApp();
    let loaded = false;
    const dependent = ctx.plugin({
      name: "dependent",
      inject: ["greeter"],
      apply() {
        loaded = true;
      },
    });
    await app.settle();
    expect(dependent.state).toBe("pending");
    expect(loaded).toBe(false);

    ctx.plugin((ctx: Context) => {
      ctx.provide("greeter", { hello: () => "hi" });
    });
    await app.settle();
    expect(dependent.state).toBe("active");
    expect(loaded).toBe(true);
  });

  it("demotes dependents when a provider unloads and reloads when it returns", async () => {
    const { app, ctx } = makeApp();
    let loads = 0;
    const dependent = ctx.plugin({
      name: "dependent",
      inject: ["svc"],
      apply() {
        loads++;
      },
    });
    const provider = ctx.plugin((ctx: Context) => {
      ctx.provide("svc", 1);
    });
    await app.settle();
    expect(dependent.state).toBe("active");
    expect(loads).toBe(1);

    await app.dispose(provider);
    await app.settle();
    expect(dependent.state).toBe("pending");

    ctx.plugin((ctx: Context) => {
      ctx.provide("svc", 2);
    });
    await app.settle();
    expect(dependent.state).toBe("active");
    expect(loads).toBe(2);
  });

  it("disposes children mounted inside apply when the parent unloads", async () => {
    const { app, ctx } = makeApp();
    const disposed: string[] = [];
    const parent = ctx.plugin((ctx: Context) => {
      ctx.plugin((ctx: Context) => {
        ctx.effect(() => () => disposed.push("child"));
      });
      ctx.effect(() => () => disposed.push("parent"));
    });
    await app.settle();
    await app.dispose(parent);
    expect(disposed).toEqual(["parent", "child"]);
  });

  it("fails loudly on invalid config (standard schema)", async () => {
    const { app, ctx, errors } = makeApp();
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate(value: unknown) {
          if (typeof value === "object" && value !== null && "n" in value)
            return { value };
          return { issues: [{ message: "expected { n }" }] };
        },
      },
    };
    const fiber = ctx.plugin(
      {
        name: "cfg",
        Config: schema,
        apply(_ctx: Context, _config: unknown) {
          throw new Error("should not run");
        },
      },
      { wrong: true },
    );
    await app.settle();
    expect(fiber.state).toBe("failed");
    expect(errors.length).toBe(1);
    expect((errors[0] as KernelError).code).toBe("INVALID_CONFIG");
  });

  it("marks a throwing plugin FAILED and unwinds partial effects", async () => {
    const { app, ctx } = makeApp();
    const disposed: string[] = [];
    const fiber = ctx.plugin((ctx: Context) => {
      ctx.effect(() => () => disposed.push("partial"));
      throw new Error("boom");
    });
    await app.settle();
    expect(fiber.state).toBe("failed");
    expect(disposed).toEqual(["partial"]);
  });
});

describe("services", () => {
  it("throws on duplicate provide in the same realm", async () => {
    const { app, ctx, errors } = makeApp();
    ctx.plugin((ctx: Context) => void ctx.provide("dup", 1));
    const second = ctx.plugin((ctx: Context) => void ctx.provide("dup", 2));
    await app.settle();
    expect(second.state).toBe("failed");
    expect((errors[0] as KernelError).code).toBe("DUPLICATE_SERVICE");
  });

  it("isolate gives a subtree its own realm; label joins realms", async () => {
    const { app, ctx } = makeApp();
    ctx.plugin((ctx: Context) => void ctx.provide("shell", "root-shell"));
    await app.settle();

    const isoA = ctx.isolate("shell");
    isoA.plugin((ctx: Context) => void ctx.provide("shell", "a-shell"));
    await app.settle();

    expect(ctx.get("shell")).toBe("root-shell");
    expect(isoA.get("shell")).toBe("a-shell");

    const label = Symbol("joined");
    const isoB = ctx.isolate("shell", label);
    const isoC = ctx.isolate("shell", label);
    isoB.plugin((ctx: Context) => void ctx.provide("shell", "b-shell"));
    await app.settle();
    expect(isoC.get("shell")).toBe("b-shell");
  });

  it("exposes services as ctx properties and blocks direct assignment", async () => {
    const { app, ctx } = makeApp();
    ctx.plugin((ctx: Context) => void ctx.provide("thing", { x: 42 }));
    await app.settle();
    expect((ctx as any).thing.x).toBe(42);
    expect(() => {
      (ctx as any).thing = {};
    }).toThrow(KernelError);
  });

  it("Service subclass registers itself as a plugin", async () => {
    const { app, ctx } = makeApp();
    class Greeter extends Service {
      constructor(ctx: Context) {
        super(ctx, "greeter");
      }
      greet(name: string) {
        return `hello ${name}`;
      }
    }
    const fiber = ctx.plugin(Greeter);
    await app.settle();
    expect(fiber.state).toBe("active");
    expect((ctx as any).greeter.greet("dd")).toBe("hello dd");
    await app.dispose(fiber);
    expect(ctx.get("greeter")).toBeUndefined();
  });
});

describe("events", () => {
  it("waterfall composes as around-middleware and can short-circuit", async () => {
    const { app, ctx } = makeApp();
    ctx.plugin((ctx: Context) => {
      ctx.on("calc", (n: number, next: (n?: number) => number) => next(n + 1));
      ctx.on("calc", (n: number, _next: unknown) =>
        n > 10 ? -1 : undefined,
      );
      ctx.on("calc", (n: number, next: (n?: number) => number) =>
        typeof n === "number" ? next(n * 2) : next(),
      );
    });
    await app.settle();
    // 3 -> +1 = 4 -> not >10, undefined means short-circuit with undefined!
    const result = ctx.waterfall("calc", [3], (n: number) => n);
    expect(result).toBeUndefined();
    const big = ctx.waterfall("calc", [100], (n: number) => n);
    expect(big).toBe(-1);
  });

  it("serial awaits in order and bails on first non-undefined", async () => {
    const { app, ctx } = makeApp();
    const calls: string[] = [];
    ctx.plugin((ctx: Context) => {
      ctx.on("pick", async () => {
        calls.push("first");
        return undefined;
      });
      ctx.on("pick", async () => {
        calls.push("second");
        return "chosen";
      });
      ctx.on("pick", async () => {
        calls.push("third");
        return "never";
      });
    });
    await app.settle();
    const result = await ctx.serial("pick");
    expect(result).toBe("chosen");
    expect(calls).toEqual(["first", "second"]);
  });

  it("scoped dispatch respects the FILTER predicate", async () => {
    const { app, ctx } = makeApp();
    const { FILTER } = await import("../src/index.js");
    const seen: string[] = [];
    const target = { id: "session-1" };

    ctx.plugin((ctx: Context) => {
      (ctx as any)[FILTER] = (t: any) => t?.id === "session-1";
      ctx.on("tick", () => seen.push("scoped"));
    });
    ctx.plugin((ctx: Context) => {
      (ctx as any)[FILTER] = (t: any) => t?.id === "session-2";
      ctx.on("tick", () => seen.push("other"));
    });
    ctx.plugin((ctx: Context) => {
      ctx.on("tick", () => seen.push("unfiltered"));
    });
    await app.settle();

    ctx.scoped(target).emit("tick");
    expect(seen.sort()).toEqual(["scoped", "unfiltered"]);
  });

  it("listener disposal removes it from the bus", async () => {
    const { app, ctx } = makeApp();
    let hits = 0;
    const plugin = ctx.plugin((ctx: Context) => {
      ctx.on("ping", () => hits++);
    });
    await app.settle();
    ctx.emit("ping");
    await app.dispose(plugin);
    ctx.emit("ping");
    expect(hits).toBe(1);
  });
});

describe("diagnostics", () => {
  it("dumpState reports missing injections for pending fibers", async () => {
    const { app, ctx } = makeApp();
    ctx.plugin({
      name: "needs-stuff",
      inject: ["nothere"],
      apply() {},
    });
    await app.settle();
    const dump = app.dumpState().find((f) => f.name === "needs-stuff");
    expect(dump?.state).toBe("pending");
    expect(dump?.missing).toEqual(["nothere"]);
  });
});
