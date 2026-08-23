import { KernelError } from "./types.js";
import type { ObjectPlugin, Plugin, StandardSchema } from "./types.js";
import { EventBus } from "./events.js";
import { ROOT_REALM, ServiceStore } from "./store.js";
import { Fiber } from "./fiber.js";
import { createContext, type Context } from "./context.js";

function isConstructor(fn: unknown): fn is new (...args: any[]) => unknown {
  return (
    typeof fn === "function" &&
    /^class[\s{]/.test(Function.prototype.toString.call(fn))
  );
}

function pluginMeta(plugin: Plugin): {
  inject: readonly string[];
  Config: StandardSchema | undefined;
} {
  const meta = plugin as { inject?: readonly string[]; Config?: StandardSchema };
  return { inject: meta.inject ?? [], Config: meta.Config };
}

export interface FiberDump {
  uid: number;
  name: string;
  state: string;
  inject: readonly string[];
  missing: string[];
  error?: string;
  effects: Array<string | undefined>;
}

/**
 * The application hub: service store, event bus, and fiber registry. Owns all
 * lifecycle orchestration — mounting, dependency-driven load/unload, disposal.
 */
export class App {
  readonly store = new ServiceStore();
  readonly bus = new EventBus();
  readonly fibers = new Set<Fiber>();
  readonly rootFiber: Fiber;
  readonly rootCtx: Context;
  onError: (error: unknown) => void = (error) => {
    console.error("[daydream-kernel]", error);
  };

  constructor() {
    this.rootFiber = new Fiber(null, undefined, null, []);
    this.rootFiber.state = "active";
    this.rootCtx = createContext(this, this.rootFiber, Object.create(null));
    this.rootFiber.ctx = this.rootCtx;
    this.fibers.add(this.rootFiber);
    this.store.onAdded = () => this.#recheckPending();
    this.store.onRemoved = (name, realm) => this.#onServiceRemoved(name, realm);
  }

  mount(parentCtx: Context, plugin: Plugin, config: unknown): Fiber {
    if (
      typeof plugin !== "function" &&
      (typeof plugin !== "object" ||
        plugin === null ||
        typeof (plugin as ObjectPlugin).apply !== "function")
    ) {
      throw new KernelError(
        "INVALID_PLUGIN",
        "plugin must be a function, class, or { apply } object",
      );
    }
    const { inject } = pluginMeta(plugin);
    const parentFiber = parentCtx.fiber;
    const fiber = new Fiber(plugin, config, parentFiber, inject);
    fiber.ctx = createContext(this, fiber, Object.create(parentCtx.realms));
    this.fibers.add(fiber);
    parentFiber.children.add(fiber);
    // Child lifetime rides on the parent: disposing the parent's effects
    // disposes the child. The root fiber never unwinds, so top-level mounts
    // live until disposed explicitly.
    parentFiber.addEffect(() => this.dispose(fiber), `plugin(${fiber.name})`);
    void this.#queue(fiber, () => this.#tryLoad(fiber));
    return fiber;
  }

  async dispose(fiber: Fiber): Promise<void> {
    await this.#queue(fiber, async () => {
      if (fiber.state === "disposed") return;
      if (fiber.state === "active" || fiber.state === "loading") {
        fiber.state = "unloading";
        await fiber.unwindEffects(this.onError);
      }
      fiber.state = "disposed";
      this.fibers.delete(fiber);
      fiber.parent?.children.delete(fiber);
    });
  }

  #epoch = 0;

  #queue(fiber: Fiber, fn: () => void | Promise<void>): Promise<void> {
    this.#epoch++;
    return fiber.queue(fn);
  }

  /** Await quiescence of every fiber's in-flight transitions. */
  async settle(): Promise<void> {
    // Loading a fiber can queue work on others (provides trigger rechecks),
    // so settle in rounds until a full pass schedules nothing new.
    for (let round = 0; round < 1000; round++) {
      const epoch = this.#epoch;
      await Promise.all([...this.fibers].map((f) => f.inertia));
      if (this.#epoch === epoch) return;
    }
    throw new Error("kernel failed to settle after 1000 rounds");
  }

  dumpState(): FiberDump[] {
    return [...this.fibers].map((fiber) => ({
      uid: fiber.uid,
      name: fiber.name,
      state: fiber.state,
      inject: fiber.inject,
      missing: this.#missing(fiber),
      ...(fiber.error !== undefined
        ? { error: String(fiber.error) }
        : {}),
      effects: fiber.effects.map((e) => e.label),
    }));
  }

  #missing(fiber: Fiber): string[] {
    return fiber.inject.filter(
      (name) =>
        this.store.get(name, fiber.ctx?.realmOf(name) ?? ROOT_REALM) ===
        undefined,
    );
  }

  #recheckPending(): void {
    for (const fiber of this.fibers) {
      if (fiber.state === "pending") {
        void this.#queue(fiber, () => this.#tryLoad(fiber));
      }
    }
  }

  #onServiceRemoved(name: string, realm: symbol): void {
    for (const fiber of this.fibers) {
      if (fiber.state !== "active" && fiber.state !== "loading") continue;
      if (!fiber.inject.includes(name)) continue;
      if (fiber.ctx.realmOf(name) !== realm) continue;
      void this.#queue(fiber, () => this.#demote(fiber));
    }
  }

  async #demote(fiber: Fiber): Promise<void> {
    if (fiber.state !== "active") return;
    if (this.#missing(fiber).length === 0) return; // provider came back already
    fiber.state = "unloading";
    await fiber.unwindEffects(this.onError);
    fiber.state = "pending";
    // Reload immediately if a joined realm still satisfies everything.
    void this.#queue(fiber, () => this.#tryLoad(fiber));
  }

  async #tryLoad(fiber: Fiber): Promise<void> {
    if (fiber.state !== "pending") return;
    if (this.#missing(fiber).length > 0) return;
    const plugin = fiber.plugin!;
    fiber.state = "loading";
    let config = fiber.rawConfig;
    const { Config } = pluginMeta(plugin);
    if (Config) {
      try {
        const result = await Config["~standard"].validate(fiber.rawConfig);
        if (result.issues) {
          const detail = result.issues
            .map((i) => `- ${i.path?.join(".") ?? "$"}: ${i.message}`)
            .join("\n");
          throw new KernelError(
            "INVALID_CONFIG",
            `invalid config for "${fiber.name}":\n${detail}`,
          );
        }
        config = result.value;
      } catch (error) {
        fiber.state = "failed";
        fiber.error = error;
        this.onError(error);
        return;
      }
    }
    fiber.config = config;
    try {
      let result: unknown;
      if (typeof plugin === "function") {
        result = isConstructor(plugin)
          ? new plugin(fiber.ctx, config)
          : plugin(fiber.ctx, config);
      } else {
        result = plugin.apply(fiber.ctx, config);
      }
      if (result instanceof Promise) await result;
      // A dependency may have vanished while an async apply was in flight.
      if (this.#missing(fiber).length > 0) {
        fiber.state = "unloading";
        await fiber.unwindEffects(this.onError);
        fiber.state = "pending";
        return;
      }
      fiber.state = "active";
    } catch (error) {
      fiber.state = "unloading";
      await fiber.unwindEffects(this.onError);
      fiber.state = "failed";
      fiber.error = error;
      this.onError(error);
    }
  }
}

/** Create a fresh application and return its root context. */
export function createApp(): Context {
  return new App().rootCtx;
}
