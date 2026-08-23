import { Service, type Context, type Disposer } from "@daydream-code/kernel";
import type {
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

/** A message injected into a running session between or during turns. */
export interface Injection {
  kind: "user" | "master_update";
  text: string;
}

export type PermissionMode = "auto" | "ask" | "readonly";

export interface DriverRunInput {
  sessionId: SessionId;
  workdir: string;
  /** Forked master-thread context, normalized, oldest first. */
  context: ModelMessage[];
  task: string;
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
}
