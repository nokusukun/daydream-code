import type { Context } from "@daydream-code/kernel";
import { schema } from "@daydream-code/store";
import { eq } from "@daydream-code/store/drizzle";
import { MAX_COMMAND_LENGTH, MAX_LABEL_LENGTH, QuickActionError } from "./index.js";
import type { ToolRunContext } from "@daydream-code/tools";
import type {} from "./index.js";
import type {} from "@daydream-code/tools";
import type {} from "@daydream-code/store";

interface AddArgs {
  command?: unknown;
  label?: unknown;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Consumer plugin: the tools a session uses to put a command in the person's
 * toolbar.
 *
 * It lives in this package rather than in `packages/tools` for the reason
 * `send_session` lives in `packages/session`: the capability owns its tools, and
 * depending downhill on the tool registry costs nothing. That also keeps the
 * bounds in one place — the tool, the routes and the toolbar all add through
 * the same seam.
 *
 * There is deliberately no `remove_quick_action`. Offering a person a command
 * and deleting one they saved are different acts: the first is a suggestion
 * they accept by clicking, the second is a change to their tools made without
 * them. The seam can remove; nothing the model can call does.
 */
const actionTools = {
  name: "action-tools",
  inject: ["tools", "actions", "store"],
  apply(ctx: Context) {
    /**
     * The calling session's name, for the row's provenance. Read from the
     * sessions table directly rather than through `ctx.sessions`, which
     * depends on the tool registry this package registers into — the reverse
     * import would be a build cycle. Same reason `recall.ts` does it.
     */
    const nameOf = (run: ToolRunContext): string => {
      const row = ctx.store.db
        .select({ name: schema.sessions.name })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, run.sessionId))
        .get();
      return row?.name ?? run.sessionId;
    };

    ctx.tools.register(ctx, {
      name: "add_quick_action",
      description:
        "Save a shell command as a one-click button in the user's toolbar, run at this project's root. " +
        "Use it when you have set up or discovered something they will want to run again themselves — the dev server, a test watcher, a build, a script you just wrote. " +
        "It does NOT run the command: it offers it, and the row is labelled with your session name so they can see where it came from. " +
        "Do not use it as a way to execute something (run it yourself), for a one-off command, or for anything destructive or long-lived that the user did not ask for — the button stays in their toolbar until they delete it. " +
        "Adding a command this project already has changes nothing and reports the existing row.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The shell line to save, e.g. `pnpm dev`. One line; it runs at the project root through the user's login shell.",
          },
          label: {
            type: "string",
            description:
              "Short name for the button, e.g. `Dev server`. Omit when the command reads well as its own name.",
          },
        },
        required: ["command"],
      },
      async execute(args: AddArgs, run: ToolRunContext) {
        // The Claude adapter's JSON-Schema -> zod conversion is structural,
        // not enforcing, so bounds are checked here rather than assumed.
        const command = str(args.command);
        if (command.length === 0) {
          throw new Error("`command` is required and must be a shell line to run");
        }
        if (command.length > MAX_COMMAND_LENGTH) {
          throw new Error(`\`command\` must be at most ${MAX_COMMAND_LENGTH} characters`);
        }
        if (/[\r\n]/.test(command)) {
          throw new Error(
            "`command` must be a single line. Put a multi-step command in a script and save the line that runs it.",
          );
        }
        const label = str(args.label).slice(0, MAX_LABEL_LENGTH);

        try {
          const before = ctx.actions.list().some((a) => a.command === command);
          const action = ctx.actions.add({
            command,
            ...(label.length > 0 ? { label } : {}),
            source: nameOf(run),
          });
          return {
            ...action,
            /** So the model reports "already there" rather than "added". */
            alreadyExisted: before,
          };
        } catch (error) {
          if (error instanceof QuickActionError) throw new Error(error.message);
          throw error;
        }
      },
    });

    ctx.tools.register(ctx, {
      name: "list_quick_actions",
      description:
        "List the quick actions saved in this project's toolbar, with who added each one. " +
        "Call it before add_quick_action when you are about to offer something the user may already have, or when they ask what is in their toolbar.",
      parameters: { type: "object", properties: {} },
      execute: () => Promise.resolve(ctx.actions.list()),
    });
  },
};

export default actionTools;
