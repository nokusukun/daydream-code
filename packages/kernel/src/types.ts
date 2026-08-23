import type { Context } from "./context.js";

/**
 * Minimal Standard Schema surface (https://standardschema.dev). zod 3.24+,
 * valibot, and arktype all implement it, so plugin Config can be any of them
 * without the kernel depending on a validator.
 */
export interface StandardSchema<Out = unknown> {
  "~standard": {
    version: 1;
    vendor: string;
    validate(value: unknown):
      | StandardResult<Out>
      | Promise<StandardResult<Out>>;
  };
}

export type StandardResult<Out> =
  | { value: Out; issues?: undefined }
  | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<unknown> }> };

export type Disposer = () => unknown | Promise<unknown>;

/** What an effect body may hand back for cleanup. */
export type EffectResult = void | Disposer | Disposer[];

export interface PluginMeta<T = any> {
  /** Display name for fiber diagnostics and logs. */
  name?: string;
  /** Standard-schema validator applied to config before the plugin starts. */
  Config?: StandardSchema<T>;
  /** Services the plugin requires; it only loads while all are available. */
  inject?: readonly string[];
  /** Service name(s) the plugin provides (informational; `provide` is the act). */
  provide?: string | readonly string[];
}

export interface FunctionPlugin<T = any> extends PluginMeta<T> {
  (ctx: Context, config: T): unknown | Promise<unknown>;
}

export interface ConstructorPlugin<T = any> extends PluginMeta<T> {
  new (ctx: Context, config: T): unknown;
}

export interface ObjectPlugin<T = any> extends PluginMeta<T> {
  apply(ctx: Context, config: T): unknown | Promise<unknown>;
}

export type Plugin<T = any> =
  | FunctionPlugin<T>
  | ConstructorPlugin<T>
  | ObjectPlugin<T>;

export class KernelError extends Error {
  constructor(
    readonly code:
      | "DUPLICATE_SERVICE"
      | "INVALID_CONFIG"
      | "INVALID_PLUGIN"
      | "INACTIVE_EFFECT"
      | "NOT_PROVIDER",
    message: string,
  ) {
    super(message);
    this.name = "KernelError";
  }
}
