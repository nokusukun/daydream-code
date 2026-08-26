/**
 * One setting: a label, a control chosen by the declared kind, its provenance,
 * and whatever the last write had to say about it.
 *
 * Rows, not cards. A settings pane is a long list of label/control pairs, and
 * boxing each one would turn thirty settings into thirty objects to parse.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { SettingDescriptor } from "../api.js";
import type { RowStatus } from "../settings-store.js";
import { titleCaseSettingName } from "../title-case.js";

export interface FieldProps {
  descriptor: SettingDescriptor;
  /** Effective value: this layer's, an inherited one, or the schema default. */
  value: unknown;
  /** True when a config layer sets it, rather than it coming from the default. */
  overridden: boolean;
  /** Which layer set it, when one did. */
  origin?: string | undefined;
  status?: RowStatus | undefined;
  disabled?: boolean | undefined;
  onChange(value: unknown): void;
  onReset(): void;
}

/**
 * `user:config.yml` reads as `user` in a chip a few characters wide.
 *
 * The base bundle is named rather than folded into "default", because the two
 * are genuinely different: "default" means the plugin's own fallback, "bundle"
 * means the shipped composition chose a value. Neither is something the user
 * set, which is why neither offers a reset.
 */
export function layerName(source: string | undefined): string {
  if (source === undefined) return "default";
  if (source.startsWith("bundle:")) return "bundle";
  if (source.startsWith("user:")) return "user";
  if (source.startsWith("project:")) return "project";
  if (source === "overrides") return "command line";
  return source;
}

/** Only a value a config layer set can be reset; base and defaults cannot. */
export function isUserSet(source: string | undefined): boolean {
  return source !== undefined && !source.startsWith("bundle:");
}

