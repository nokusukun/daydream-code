import type { SettingDescriptor } from "@daydream-code/config";
import { Service, type Context } from "@daydream-code/kernel";
import type { ProjectRecord } from "@daydream-code/shared";

// The descriptors come straight from the plugins' own declarations; this
// package adds no vocabulary of its own on top of them.
export type { SettingDescriptor, FieldKind, EnumOption } from "@daydream-code/config";

declare module "@daydream-code/kernel" {
  interface Context {
    settings: HarnessConfig;
  }
  interface Events {
    /** @mode emit — fired after a config layer file has been written. */
    "settings/written"(change: WriteResult): void;
  }
}

/** The two layer files a user can write. Base and CLI overrides are read-only. */
export type WritableLayer = "user" | "project";

/** Which layer last set each part of a row. */
export interface RowOrigin {
  name?: string;
  config?: string;
  disabled?: string;
  isolate?: string;
}

export interface FiberView {
  state: string;
  missing: string[];
  error?: string;
}

/**
 * Everything the settings UI needs about one composition row: what it is, what
 * it is set to, who set it, whether it is actually running, and whether it can
 * be changed without a relaunch.
 */
export interface EntryView {
  id: string;
  /** Module specifier, absent for a row that only patches another. */
  name?: string;
  disabled: boolean;
  isolate: string[];
  /** Effective config after layering. */
  config: unknown;
  /** Layer sources that touched this row, in application order. */
  layers: string[];
  origin: RowOrigin;
  /** The fields the plugin declares; empty when it declares none. */
  fields: SettingDescriptor[];
  /** The plugin declares settings a UI can render. */
  configurable: boolean;
  /**
   * What is actually mounted, when that differs from what is saved. Present
   * only after a restart-required row is changed: the control shows `config`,
   * this says what is still running.
   */
  live?: { config: unknown; disabled: boolean };
  fiber?: FiberView;
  /** Set when the row cannot be hot-reloaded; the value is the reason. */
  restartRequired?: string;
}

export interface SettingsView {
  project: ProjectRecord;
  /** Absolute paths of the writable layer files, whether or not they exist. */
  layerFiles: Record<WritableLayer, string>;
  entries: EntryView[];
  warnings: Array<{ source: string; message: string }>;
  /** Ids of sessions running right now; some rows cannot reload while any are. */
  running: string[];
}

export interface WriteRequest {
  layer: WritableLayer;
  id: string;
  /** Fields to set on the row in this layer. */
  set?: {
    name?: string;
    config?: unknown;
    disabled?: boolean;
    isolate?: string[];
  };
  /** Fields to delete from this layer, so the value below shows through again. */
  unset?: Array<"name" | "config" | "disabled" | "isolate">;
  /** Reload affected rows in place. Default true. */
  apply?: boolean;
}

export type ApplyStatus =
  | "reloaded"
  | "mounted"
  | "unmounted"
  | "unchanged"
  | "restart-required"
  | "failed";

export interface ApplyOutcome {
  id: string;
  status: ApplyStatus;
  /** Why, for `restart-required` and `failed`. */
  reason?: string;
}

export interface WriteResult {
  view: SettingsView;
  outcomes: ApplyOutcome[];
}

/**
 * Exclusive seam: the harness's own configuration, readable as data and
 * writable a row at a time.
 *
 * It exists because "what can be configured" is otherwise spread across a YAML
 * loader, a dozen private zod schemas, and the kernel's fiber registry, and no
 * consumer can answer the question without reaching into all three. A UI that
 * had to do that would be coupled to every one of them.
 */
export abstract class HarnessConfig extends Service {
  constructor(ctx: Context) {
    super(ctx, "settings");
  }

  /** The whole configurable surface, composed and annotated. */
  abstract view(): Promise<SettingsView>;

  /** Write one row into one layer, and (by default) apply it in place. */
  abstract write(request: WriteRequest): Promise<WriteResult>;

  /**
   * Re-read the layers and reconcile what is mounted against them, without
   * writing anything. Used after an external edit to a config file.
   */
  abstract apply(): Promise<WriteResult>;
}
