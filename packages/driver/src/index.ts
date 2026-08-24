import { z } from "zod";
import { Service, type Context, type Disposer } from "@daydream-code/kernel";
import type {
  ImagePart,
  JournalEventInput,
  ModelMessage,
  SessionId,
  SessionResult,
} from "@daydream-code/shared";
import type { HarnessToolDefinition } from "@daydream-code/tools";

declare module "@daydream-code/kernel" {
  interface Context {
    drivers: SessionDrivers;
  }
}

/**
 * One selectable model in a driver's catalog. Adapters ship a baked-in default
 * list; a config row can replace it wholesale (`{ id: "driver-claude",
 * config: { models: [...] } }`) — same swap-by-config rule as everything else.
 */
export const DriverModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /** Preselected in pickers; omitting `modelId` on dispatch means "driver default". */
  isDefault: z.boolean().optional(),
});

export type DriverModel = z.infer<typeof DriverModelSchema>;

/** One driver's slice of the catalog, as served by `GET /api/models`. */
export interface DriverCatalogEntry {
  driver: string;
  models: DriverModel[];
}

/**
 * An image part resolved to bytes. Supplied by the runner, which owns the
 * blob store — drivers stay ignorant of the blobs seam, and each one takes
 * whichever form its SDK accepts: Claude wants base64, Codex wants a path.
 */
export interface ResolvedImage {
  /** Absolute path on disk, inside the project so Codex sandboxes can read it. */
  path: string;
  mediaType: string;
  /** File contents as base64, read on demand. */
  base64(): string;
}

/** A message injected into a running session between or during turns. */
export interface Injection {
  kind: "user" | "master_update" | "ask" | "message";
  text: string;
  /** Images attached to this message, resolved through `ctx.blobs`. */
  images?: ImagePart[];
}

/**
 * The journal payload for an injection a driver has just fed into a turn.
 *
 * Shared by every driver because the transcript reads these events to render
 * what you sent, and an image dropped here is invisible by construction: the
 * bytes are in the blob store and the text says nothing about them. Carrying
 * the parts (which are references, not data) is what lets a UI show the
 * screenshot you pasted mid-run beside the sentence it went with.
 */
export function injectedPayload(injection: Injection): Record<string, unknown> {
  return {
    kind: injection.kind,
    text: injection.text,
    ...(injection.images !== undefined && injection.images.length > 0
      ? { images: injection.images }
      : {}),
  };
}

export type PermissionMode = "auto" | "ask" | "readonly";

export interface DriverRunInput {
  sessionId: SessionId;
  workdir: string;
  /** Forked master-thread context, normalized, oldest first. */
  context: ModelMessage[];
  task: string;
  /**
   * Images attached to the opening task. Kept beside `task` rather than
   * folded into it because the prompt preamble is text and every SDK wants
   * images as separate content blocks.
   */
  taskImages?: ImagePart[];
  modelId: string | null;
  tools: HarnessToolDefinition[];
  /**
   * Journal sink. Persisted before the driver continues (DB-first). `usage`
   * on turn events is how the runner accumulates cost.
   */
  onEvent(event: Omit<JournalEventInput, "sessionId">): void;
  /**
   * Called at each turn boundary; returns queued injections (user messages,
   * master-thread updates) to feed into the next turn, or an empty array.
   */
  drainInjections(): Injection[];
  /** Resolve an attached image to bytes. Throws if the blob is missing. */
  resolveImage(part: ImagePart): ResolvedImage;
  /** Resolves when the driver should wrap up (used by continue-session waits). */
  signal: AbortSignal;
  permissionMode: PermissionMode;
  /** Provider-native resume handle from a previous run of this session. */
  resumeToken?: string | null;
}

export interface DriverSessionResult extends SessionResult {
  /** Provider-native handle to resume this session later. */
  resumeToken?: string;
}

export interface SessionDriver {
  readonly id: string;
  /** Models this driver can dispatch with; empty/absent means "default only". */
  readonly models?: readonly DriverModel[];
  /**
   * Run one session turn-loop until the agent finishes the task (or the
   * signal aborts). Must journal every model-visible thing through onEvent.
   */
  run(input: DriverRunInput): Promise<DriverSessionResult>;
}

/** Registry seam: driver adapters (claude, codex, mock, ...) register in. */
export class SessionDrivers extends Service {
  #drivers = new Map<string, SessionDriver>();

  constructor(ctx: Context) {
    super(ctx, "drivers");
  }

  register(owner: Context, driver: SessionDriver): Disposer {
    if (this.#drivers.has(driver.id)) {
      throw new Error(`driver "${driver.id}" is already registered`);
    }
    return owner.effect(() => {
      this.#drivers.set(driver.id, driver);
      return () => this.#drivers.delete(driver.id);
    }, `driver(${driver.id})`);
  }

  get(id: string): SessionDriver | undefined {
    return this.#drivers.get(id);
  }

  list(): string[] {
    return [...this.#drivers.keys()];
  }

  /** Every registered driver with its selectable models, in registration order. */
  catalog(): DriverCatalogEntry[] {
    return [...this.#drivers.values()].map((driver) => ({
      driver: driver.id,
      models: [...(driver.models ?? [])],
    }));
  }
}
