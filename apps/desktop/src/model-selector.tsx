/**
 * t3-style model picker: one control selecting (driver, model) for a dispatch.
 * A searchable popover lists every driver's catalog (from `GET /api/models`)
 * grouped per driver, with starred favorites pinned on top. Reasoning effort
 * is a second pill beside it with its own small popup — a separate axis gets
 * a separate control. Favorites and the last choice persist in localStorage.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { DriverCatalogEntry } from "./api.js";
import { useHarness } from "./harness.js";
import { ProviderIcon } from "./provider-icon.js";

export interface ModelChoice {
  driver: string;
  /** null = the driver's own default model. */
  modelId: string | null;
  /** null = the driver's own default reasoning effort. */
  effort: string | null;
}

const CHOICE_KEY = "daydream.model-choice";
const FAVORITES_KEY = "daydream.model-favorites";

const DEFAULT_CHOICE: ModelChoice = { driver: "claude", modelId: null, effort: null };

/** Popover widths, mirrored from the CSS, and the viewport gutter they keep. */
const POP_WIDTH = 320;
const EFFORT_POP_WIDTH = 172;
const EDGE = 8;

/**
 * Anchors a body-portaled popover above its trigger and dismisses it on a
 * press outside. Shared by the model and effort popovers: two controls that
 * sit side by side must open, follow scroll, and dismiss identically, or the
 * pair reads as two inventions rather than one.
 */
function usePopoverAnchor(args: {
  open: boolean;
  trigger: RefObject<HTMLElement | null>;
  pop: RefObject<HTMLElement | null>;
  /** Width assumed before the popover has painted, mirrored from the CSS. */
  width: number;
  /** A press inside any of these does not dismiss. */
  within: RefObject<HTMLElement | null>[];
  onDismiss: () => void;
}): { left: number; bottom: number } | null {
  const { open, trigger, pop, width } = args;
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(
    null,
  );
  // Read at event time through refs so the effect does not re-subscribe every
  // render over inline arrays and callbacks.
  const withinRef = useRef(args.within);
  withinRef.current = args.within;
  const dismissRef = useRef(args.onDismiss);
  dismissRef.current = args.onDismiss;

  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }

    // The popover renders through a portal, so it is positioned against the
    // viewport rather than the trigger. `bottom` anchors it above the trigger,
    // which is where it has always opened.
    const place = (): void => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const w = pop.current?.offsetWidth ?? width;
      setAnchor({
        left: Math.max(EDGE, Math.min(rect.left, window.innerWidth - w - EDGE)),
        bottom: window.innerHeight - rect.top + 6,
      });
    };
    place();

    const onDown = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return;
      for (const ref of withinRef.current) {
        if (ref.current?.contains(event.target) === true) return;
      }
      dismissRef.current();
    };

    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    // Capture, so a scroll in any ancestor scroller moves the popover with it.
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, trigger, pop, width]);

  return anchor;
}

/** Shown before the catalog loads or when the endpoint is unreachable. */
const FALLBACK_CATALOG: DriverCatalogEntry[] = [
  { driver: "claude", models: [] },
  { driver: "codex", models: [] },
  { driver: "mock", models: [] },
];

/**
 * Storage is a trust boundary, not a type boundary: a choice saved by an
 * older build has no `effort` key at all, so the guard checks only the two
 * fields every build wrote and `loadChoice` fills the rest in. Requiring
 * `effort` here would silently reset everyone's model on upgrade.
 */
function isStoredChoice(
  value: unknown,
): value is { driver: string; modelId: string | null; effort?: unknown } {
  if (typeof value !== "object" || value === null) return false;
  if (!("driver" in value) || !("modelId" in value)) return false;
  return (
    typeof value.driver === "string" &&
    (value.modelId === null || typeof value.modelId === "string")
  );
}

