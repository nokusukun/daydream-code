import { Service, type Context } from "@daydream-code/kernel";
import type { Disposer } from "@daydream-code/kernel";
import type { SessionId } from "@daydream-code/shared";

declare module "@daydream-code/kernel" {
  interface Context {
    tools: HarnessTools;
  }
}

export interface ToolRunContext {
  sessionId: SessionId;
  projectRoot: string;
}

/**
 * A harness tool exposed to session drivers (adapted per SDK — MCP for the
 * Claude Agent SDK, the Codex equivalent for Codex). `execute` returns the
 * canonical JSON value; presentation is the consumer's problem.
 */
export interface HarnessToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  execute(args: any, run: ToolRunContext): Promise<unknown>;
}

/** Registry seam: tool plugins register in; the session runner hands the set to drivers. */
export class HarnessTools extends Service {
  #tools = new Map<string, HarnessToolDefinition>();

  constructor(ctx: Context) {
    super(ctx, "tools");
  }

  /**
   * Register a tool owned by the calling plugin: pass the caller's own ctx so
   * the registration unwinds when the caller unloads, not when the registry does.
   */
  register(owner: Context, definition: HarnessToolDefinition): Disposer {
    if (this.#tools.has(definition.name)) {
      throw new Error(`tool "${definition.name}" is already registered`);
    }
    return owner.effect(() => {
      this.#tools.set(definition.name, definition);
      return () => this.#tools.delete(definition.name);
    }, `tool(${definition.name})`);
  }

  list(): HarnessToolDefinition[] {
    return [...this.#tools.values()];
  }

  get(name: string): HarnessToolDefinition | undefined {
    return this.#tools.get(name);
  }
}
