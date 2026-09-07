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
  /**
   * Reasoning-effort levels this model accepts, in the provider's own
   * vocabulary and in display order. Empty or absent means "default only" —
   * the picker offers no effort control for this model. Dispatching a level a
   * model does not support is the driver's error to raise, not the catalog's
   * to prevent: the list here is advisory, same as the model ids themselves.
   */
  efforts: z.array(z.string()).optional(),
});

export type DriverModel = z.infer<typeof DriverModelSchema>;

/** One driver's slice of the catalog, as served by `GET /api/models`. */
export interface DriverCatalogEntry {
  driver: string;
  models: DriverModel[];
  /** Whether this provider accepts the lower-latency fast-mode setting. */
  supportsFastMode: boolean;
}

/** One provider-native skill shown by the composer's leading-slash picker. */
export interface AgentSkill {
  /** Invocation name, without Claude's `/` or Codex's `$` prefix. */
  name: string;
  /** Provider-native syntax inserted when the user chooses this skill. */
  invocation: "/" | "$";
  description: string;
  /** Provider-supplied argument shape, when the skill declares one. */
  argumentHint?: string;
  /** Where the provider found it. Codex supplies this; Claude currently does not. */
  scope?: "user" | "repo" | "system" | "admin";
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
  /**
   * Correlates a user message accepted mid-run with the point where a driver
   * actually takes it. Harness-authored injections do not need one.
   */
  deliveryId?: string;
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
    ...(injection.deliveryId !== undefined
      ? { deliveryId: injection.deliveryId }
      : {}),
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
  /**
   * Reasoning-effort level, or null for the provider default. Each driver
   * validates against its own vocabulary at the top of `run` — loudly, before
   * any turn spends tokens — because the level sets differ per provider and a
   * silently ignored setting would read as the model underthinking.
   */
  effort: string | null;
  /** Request the provider's lower-latency service tier for this run. */
  fastMode: boolean;
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
  /**
   * This session's own earlier turns, rebuilt from the journal. Supplied only
   * when the thread has history but no resume token — the agent driving it
   * changed, or the previous driver kept no provider-side state — so the new
   * process starts as a continuation rather than with amnesia. Rendered in its
   * own delimited block, after `context` and before the task.
   */
  transcript?: ModelMessage[];
}

export interface DriverSessionResult extends SessionResult {
  /** Provider-native handle to resume this session later. */
  resumeToken?: string;
}

export interface SessionDriver {
  readonly id: string;
  /** Models this driver can dispatch with; empty/absent means "default only". */
  readonly models?: readonly DriverModel[];
  /** Whether this driver can request its provider's lower-latency service tier. */
  readonly supportsFastMode?: boolean;
  /** Skills this provider would make available from the given project root. */
  skills?(workdir: string): Promise<AgentSkill[]>;
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
      supportsFastMode: driver.supportsFastMode === true,
    }));
  }

  /** Ask the selected provider, rather than mirroring its discovery rules. */
  skills(id: string, workdir: string): Promise<AgentSkill[]> {
    const driver = this.#drivers.get(id);
    if (driver === undefined) {
      throw new Error(`driver "${id}" is not registered`);
    }
    return driver.skills?.(workdir) ?? Promise.resolve([]);
  }
}