function readJson(key: string): unknown {
  const raw = localStorage.getItem(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function loadChoice(): ModelChoice {
  const parsed = readJson(CHOICE_KEY);
  if (!isStoredChoice(parsed)) return DEFAULT_CHOICE;
  return {
    driver: parsed.driver,
    modelId: parsed.modelId,
    effort: typeof parsed.effort === "string" ? parsed.effort : null,
  };
}

/**
 * Effort levels the catalog claims for one concrete model. Empty for the
 * "default" row: with no model pinned there is nothing to look the levels up
 * against, so the picker offers no effort control rather than a guessed one.
 */
export function modelEfforts(
  catalog: DriverCatalogEntry[],
  driver: string,
  modelId: string | null,
): string[] {
  if (modelId === null) return [];
  const model = catalog
    .find((entry) => entry.driver === driver)
    ?.models.find((m) => m.id === modelId);
  return model?.efforts ?? [];
}

function saveChoice(choice: ModelChoice): void {
  localStorage.setItem(CHOICE_KEY, JSON.stringify(choice));
}

function loadFavorites(): Set<string> {
  const parsed = readJson(FAVORITES_KEY);
  return Array.isArray(parsed)
    ? new Set(parsed.filter((entry): entry is string => typeof entry === "string"))
    : new Set();
}

function saveFavorites(favorites: Set<string>): void {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
}

/** Favorite key for a concrete model; default rows are not favoritable. */
function favKey(driver: string, modelId: string): string {
  return `${driver}/${modelId}`;
}

interface Row {
  driver: string;
  modelId: string | null;
  label: string;
  description: string | undefined;
}

interface Group {
  title: string;
  /** Driver whose mark labels the group; absent for "favorites". */
  driver?: string;
  rows: Row[];
}

/**
 * Display casing only. Stored/dispatched values stay lowercase — the catalog
 * and the wire speak "high"/"xhigh", and casing them at the source would turn
 * a cosmetic preference into a protocol change.
 */
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function rowMatches(row: Row, query: string): boolean {
  if (query.length === 0) return true;
  const haystack =
    `${row.driver} ${row.modelId ?? "default"} ${row.label}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((term) => haystack.includes(term));
}

function buildGroups(
  catalog: DriverCatalogEntry[],
  favorites: Set<string>,
  query: string,
): Group[] {
  const groups: Group[] = [];

  const starred: Row[] = [];
  for (const entry of catalog) {
    for (const model of entry.models) {
      if (!favorites.has(favKey(entry.driver, model.id))) continue;
      const row: Row = {
        driver: entry.driver,
        modelId: model.id,
        label: model.label,
        description: model.description,
      };
      if (rowMatches(row, query)) starred.push(row);
    }
  }
  if (starred.length > 0) groups.push({ title: "favorites", rows: starred });

  for (const entry of catalog) {
    const rows: Row[] = [
      {
        driver: entry.driver,
        modelId: null,
        label: "Default",
        description: "let the driver decide",
      },
      ...entry.models.map((model) => ({
        driver: entry.driver,
        modelId: model.id,
        label: model.label,
        description: model.description,
      })),
    ].filter((row) => rowMatches(row, query));
    if (rows.length > 0) {
      groups.push({ title: entry.driver, driver: entry.driver, rows });
    }
  }

  return groups;
}

export function ModelSelector(props: {
  value: ModelChoice;
  onChange(choice: ModelChoice): void;
  disabled?: boolean;
  /**
   * Whether a pick becomes the remembered default for *new* threads. The
   * dispatch composer wants that; a selector bound to one existing thread
   * (switching its agent, or picking a handoff target) must not overwrite the
   * global default as a side effect of touching one thread.
   */
  persist?: boolean;
}): ReactNode {
  const { value, onChange } = props;
  const persist = props.persist !== false;
  const { api, modelLabel } = useHarness();
  const [catalog, setCatalog] = useState<DriverCatalogEntry[]>(FALLBACK_CATALOG);
  // One slot for both popovers: they are siblings on one control cluster, and
  // a single state makes "opening one closes the other" structural rather
  // than something every handler has to remember.
  const [openPop, setOpenPop] = useState<"model" | "effort" | null>(null);
  const open = openPop === "model";
  const effortOpen = openPop === "effort";
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(loadFavorites);
  /**
   * One-shot pulse key for the star that was just favorited. Driven from the
   * toggle action rather than the `starred` class, so reopening the popover
   * never replays it: the celebration belongs to the act, not the state.
   */
  const [starPulse, setStarPulse] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  /**
   * Whether the roving index last moved by keyboard or by mouse. Only a
   * keyboard move scrolls the list: a programmatic scroll slides rows under a
   * stationary cursor, and letting that hover re-set `active` would yank the
   * index straight back to wherever the mouse happened to rest.
   */
  const navSource = useRef<"key" | "mouse">("key");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const effortTriggerRef = useRef<HTMLButtonElement>(null);
  const effortPopRef = useRef<HTMLDivElement>(null);

  const dismiss = useCallback(() => setOpenPop(null), []);
  const anchor = usePopoverAnchor({
    open,
    trigger: triggerRef,
    pop: popRef,
    width: POP_WIDTH,
    within: [rootRef, popRef],
    onDismiss: dismiss,
  });
  const effortAnchor = usePopoverAnchor({
    open: effortOpen,
    trigger: effortTriggerRef,
    pop: effortPopRef,
    width: EFFORT_POP_WIDTH,
    within: [rootRef, effortPopRef],
    onDismiss: dismiss,
  });

  useEffect(() => {
    let stale = false;
    api
      .models()
      .then((entries) => {
        if (!stale && entries.length > 0) setCatalog(entries);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api]);

  // Focus can only land once the popover is actually visible: until the
  // anchor is measured it renders `visibility: hidden`, and a hidden element
  // refuses focus — calling focus() in the open effect silently did nothing.
  const visible = open && anchor !== null;
  useEffect(() => {
    if (visible) searchRef.current?.focus();
  }, [visible]);

  const groups = useMemo(
    () => buildGroups(catalog, favorites, query.trim()),
    [catalog, favorites, query],
  );
  const flatRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  useEffect(() => {
    // "key", so the reset also scrolls the filtered list back to its top.
    navSource.current = "key";
    setActive(0);
  }, [query]);

  // Opening starts the roving index on the row already in effect, so Enter
  // confirms rather than silently switching to whatever sorted first.
  useEffect(() => {
    if (!open) return;
    navSource.current = "key";
    const i = flatRows.findIndex(
      (row) => row.driver === value.driver && row.modelId === value.modelId,
    );
    setActive(i >= 0 ? i : 0);
    // Only when the popover opens: favorites toggling mid-session reshuffles
    // flatRows, and snapping back to the selection then would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The list is shorter than the catalog, so a keyboard move has to bring its
  // row into view; `nearest` keeps mouse hovers (already visible) a no-op.
  useEffect(() => {
    if (!open || navSource.current !== "key") return;
    document
      .getElementById(rowId(active))
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  /**
   * Deliberate closes (Enter, Escape, picking a row) hand focus back to the
   * trigger, so a keyboard user is not dropped onto `body`. The outside-click
   * path calls `setOpen(false)` directly: the user clicked somewhere else on
   * purpose, and stealing focus back would undo that.
   */
  const close = useCallback(() => {
    setOpenPop(null);
    triggerRef.current?.focus();
  }, []);

  /** The effort popup's deliberate close, returning focus to its own pill. */
  const closeEffort = useCallback(() => {
    setOpenPop(null);
    effortTriggerRef.current?.focus();
  }, []);

  const select = useCallback(
    (row: Row) => {
      // A pinned effort follows the model only where the new model lists it;
      // otherwise it falls back to default rather than dispatching a level
      // the driver would refuse.
      const efforts = modelEfforts(catalog, row.driver, row.modelId);
      const effort =
        value.effort !== null && efforts.includes(value.effort)
          ? value.effort
          : null;
      const choice: ModelChoice = { driver: row.driver, modelId: row.modelId, effort };
      if (persist) saveChoice(choice);
      onChange(choice);
      close();
      setQuery("");
    },
    [onChange, catalog, value.effort, close, persist],
  );

  const selectEffort = useCallback(
    (effort: string | null) => {
      const choice: ModelChoice = { ...value, effort };
      if (persist) saveChoice(choice);
      onChange(choice);
      // Its own popup closes on pick, like any select. The old in-popover
      // strip stayed open, but that was a footer inside a larger dialog.
      closeEffort();
    },
    [onChange, value, closeEffort, persist],
  );

  /** Levels for the model currently in effect; empty hides the strip. */
  const efforts = useMemo(
    () => modelEfforts(catalog, value.driver, value.modelId),
    [catalog, value.driver, value.modelId],
  );

  /**
   * The levels the popup offers. A pinned effort the catalog no longer lists
   * (an old localStorage choice, a renamed level) is appended rather than
   * hidden: the pill is the only place it can be seen and cleared, and a
   * control that dispatches an invisible value is the worse bug.
   */
  const levels = useMemo(() => {
    const base: (string | null)[] = [null, ...efforts];
    if (value.effort !== null && !efforts.includes(value.effort)) {
      base.push(value.effort);
    }
    return base;
  }, [efforts, value.effort]);

  /**
   * Focus-driven listbox: options carry real focus (there is no search input
   * here to hold it), arrows move it, Enter and Space are the buttons' own
   * activation. Escape closes and hands focus back to the pill.
   */
  const onEffortPopKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        closeEffort();
        return;
      }
      const options = effortPopRef.current
        ? [...effortPopRef.current.querySelectorAll<HTMLButtonElement>("[role=option]")]
        : [];
      if (options.length === 0) return;
      const current = options.indexOf(document.activeElement as HTMLButtonElement);
      let next: number;
      if (event.key === "ArrowDown") next = (current + 1) % options.length;
      else if (event.key === "ArrowUp")
        next = (current - 1 + options.length) % options.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = options.length - 1;
      else return;
      event.preventDefault();
      options[next]?.focus();
    },
    [closeEffort],
  );

  // Focus lands on the selected level once the popup is visible — the same
  // visibility gate as the search field: a `visibility: hidden` element
  // (pre-anchor) refuses focus.
  const effortVisible = effortOpen && effortAnchor !== null;
  useEffect(() => {
    if (!effortVisible) return;
    const options = effortPopRef.current?.querySelectorAll<HTMLButtonElement>(
      "[role=option]",
    );
    if (options === undefined || options.length === 0) return;
    const selected = [...options].find(
      (option) => option.getAttribute("aria-selected") === "true",
    );
    (selected ?? options[0])?.focus();
  }, [effortVisible]);

  const toggleFavorite = useCallback(
    (row: Row) => {
      if (row.modelId === null) return;
      const key = favKey(row.driver, row.modelId);
      setFavorites((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        saveFavorites(next);
        return next;
      });
      // Only starring pulses. Removal stays quiet: taking something away is
      // not a moment to celebrate.
      setStarPulse(favorites.has(key) ? null : key);
    },
    [favorites],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === "Escape") {
        // The native search-field rhythm: the first Escape clears the query,
        // the second closes. A user mid-typo gets their full list back
        // without losing the popover they just opened.
        if (query.length > 0) {
          setQuery("");
          return;
        }
        close();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (flatRows.length === 0) return;
        navSource.current = "key";
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + delta + flatRows.length) % flatRows.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const row = flatRows[active];
        if (row !== undefined) select(row);
      }
    },
    [flatRows, active, select, close, query],
  );

  const current = useMemo(
    () => modelLabel(value.driver, value.modelId),
    [modelLabel, value],
  );

  // Stable per-position ids so `aria-activedescendant` has something to point
  // at. Position, not model id, because that is what the roving index moves.
  const rowId = (i: number): string => `model-row-${i}`;
  const activeRowId =
    active >= 0 && active < flatRows.length ? rowId(active) : null;

  let index = -1;
  return (
    <div className="model-select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="model-trigger"
        disabled={props.disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpenPop((p) => (p === "model" ? null : "model"))}
        title="Driver and model for this dispatch"
      >
        {/* Keyed on the choice so a pick visibly lands: the popover closes
            and the new label rises into the pill rather than the text just
            being different. The icon keys on the driver alone, so switching
            models within a driver moves only the label. */}
        <ProviderIcon
          key={value.driver}
          driver={value.driver}
          className="provider-icon model-choice-in"
        />
        <span
          key={`${value.driver}/${value.modelId ?? ""}`}
          className="model-trigger-label model-choice-in"
        >
          {current.label}
        </span>
        <span
          className={"model-caret" + (open ? " model-caret-open" : "")}
          aria-hidden="true"
        >
          ▴
        </span>
      </button>
      {/* Hidden, not disabled, when the model in effect lists no levels: a
          control for an axis that does not exist would be noise, and the
          same rule hid the old strip. */}
      {levels.length > 1 && (
        <button
          ref={effortTriggerRef}
          type="button"
          className="model-trigger effort-trigger"
          disabled={props.disabled}
          aria-haspopup="listbox"
          aria-expanded={effortOpen}
          onClick={() => setOpenPop((p) => (p === "effort" ? null : "effort"))}
          title="Reasoning effort for this dispatch"
        >
          <span className="effort-kicker">Effort</span>
          <span
            key={value.effort ?? "default"}
            className="model-trigger-label model-choice-in"
          >
            {titleCase(value.effort ?? "default")}
          </span>
          <span
            className={"model-caret" + (effortOpen ? " model-caret-open" : "")}
            aria-hidden="true"
          >
            ▴
          </span>
        </button>
      )}
      {open &&
        createPortal(
          /*
           * Portaled to the body on purpose. `backdrop-filter` on an ancestor
           * establishes a backdrop root, and the composer has one — so a blur
           * here sampled the composer's own composited output instead of the
           * transcript behind it, and the glass flattened to a plain tint.
           * Out here it filters the page, so the material reads.
           */
          <div
            ref={popRef}
            className="model-pop glass-strong"
            role="dialog"
            aria-label="Choose a driver and model"
            onKeyDown={onKeyDown}
            style={
              anchor === null
                ? { visibility: "hidden" }
                : { left: anchor.left, bottom: anchor.bottom }
            }
          >
          <input
            ref={searchRef}
            id="model-search"
            type="text"
            className="model-search"
            aria-label="Search models"
            placeholder="Search models"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            role="combobox"
            aria-expanded
            aria-controls="model-list"
            aria-autocomplete="list"
            {...(activeRowId === null ? {} : { "aria-activedescendant": activeRowId })}
          />
          {/* The rows are options, not decorated divs: the roving `active`
              index is only visible to a screen reader if the list says it is a
              listbox and the input says which option is current. */}
          <div className="model-list" id="model-list" role="listbox" aria-label="Models">
            {flatRows.length === 0 && (
              <div className="model-empty">
                No models match “{query}”
                {/* The affordance is taught exactly when it is useful, not
                    announced up front. */}
                <span className="model-empty-hint">esc clears the search</span>
              </div>
            )}
            {groups.map((group) => (
              <div key={group.title} className="model-group" role="presentation">
                <div className="model-group-title">
                  {group.driver !== undefined ? (
                    <ProviderIcon driver={group.driver} size={11} />
                  ) : (
                    // Favorites wears its own mark, so the group reads in the
                    // same icon-then-name rhythm as the driver groups.
                    <span className="model-group-fav" aria-hidden="true">
                      ★
                    </span>
                  )}
                  {group.title}
                </div>
                {group.rows.map((row) => {
                  index += 1;
                  const i = index;
                  const isSelected =
                    row.driver === value.driver && row.modelId === value.modelId;
                  const isStarred =
                    row.modelId !== null &&
                    favorites.has(favKey(row.driver, row.modelId));
                  return (
                    <div
                      key={`${group.title}/${row.driver}/${row.modelId ?? ""}`}
                      id={rowId(i)}
                      role="option"
                      aria-selected={isSelected}
                      className={
                        "model-row" +
                        (i === active ? " model-row-active" : "") +
                        (isSelected ? " model-row-selected" : "")
                      }
                      // mousemove, not mouseenter: a keyboard-driven scroll
                      // slides rows under a stationary cursor, and enter
                      // events from that would steal the roving index back.
                      onMouseMove={() => {
                        if (i === active) return;
                        navSource.current = "mouse";
                        setActive(i);
                      }}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        select(row);
                      }}
                    >
                      <span className="model-row-label">{row.label}</span>
                      {row.description !== undefined && (
                        <span className="model-row-desc">{row.description}</span>
                      )}
                      {isSelected && <span className="model-row-check">✓</span>}
                      {row.modelId !== null && (
                        <button
                          type="button"
                          className={
                            "model-star" +
                            (isStarred ? " starred" : "") +
                            (isStarred &&
                            starPulse === favKey(row.driver, row.modelId)
                              ? " model-star-pop"
                              : "")
                          }
                          onAnimationEnd={() => setStarPulse(null)}
                          title={isStarred ? "unfavorite" : "favorite"}
                          aria-label={`${isStarred ? "Unfavorite" : "Favorite"} ${row.label}`}
                          aria-pressed={isStarred}
                          onMouseDown={(e) => {
                            if (e.button !== 0) return;
                            e.preventDefault();
                            e.stopPropagation();
                            toggleFavorite(row);
                          }}
                        >
                          {isStarred ? "★" : "☆"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>,
          document.body,
        )}
      {effortOpen &&
        createPortal(
          // Portaled for the same backdrop-root reason as the model popover.
          <div
            ref={effortPopRef}
            className="effort-pop glass-strong"
            role="listbox"
            aria-label="Reasoning effort"
            onKeyDown={onEffortPopKeyDown}
            style={
              effortAnchor === null
                ? { visibility: "hidden" }
                : { left: effortAnchor.left, bottom: effortAnchor.bottom }
            }
          >
            {levels.map((level) => (
              <button
                key={level ?? "default"}
                type="button"
                role="option"
                aria-selected={value.effort === level}
                // Focus enters programmatically (on the selected level) and
                // moves with arrows; the options are not tab stops.
                tabIndex={-1}
                className={
                  "effort-option" +
                  (value.effort === level ? " effort-option-selected" : "")
                }
                onClick={() => selectEffort(level)}
              >
                <span>{titleCase(level ?? "default")}</span>
                {value.effort === level && (
                  <span className="model-row-check">✓</span>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