export function SettingRow(props: {
  label: string;
  help?: string | undefined;
  htmlFor?: string | undefined;
  origin?: string | undefined;
  overridden?: boolean;
  status?: RowStatus | undefined;
  onReset?: (() => void) | undefined;
  /**
   * Project-row settings live in the database, not in a config layer, so there
   * is no layer to name and claiming one would be a lie.
   */
  showOrigin?: boolean;
  control: ReactNode;
}): ReactNode {
  const { status } = props;
  return (
    <div className="set-row">
      <div className="set-label">
        <label htmlFor={props.htmlFor}>{titleCaseSettingName(props.label)}</label>
        {props.help !== undefined && <p className="set-help">{props.help}</p>}
        <FieldNote status={status} />
      </div>
      <div className="set-control">
        {props.control}
        <div className="set-meta">
          {props.showOrigin === false ? (
            props.onReset !== undefined && (
              <button type="button" className="set-reset" onClick={props.onReset}>
                reset
              </button>
            )
          ) : (
            <>
              <span
                className={
                  props.overridden === true && isUserSet(props.origin)
                    ? "set-origin"
                    : "set-origin set-origin-default"
                }
                title="where this value comes from"
              >
                {props.overridden === true ? layerName(props.origin) : "default"}
              </span>
              {props.overridden === true &&
                isUserSet(props.origin) &&
                props.onReset !== undefined && (
                  <button type="button" className="set-reset" onClick={props.onReset}>
                    reset
                  </button>
                )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The outcome of the last write. `restart` is not an error: the value is on
 * disk and correct, it simply is not the one running yet, and saying "failed"
 * there would send the user looking for a problem that does not exist.
 */
function FieldNote(props: { status: RowStatus | undefined }): ReactNode {
  const { status } = props;
  if (status === undefined) return null;
  if (status.state === "saving") {
    return (
      <p className="set-note set-note-saving" role="status">
        saving
      </p>
    );
  }
  if (status.state === "applied") {
    return (
      <p className="set-note set-note-ok" role="status">
        applied
      </p>
    );
  }
  if (status.state === "restart") {
    return (
      <p className="set-note set-note-warn" role="status">
        saved. {status.message ?? "relaunch to apply."}
      </p>
    );
  }
  return (
    <p className="set-note set-note-bad" role="alert">
      {status.message ?? "could not save"}
    </p>
  );
}

/**
 * Text and number inputs commit on blur and on Enter rather than on every
 * keystroke: each commit is an HTTP write that may remount a plugin, and doing
 * that per character would be both slow and genuinely destructive.
 */
function useDeferredValue(
  value: string,
  onCommit: (next: string) => void,
): {
  draft: string;
  setDraft(next: string): void;
  commit(): void;
  cancel(): void;
} {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  useEffect(() => {
    // Adopt values that changed underneath us, but never while the user is
    // mid-edit, or a slow round trip would eat their typing.
    if (committed.current !== value) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);
  return {
    draft,
    setDraft,
    commit: () => {
      if (draft === committed.current) return;
      committed.current = draft;
      onCommit(draft);
    },
    cancel: () => setDraft(committed.current),
  };
}

export function SettingField(props: FieldProps): ReactNode {
  const { descriptor: field, value, disabled } = props;
  const id = useId();
  const shared = {
    label: field.label,
    help: field.help,
    htmlFor: id,
    origin: props.origin,
    overridden: props.overridden,
    status: props.status,
    onReset: props.overridden ? props.onReset : undefined,
  };

  if (field.kind === "boolean") {
    return (
      <SettingRow
        {...shared}
        control={
          <label className="set-switch">
            <input
              id={id}
              type="checkbox"
              checked={value === true}
              disabled={disabled}
              onChange={(event) => props.onChange(event.target.checked)}
            />
            <span className="set-switch-track" aria-hidden="true">
              <span className="set-switch-knob" />
            </span>
            <span className="set-switch-text">{value === true ? "on" : "off"}</span>
          </label>
        }
      />
    );
  }

  if (field.kind === "enum") {
    return (
      <SettingRow
        {...shared}
        control={
          <select
            id={id}
            className="set-input set-select"
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(event) => props.onChange(event.target.value)}
          >
            {field.optional && <option value="">not set</option>}
            {(field.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        }
      />
    );
  }

  if (field.kind === "number") {
    return (
      <NumberField {...props} id={id} shared={shared} />
    );
  }

  if (field.kind === "list" || field.kind === "json") {
    return <JsonField {...props} id={id} shared={shared} />;
  }

  return <StringField {...props} id={id} shared={shared} />;
}

type SharedRow = Omit<Parameters<typeof SettingRow>[0], "control">;

function NumberField(props: FieldProps & { id: string; shared: SharedRow }): ReactNode {
  const { descriptor: field } = props;
  const text = typeof props.value === "number" ? String(props.value) : "";
  const [invalid, setInvalid] = useState<string | null>(null);
  const editor = useDeferredValue(text, (next) => {
    if (next.trim() === "") {
      setInvalid(null);
      props.onReset();
      return;
    }
    const parsed = Number(next);
    if (!Number.isFinite(parsed)) return setInvalid("must be a number");
    if (field.integer === true && !Number.isInteger(parsed)) {
      return setInvalid("must be a whole number");
    }
    if (field.min !== undefined && parsed < field.min) {
      return setInvalid(`must be at least ${field.min}`);
    }
    if (field.max !== undefined && parsed > field.max) {
      return setInvalid(`must be at most ${field.max}`);
    }
    setInvalid(null);
    props.onChange(parsed);
  });

  return (
    <SettingRow
      {...props.shared}
      status={invalid !== null ? { state: "error", message: invalid } : props.shared.status}
      control={
        <span className="set-inputwrap">
          <input
            id={props.id}
            className="set-input set-input-num"
            type="text"
            inputMode="numeric"
            value={editor.draft}
            disabled={props.disabled}
            aria-invalid={invalid !== null}
            placeholder={field.default !== undefined ? String(field.default) : ""}
            onChange={(event) => editor.setDraft(event.target.value)}
            onBlur={editor.commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") editor.commit();
              if (event.key === "Escape") editor.cancel();
            }}
          />
          {field.unit !== undefined && <span className="set-unit">{field.unit}</span>}
        </span>
      }
    />
  );
}

function StringField(props: FieldProps & { id: string; shared: SharedRow }): ReactNode {
  const { descriptor: field } = props;
  const [revealed, setRevealed] = useState(false);
  const text = typeof props.value === "string" ? props.value : "";
  const editor = useDeferredValue(text, (next) => {
    if (next === "" && field.optional) props.onReset();
    else props.onChange(next);
  });

  if (field.multiline === true) {
    return (
      <SettingRow
        {...props.shared}
        control={
          <textarea
            id={props.id}
            className="set-input set-textarea"
            rows={3}
            value={editor.draft}
            disabled={props.disabled}
            placeholder={field.placeholder ?? ""}
            onChange={(event) => editor.setDraft(event.target.value)}
            onBlur={editor.commit}
          />
        }
      />
    );
  }

  return (
    <SettingRow
      {...props.shared}
      control={
        <span className="set-inputwrap">
          <input
            id={props.id}
            className="set-input"
            // A secret still has to be typeable and correctable, so it is a
            // password field with a reveal rather than a write-only box.
            type={field.secret === true && !revealed ? "password" : "text"}
            value={editor.draft}
            disabled={props.disabled}
            placeholder={
              field.placeholder ??
              (typeof field.default === "string" ? field.default : "")
            }
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => editor.setDraft(event.target.value)}
            onBlur={editor.commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") editor.commit();
              if (event.key === "Escape") editor.cancel();
            }}
          />
          {field.secret === true && (
            <button
              type="button"
              className="set-reveal"
              aria-pressed={revealed}
              onClick={() => setRevealed((current) => !current)}
            >
              {revealed ? "hide" : "show"}
            </button>
          )}
        </span>
      }
    />
  );
}

/**
 * Lists and free-form shapes, edited as JSON.
 *
 * A generated row editor for `models` was tempting, but the catalog is edited
 * once in a blue moon and a wrong-shaped form would be worse than the text: the
 * schema validates the result server-side either way, and the error comes back
 * naming the field.
 */
function JsonField(props: FieldProps & { id: string; shared: SharedRow }): ReactNode {
  const text = props.value === undefined ? "" : JSON.stringify(props.value, null, 2);
  const [invalid, setInvalid] = useState<string | null>(null);
  const editor = useDeferredValue(text, (next) => {
    if (next.trim() === "") {
      setInvalid(null);
      props.onReset();
      return;
    }
    try {
      const parsed: unknown = JSON.parse(next);
      setInvalid(null);
      props.onChange(parsed);
    } catch (error) {
      setInvalid(error instanceof Error ? error.message : "invalid JSON");
    }
  });

  const rows = Math.min(14, Math.max(3, editor.draft.split("\n").length));
  return (
    <SettingRow
      {...props.shared}
      status={invalid !== null ? { state: "error", message: invalid } : props.shared.status}
      control={
        <textarea
          id={props.id}
          className="set-input set-textarea set-json"
          rows={rows}
          value={editor.draft}
          disabled={props.disabled}
          spellCheck={false}
          aria-invalid={invalid !== null}
          onChange={(event) => editor.setDraft(event.target.value)}
          onBlur={editor.commit}
        />
      }
    />
  );
}
