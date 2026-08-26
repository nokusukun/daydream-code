import { Service, type Context } from "@daydream-code/kernel";

declare module "@daydream-code/kernel" {
  interface Context {
    actions: QuickActions;
  }
  interface Events {
    /**
     * @mode emit — after the row is durably committed. `null` for a removal:
     * the list is small enough that a listener re-reads it rather than
     * patching, so which row went is not worth a second frame shape.
     */
    "actions/changed"(action: QuickActionRecord | null): void;
  }
}

/**
 * One saved shell line, as the toolbar shows it.
 *
 * `source` is provenance, not authorization: `"you"` for a row the person
 * typed, otherwise the name of the session that added it. It exists because a
 * command that arrives in your toolbar without you typing it should say where
 * it came from before you click it — the click runs it on your machine, in
 * your login shell, outside whatever sandbox the session that suggested it
 * was running in.
 */
export interface QuickActionRecord {
  id: string;
  /** What the row says. Falls back to the command when none is given. */
  label: string;
  /** A shell line, run at the project root. */
  command: string;
  source: string;
  createdAt: string;
}

export interface QuickActionInput {
  label?: string;
  command: string;
  /** Defaults to `"you"`; the tool passes the calling session's name. */
  source?: string;
}

/** The person's own rows. Anything else names the session that added it. */
export const SOURCE_YOU = "you";

/**
 * Bounds. A quick action is a line someone will read in a menu and a line a
 * shell will run: the first wants it short, the second wants it whole.
 */
export const MAX_ACTIONS = 20;
export const MAX_LABEL_LENGTH = 60;
export const MAX_COMMAND_LENGTH = 2000;

/** Raised when the list is full, so a caller can say which limit it hit. */
export class QuickActionError extends Error {}

/**
 * One action's fields, cleaned, or null when there is nothing to run.
 *
 * Shared by the provider, the routes and the tool rather than each validating
 * its own way: a model writes into the same list a person does, and two
 * definitions of "valid" would mean the agent could store a row the UI would
 * refuse to. The label may be empty and falls back to the command, because
 * "what it does" and "what to call it" are the same string for `pnpm test`.
 */
export function normalizeAction(
  input: QuickActionInput,
): { label: string; command: string; source: string } | null {
  const command = input.command.trim().slice(0, MAX_COMMAND_LENGTH);
  // A NUL cannot survive being handed to a shell as an argument, and a
  // newline would turn one row into two commands with one label.
  if (command.length === 0 || /[\0\r\n]/.test(command)) return null;
  const label = (input.label ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_LABEL_LENGTH);
  const source = (input.source ?? SOURCE_YOU).trim().slice(0, MAX_LABEL_LENGTH);
  return {
    label: label.length > 0 ? label : command,
    command,
    source: source.length > 0 ? source : SOURCE_YOU,
  };
}

/**
 * Exclusive seam: the project's quick actions.
 *
 * A seam rather than a table two callers reach into, because there are exactly
 * two authors — the person, through the desktop toolbar, and a session,
 * through `add_quick_action` — and both must land on the same list with the
 * same bounds. The cap and the "adding a command twice is a no-op" rule live
 * here for that reason, not in whichever caller remembered them.
 */
export abstract class QuickActions extends Service {
  constructor(ctx: Context) {
    super(ctx, "actions");
  }

  /** Oldest first: the toolbar draws them in the order they were added. */
  abstract list(): QuickActionRecord[];
  abstract get(id: string): QuickActionRecord | undefined;
  /**
   * Add, or return the existing row when this project already has the same
   * command. Throws `QuickActionError` when the list is full or the command is
   * not runnable.
   */
  abstract add(input: QuickActionInput): QuickActionRecord;
  /** Edit in place. An emptied command removes the row. Undefined if unknown. */
  abstract update(
    id: string,
    patch: { label?: string; command?: string },
  ): QuickActionRecord | undefined;
  abstract remove(id: string): boolean;
}
