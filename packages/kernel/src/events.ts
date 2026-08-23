import type { Context } from "./context.js";

/**
 * Event vocabulary. Plugins add durable names by declaration merging:
 *
 *   declare module "@daydream-code/kernel" {
 *     interface Events { "journal/append"(event: JournalEvent): void }
 *   }
 *
 * Dispatch mode is part of each event's public contract (document it at the
 * declaration): emit / parallel / serial / bail / waterfall.
 */
export interface Events {
  [key: string]: (...args: any[]) => any;
}

export interface ListenerOptions {
  /** Run before already-registered listeners. */
  prepend?: boolean;
  /** Ignore the dispatch target filter (Context.filter). */
  global?: boolean;
}

interface Registration {
  fn: (...args: any[]) => any;
  ctx: Context;
  global: boolean;
}

/** Symbol a context may set to a predicate admitting dispatch targets. */
export const FILTER: unique symbol = Symbol.for("daydream.filter");

export class EventBus {
  #listeners = new Map<string, Registration[]>();

  on(
    ctx: Context,
    name: string,
    fn: (...args: any[]) => any,
    options: ListenerOptions = {},
  ): () => boolean {
    let list = this.#listeners.get(name);
    if (!list) this.#listeners.set(name, (list = []));
    const reg: Registration = { fn, ctx, global: options.global ?? false };
    if (options.prepend) list.unshift(reg);
    else list.push(reg);
    return () => {
      const current = this.#listeners.get(name);
      if (!current) return false;
      const index = current.indexOf(reg);
      if (index < 0) return false;
      current.splice(index, 1);
      return true;
    };
  }

  #admitted(name: string, target: unknown): Registration[] {
    const list = this.#listeners.get(name) ?? [];
    if (target === undefined) return [...list];
    return list.filter((reg) => {
      if (reg.global) return true;
      const filter = (reg.ctx as any)[FILTER] as
        | ((target: unknown) => boolean)
        | undefined;
      return filter === undefined || filter(target) !== false;
    });
  }

  /** Fire-and-forget, sync, registration order. Listener errors go to onError. */
  emit(target: unknown, name: string, args: unknown[], onError: (e: unknown) => void): void {
    for (const reg of this.#admitted(name, target)) {
      try {
        Reflect.apply(reg.fn, target, args);
      } catch (error) {
        onError(error);
      }
    }
  }

  /** All listeners concurrently, awaited. */
  async parallel(target: unknown, name: string, args: unknown[]): Promise<void> {
    await Promise.all(
      this.#admitted(name, target).map((reg) =>
        Promise.resolve().then(() => Reflect.apply(reg.fn, target, args)),
      ),
    );
  }

  /** Awaited in registration order until a listener returns non-undefined. */
  async serial(target: unknown, name: string, args: unknown[]): Promise<unknown> {
    for (const reg of this.#admitted(name, target)) {
      const result = await Reflect.apply(reg.fn, target, args);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  /** Sync, registration order, until a listener returns non-undefined. */
  bail(target: unknown, name: string, args: unknown[]): unknown {
    for (const reg of this.#admitted(name, target)) {
      const result = Reflect.apply(reg.fn, target, args);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  /**
   * Around-middleware. Each listener receives (...args, next); calling next()
   * delegates to the next listener and finally to `terminal`. Returning
   * without calling next() short-circuits.
   */
  waterfall(
    target: unknown,
    name: string,
    args: unknown[],
    terminal: (...args: any[]) => any,
  ): unknown {
    const chain = this.#admitted(name, target);
    const invoke = (index: number, current: unknown[]): unknown => {
      if (index >= chain.length) return Reflect.apply(terminal, target, current);
      const next = (...override: unknown[]) =>
        invoke(index + 1, override.length > 0 ? override : current);
      return Reflect.apply(chain[index]!.fn, target, [...current, next]);
    };
    return invoke(0, args);
  }

  count(name: string): number {
    return this.#listeners.get(name)?.length ?? 0;
  }
}
