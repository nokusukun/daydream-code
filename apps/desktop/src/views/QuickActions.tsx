/**
 * The toolbar's quick-actions popover: the few things you do *to* the open
 * project rather than inside it.
 *
 * This slot used to hold a sidebar toggle. A control whose whole job is to
 * show and hide something you can already see is the cheapest thing in a
 * toolbar — ⌘B and the palette both still do it — so the pixels went to the
 * gestures that had nowhere else to live: open the folder, open a terminal at
 * its root, and whatever command you keep re-typing there.
 *
 * The built-ins are not configurable and the saved ones are: "open this
 * project's folder" means one thing on each platform, while "the command I run
 * here" is different for every person and every stack.
 *
 * The saved list is the *project's*, not this window's, because a session can
 * add to it through `add_quick_action` — so a row can appear here without
 * anyone in this window typing it. Those rows say which session put them
 * there: the click runs the command on your machine, in your login shell,
 * outside whatever sandbox the session that suggested it was confined to, and
 * that is worth knowing before you press it rather than after.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { bridge, type QuickActionRequest } from "../bridge.js";
import { useHarness } from "../harness.js";
import { BoltIcon } from "../ui.js";
import {
  MAX_ACTIONS,
  MAX_COMMAND_LENGTH,
  MAX_LABEL_LENGTH,
  SOURCE_YOU,
} from "@daydream-code/actions";
import { useQuickActionsLive, type QuickActionRecord } from "../quick-actions.js";
import { useDismiss } from "./ActivityMenu.js";

/** What the last click did, held until the next one. */
interface Outcome {
  ok: boolean;
  text: string;
}

/** Finder, Explorer and "file manager" are the same action with three names. */
function revealLabel(platform: string | null): string {
  if (platform === "darwin") return "Reveal in Finder";
  if (platform === "win32") return "Show in Explorer";
  if (platform === null) return "Open project folder";
  return "Show in file manager";
}

