import type { Context } from "./context.js";

/**
 * Base class for service definitions. Subclass, call super(ctx, "key"), and
 * load the subclass (or a further subclass) as a plugin — construction
 * registers it as ctx.<key>, and it is removed when the fiber unloads.
 *
 * Exclusive seams subclass an abstract Service (one provider per realm;
 * a second throws DUPLICATE_SERVICE). Registry seams are concrete Services
 * that providers register into.
 */
export class Service {
  protected readonly ctx: Context;

  constructor(ctx: Context, name: string) {
    this.ctx = ctx;
    ctx.provide(name, this);
  }
}
