import { KernelError } from "./types.js";
import type { Disposer, EffectResult, Plugin } from "./types.js";
import { FILTER, type EventBus, type ListenerOptions } from "./events.js";
import { ROOT_REALM } from "./store.js";
import type { Fiber } from "./fiber.js";
import type { App } from "./app.js";

/** Dispatcher bound to a target object, admitted through Context.filter. */
export interface ScopedDispatch {
  emit(name: string, ...args: unknown[]): void;
  parallel(name: string, ...args: unknown[]): Promise<void>;
  serial(name: string, ...args: unknown[]): Promise<unknown>;
  bail(name: string, ...args: unknown[]): unknown;
  waterfall(
    name: string,
    args: unknown[],
    terminal: (...args: any[]) => any,
  ): unknown;
}

/**
 * The public Context surface. Plugins extend it with their services via
 * declaration merging:
 *
 *   declare module "@daydream-code/kernel" {
 *     interface Context { journal: Journal }
 *   }
 */
export interface Context extends ContextCore {}

export class ContextCore {
  declare readonly app: App;
  declare readonly fiber: Fiber;
  /** Service name -> isolation realm; prototypally inherited. */
  declare readonly realms: Record<string, symbol>;

  /** Filter predicate consulted for scoped dispatch; see FILTER. */
  declare [FILTER]: ((target: unknown) => boolean) | undefined;

  get root(): Context {
    return this.app.rootCtx;
  }

  get registry(): App {
    return this.app;
  }

  get events(): EventBus {
    return this.app.bus;
  }

  realmOf(name: string): symbol {
    return this.realms[name] ?? ROOT_REALM;
  }

  /** Child context: same fiber, fresh realm layer (isolates below don't leak up). */
  extend(): Context {
    return createContext(this.app, this.fiber, Object.create(this.realms));
  }

  /**
   * Child context in which `name` resolves in a fresh isolation realm.
   * Pass the same `label` symbol to two isolates to join their realms.
   */
  isolate(name: string, label?: symbol): Context {
    const realms: Record<string, symbol> = Object.create(this.realms);
    realms[name] = label ?? Symbol(`isolate(${name})`);
    return createContext(this.app, this.fiber, realms);
  }

  /** Optional service lookup. Use `inject` for hard dependencies instead. */
  get<T = unknown>(name: string): T | undefined {
    return this.app.store.get(name, this.realmOf(name))?.value as T | undefined;
  }

  /**
   * Register a service implementation owned by the current fiber. Throws on
   * duplicate within the isolation realm. Removed when the fiber unloads.
   */
  provide(name: string, value: unknown): Disposer {
    const remove = this.app.store.provide(
      name,
      this.realmOf(name),
      value,
      this.fiber,
    );
    return this.effect(() => remove, `provide(${name})`);
  }

  /**
   * Run a registration and tie its cleanup to this context's fiber. Returns a
   * disposer; calling it early is fine (double-dispose is a no-op).
   */
  effect(execute: () => EffectResult, label?: string): Disposer {
    this.fiber.assertActive();
    const result = execute();
    const disposers: Disposer[] =
      result === undefined ? [] : Array.isArray(result) ? result : [result];
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      for (const fn of disposers.reverse()) await fn();
    };
    this.fiber.addEffect(dispose, label);
    return dispose;
  }

  on(
    name: string,
    listener: (...args: any[]) => any,
    options?: ListenerOptions,
  ): Disposer {
    return this.effect(
      () => this.app.bus.on(this as unknown as Context, name, listener, options),
      `on(${name})`,
    );
  }

  once(
    name: string,
    listener: (...args: any[]) => any,
    options?: ListenerOptions,
  ): Disposer {
    const dispose = this.on(
      name,
      (...args: unknown[]) => {
        void dispose();
        return listener(...args);
      },
      options,
    );
    return dispose;
  }

  /** Mount a plugin as a child of this context's fiber. */
  plugin<T>(plugin: Plugin<T>, config?: T): Fiber {
    return this.app.mount(this as unknown as Context, plugin, config);
  }

  /** Shorthand: run `callback` once (and while) all `deps` are available. */
  inject(
    deps: readonly string[],
    callback: (ctx: Context) => unknown | Promise<unknown>,
  ): Fiber {
    const apply = (ctx: Context) => callback(ctx);
    return this.plugin({
      name: callback.name || "inject",
      inject: deps,
      apply,
    });
  }

  // Unscoped dispatch (all listeners, no target filter).

  emit(name: string, ...args: unknown[]): void {
    this.app.bus.emit(undefined, name, args, this.app.onError);
  }

  parallel(name: string, ...args: unknown[]): Promise<void> {
    return this.app.bus.parallel(undefined, name, args);
  }

  serial(name: string, ...args: unknown[]): Promise<unknown> {
    return this.app.bus.serial(undefined, name, args);
  }

  bail(name: string, ...args: unknown[]): unknown {
    return this.app.bus.bail(undefined, name, args);
  }

  waterfall(
    name: string,
    args: unknown[],
    terminal: (...args: any[]) => any,
  ): unknown {
    return this.app.bus.waterfall(undefined, name, args, terminal);
  }

  /** Dispatch admitted through each listener context's FILTER predicate. */
  scoped(target: unknown): ScopedDispatch {
    const bus = this.app.bus;
    const onError = this.app.onError;
    return {
      emit: (name, ...args) => bus.emit(target, name, args, onError),
      parallel: (name, ...args) => bus.parallel(target, name, args),
      serial: (name, ...args) => bus.serial(target, name, args),
      bail: (name, ...args) => bus.bail(target, name, args),
      waterfall: (name, args, terminal) =>
        bus.waterfall(target, name, args, terminal),
    };
  }
}

const RESERVED = new Set<PropertyKey>(["then", "toJSON", "constructor"]);

export function createContext(
  app: App,
  fiber: Fiber,
  realms: Record<string, symbol>,
): Context {
  const core = new ContextCore();
  Object.defineProperties(core, {
    app: { value: app, enumerable: false },
    fiber: { value: fiber, enumerable: false, writable: true },
    realms: { value: realms, enumerable: false },
  });
  return new Proxy(core, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target) && !RESERVED.has(prop)) {
        const entry = app.store.get(prop, target.realmOf(prop));
        if (entry) return entry.value;
        return undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === "string" && !(prop in target)) {
        return app.store.get(prop, target.realmOf(prop)) !== undefined;
      }
      return Reflect.has(target, prop);
    },
    set(target, prop, value, receiver) {
      if (
        typeof prop === "string" &&
        !(prop in target) &&
        app.store.get(prop, target.realmOf(prop)) !== undefined
      ) {
        throw new KernelError(
          "NOT_PROVIDER",
          `service "${prop}" must be replaced through its provider, not assigned`,
        );
      }
      return Reflect.set(target, prop, value, receiver);
    },
  }) as unknown as Context;
}