/** One IPC round trip for a value that never changes for this window. */
function usePlatform(): string | null {
  const [platform, setPlatform] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    bridge()
      ?.getAppearance()
      .then((appearance) => {
        if (!stale) setPlatform(appearance.platform);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, []);
  return platform;
}

export function QuickActions(): ReactNode {
  const { connection, quickActions: store } = useHarness();
  const [open, setOpen] = useState(false);
  // Re-read on open: the list is shared with the agent, so what it held when
  // this window launched is not what the project has now.
  const actions = useQuickActionsLive(store, open);
  const platform = usePlatform();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setAdding(false);
    setEditing(null);
  }, []);
  useDismiss(rootRef, open, close);

  // The popover is the only place an outcome is shown, so a stale one must not
  // greet the next open: it would report a run that happened minutes ago.
  useEffect(() => {
    if (!open) setOutcome(null);
  }, [open]);

  const run = useCallback(
    async (key: string, request: QuickActionRequest, name: string): Promise<void> => {
      const api = bridge();
      if (api === undefined) {
        setOutcome({ ok: false, text: "not available outside the desktop app" });
        return;
      }
      setBusy(key);
      try {
        const result = await api.runQuickAction(request);
        if (result.ok) {
          // Close on success, the way a platform menu does. A failure keeps the
          // popover up, because the message is the only place it can be read —
          // and so does a command still running after the grace window, which
          // is the one success worth reading: `pnpm dev` that started and
          // `pnpm dev` that exited instantly look identical from here.
          if (result.detail === undefined) {
            close();
            return;
          }
          setOutcome({ ok: true, text: `${name}: ${result.detail}` });
          return;
        }
        setOutcome({ ok: false, text: `${name}: ${result.error}` });
      } catch (error) {
        setOutcome({
          ok: false,
          text: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setBusy(null);
      }
    },
    [close],
  );

  /** Writes fall back to saying so: the popover is where they can be read. */
  const fail = useCallback((error: unknown) => {
    setOutcome({
      ok: false,
      text: error instanceof Error ? error.message : String(error),
    });
  }, []);

  const copyPath = useCallback(() => {
    navigator.clipboard
      .writeText(connection.rootPath)
      .then(() => close())
      .catch(() => setOutcome({ ok: false, text: "could not reach the clipboard" }));
  }, [close, connection.rootPath]);

  return (
    <div className="quick-actions" ref={rootRef}>
      <button
        type="button"
        className="toolbar-icon"
        aria-label="Quick actions"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Quick actions"
        onClick={() => setOpen((v) => !v)}
      >
        <BoltIcon />
      </button>

      {open && (
        <div className="quick-pop pop" role="menu">
          <div className="pop-head">
            quick actions
            <span title={connection.rootPath}>{connection.name}</span>
          </div>

          <button
            type="button"
            className="pop-row"
            disabled={busy !== null}
            onClick={() => void run("reveal", { kind: "reveal" }, "reveal")}
          >
            <span className="pop-row-title">{revealLabel(platform)}</span>
            {busy === "reveal" && <span className="pop-row-meta">opening…</span>}
          </button>
          <button
            type="button"
            className="pop-row"
            disabled={busy !== null}
            onClick={() => void run("terminal", { kind: "terminal" }, "terminal")}
          >
            <span className="pop-row-title">Open in Terminal</span>
            {busy === "terminal" && <span className="pop-row-meta">opening…</span>}
          </button>
          <button type="button" className="pop-row" onClick={copyPath}>
            <span className="pop-row-title">Copy project path</span>
          </button>

          {actions.length > 0 && <div className="pop-sep" role="presentation" />}
          {actions.map((action) =>
            editing === action.id ? (
              <ActionForm
                key={action.id}
                // A label that is only the command was never typed, so it is
                // offered back as blank: editing the command keeps the row
                // named after it instead of pinning the old text.
                initial={{
                  label: action.label === action.command ? "" : action.label,
                  command: action.command,
                }}
                submitLabel="Save"
                onCancel={() => setEditing(null)}
                onSave={(input) => {
                  setEditing(null);
                  void store.update(action.id, input).catch(fail);
                }}
              />
            ) : (
              <CustomRow
                key={action.id}
                action={action}
                busy={busy === action.id}
                disabled={busy !== null}
                onRun={() =>
                  void run(action.id, { kind: "command", command: action.command }, action.label)
                }
                onEdit={() => setEditing(action.id)}
                onRemove={() => void store.remove(action.id).catch(fail)}
              />
            ),
          )}

          <div className="pop-sep" role="presentation" />
          {adding ? (
            <ActionForm
              submitLabel="Add"
              onCancel={() => setAdding(false)}
              onSave={(input) => {
                setAdding(false);
                void store.add(input).catch(fail);
              }}
            />
          ) : (
            <button
              type="button"
              className="pop-row"
              disabled={actions.length >= MAX_ACTIONS}
              onClick={() => setAdding(true)}
            >
              <span className="pop-row-title">Add action…</span>
              <span className="pop-row-meta">runs at the project root</span>
            </button>
          )}

          {outcome !== null && (
            <p className={`quick-outcome${outcome.ok ? "" : " is-error"}`} role="status">
              {outcome.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CustomRow(props: {
  action: QuickActionRecord;
  busy: boolean;
  disabled: boolean;
  onRun(): void;
  onEdit(): void;
  onRemove(): void;
}): ReactNode {
  const { action } = props;
  return (
    <div className="quick-row" role="presentation">
      <button
        type="button"
        className="pop-row quick-row-main"
        disabled={props.disabled}
        onClick={props.onRun}
      >
        <span className="pop-row-title">{action.label}</span>
        {/* The command is the meta line only when the label is not already it,
            so a row named after its command does not print it twice. */}
        {action.label !== action.command && (
          <span className="pop-row-meta mono">{action.command}</span>
        )}
        {action.source !== SOURCE_YOU && (
          <span className="pop-row-meta">added by {action.source}</span>
        )}
        {props.busy && <span className="pop-row-meta">running…</span>}
      </button>
      {/* Edit rather than delete-and-retype: a quick action can be a long
          pasted command line, and a one-character typo in it should not cost
          the whole row. */}
      <button
        type="button"
        className="quick-row-act"
        title={`Edit ${action.label}`}
        aria-label={`Edit ${action.label}`}
        onClick={props.onEdit}
      >
        ✎
      </button>
      <button
        type="button"
        className="quick-row-act is-remove"
        title={`Remove ${action.label}`}
        aria-label={`Remove ${action.label}`}
        onClick={props.onRemove}
      >
        ✕
      </button>
    </div>
  );
}

function ActionForm(props: {
  initial?: { label: string; command: string };
  submitLabel: string;
  onSave(input: { label: string; command: string }): void;
  onCancel(): void;
}): ReactNode {
  const [label, setLabel] = useState(props.initial?.label ?? "");
  const [command, setCommand] = useState(props.initial?.command ?? "");
  const commandRef = useRef<HTMLInputElement>(null);

  useEffect(() => commandRef.current?.select(), []);

  // Submitting nothing is a cancel on both paths: the Save button is disabled
  // for an empty command, and this covers the implicit submit that a bare
  // Enter in the field can still produce.
  const save = (): void => {
    if (command.trim().length === 0) {
      props.onCancel();
      return;
    }
    props.onSave({ label, command });
  };

  return (
    <form
      className="quick-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      // Escape belongs to the form while it is open; the popover's own
      // dismissal would otherwise close the whole menu on the first press.
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <input
        ref={commandRef}
        className="quick-input mono"
        placeholder="pnpm dev"
        aria-label="Command"
        maxLength={MAX_COMMAND_LENGTH}
        value={command}
        onChange={(event) => setCommand(event.target.value)}
      />
      <input
        className="quick-input"
        placeholder="Name (optional)"
        aria-label="Name"
        maxLength={MAX_LABEL_LENGTH}
        value={label}
        onChange={(event) => setLabel(event.target.value)}
      />
      <div className="quick-form-actions">
        <button type="button" className="btn btn-quiet" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={command.trim().length === 0}
        >
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}
