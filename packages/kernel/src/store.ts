import { KernelError } from "./types.js";
import type { Fiber } from "./fiber.js";

/** Root isolation realm shared by every context that never called isolate(). */
export const ROOT_REALM: unique symbol = Symbol("root-realm");

export interface ServiceEntry {
  value: unknown;
  owner: Fiber;
}

/**
 * The global service store. Services are keyed by (name, realm): `isolate`
 * gives a subtree a fresh realm symbol for one name, so two providers of the
 * same service can coexist without seeing each other.
 */
export class ServiceStore {
  #entries = new Map<string, Map<symbol, ServiceEntry>>();
  onAdded: (name: string, realm: symbol) => void = () => {};
  onRemoved: (name: string, realm: symbol) => void = () => {};

  get(name: string, realm: symbol): ServiceEntry | undefined {
    return this.#entries.get(name)?.get(realm);
  }

  provide(name: string, realm: symbol, value: unknown, owner: Fiber): () => void {
    let realms = this.#entries.get(name);
    if (!realms) this.#entries.set(name, (realms = new Map()));
    if (realms.has(realm)) {
      throw new KernelError(
        "DUPLICATE_SERVICE",
        `service "${name}" is already provided in this isolation scope`,
      );
    }
    realms.set(realm, { value, owner });
    this.onAdded(name, realm);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const current = this.#entries.get(name);
      if (current && current.get(realm)?.value === value) {
        current.delete(realm);
        this.onRemoved(name, realm);
      }
    };
  }

  names(): string[] {
    return [...this.#entries.keys()].filter(
      (name) => (this.#entries.get(name)?.size ?? 0) > 0,
    );
  }
}
