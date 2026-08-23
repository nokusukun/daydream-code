import { KernelError } from "./types.js";
import type { Disposer, Plugin } from "./types.js";
import type { Context } from "./context.js";

export type FiberState =
  | "pending"
  | "loading"
  | "active"
  | "failed"
  | "unloading"
  | "disposed";

export interface EffectRecord {
  dispose: Disposer;
  label: string | undefined;
}

let nextUid = 1;

/**
 * One loaded plugin instance. Lifecycle:
 *
 *   pending -> loading -> active -> unloading -> pending | disposed
 *                      \-> failed
 *
 * A fiber with unsatisfied `inject` waits in `pending`; if a provider unloads
 * later, dependents unwind back to `pending` and reload when it returns.
 * All transitions are serialized through `inertia`.
 */
export class Fiber {
  readonly uid = nextUid++;
  readonly name: string;
  state: FiberState = "pending";
  error: unknown;
  /** Set once loading succeeds; snapshot of the validated config. */
  config: unknown;
  ctx!: Context;
  readonly effects: EffectRecord[] = [];
  readonly children = new Set<Fiber>();
  inertia: Promise<void> = Promise.resolve();

  constructor(
    readonly plugin: Plugin | null,
    readonly rawConfig: unknown,
    readonly parent: Fiber | null,
    readonly inject: readonly string[],
  ) {
    this.name = plugin
      ? ((plugin as { name?: string }).name || "anonymous")
      : "root";
  }

  /** Chain a transition onto the serialization queue. */
  queue(fn: () => void | Promise<void>): Promise<void> {
    this.inertia = this.inertia.then(fn, fn);
    return this.inertia;
  }

  addEffect(dispose: Disposer, label?: string): void {
    if (this.state !== "loading" && this.state !== "active") {
      throw new KernelError(
        "INACTIVE_EFFECT",
        `cannot register an effect on ${this.state} fiber "${this.name}"`,
      );
    }
    this.effects.push({ dispose, label });
  }

  /**
   * Run all effect disposers in reverse registration order. Async disposers
   * are awaited one at a time so teardown order is deterministic.
   */
  async unwindEffects(onError: (e: unknown) => void): Promise<void> {
    const effects = this.effects.splice(0).reverse();
    for (const effect of effects) {
      try {
        await effect.dispose();
      } catch (error) {
        onError(error);
      }
    }
  }

  assertActive(): void {
    if (this.state !== "active" && this.state !== "loading") {
      throw new KernelError(
        "INACTIVE_EFFECT",
        `fiber "${this.name}" is ${this.state}`,
      );
    }
  }
}
