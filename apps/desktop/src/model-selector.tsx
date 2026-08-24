/**
 * t3-style model picker: one control selecting (driver, model) for a dispatch.
 * A searchable popover lists every driver's catalog (from `GET /api/models`)
 * grouped per driver, with starred favorites pinned on top. Favorites and the
 * last choice persist in localStorage.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { DriverCatalogEntry } from "./api.js";
import { useHarness } from "./harness.js";
import { ProviderIcon } from "./provider-icon.js";

export interface ModelChoice {
  driver: string;
  /** null = the driver's own default model. */
  modelId: string | null;
}

const CHOICE_KEY = "daydream.model-choice";
const FAVORITES_KEY = "daydream.model-favorites";

const DEFAULT_CHOICE: ModelChoice = { driver: "claude", modelId: null };

/** Popover width, mirrored from `.model-pop`, and the viewport gutter it keeps. */
const POP_WIDTH = 320;
const EDGE = 8;

/** Shown before the catalog loads or when the endpoint is unreachable. */
const FALLBACK_CATALOG: DriverCatalogEntry[] = [
  { driver: "claude", models: [] },
  { driver: "codex", models: [] },
  { driver: "mock", models: [] },
];

function isModelChoice(value: unknown): value is ModelChoice {
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
  return isModelChoice(parsed) ? parsed : DEFAULT_CHOICE;
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
        label: "default",
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
}): ReactNode {
  const { value, onChange } = props;
  const { api, modelLabel } = useHarness();
  const [catalog, setCatalog] = useState<DriverCatalogEntry[]>(FALLBACK_CATALOG);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(loadFavorites);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** Viewport coordinates for the portaled popover, measured off the trigger. */
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);

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

  const groups = useMemo(
    () => buildGroups(catalog, favorites, query.trim()),
    [catalog, favorites, query],
  );
  const flatRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  useEffect(() => setActive(0), [query, open]);

  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    searchRef.current?.focus();

    // The popover renders through a portal, so it is positioned against the
    // viewport rather than the trigger. `bottom` anchors it above the trigger,
    // which is where it has always opened.
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const width = popRef.current?.offsetWidth ?? POP_WIDTH;
      setAnchor({
        left: Math.max(EDGE, Math.min(rect.left, window.innerWidth - width - EDGE)),
        bottom: window.innerHeight - rect.top + 6,
      });
    };
    place();

    const onDown = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return;
      // The popover is no longer a descendant of the trigger, so "outside" has
      // to consider both.
      if (rootRef.current?.contains(event.target) === true) return;
      if (popRef.current?.contains(event.target) === true) return;
      setOpen(false);
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
  }, [open]);

  const select = useCallback(
    (row: Row) => {
      const choice: ModelChoice = { driver: row.driver, modelId: row.modelId };
      saveChoice(choice);
      onChange(choice);
      setOpen(false);
      setQuery("");
    },
    [onChange],
  );

  const toggleFavorite = useCallback((row: Row) => {
    if (row.modelId === null) return;
    const key = favKey(row.driver, row.modelId);
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveFavorites(next);
      return next;
    });
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (flatRows.length === 0) return;
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
    [flatRows, active, select],
  );

  const current = useMemo(
    () => modelLabel(value.driver, value.modelId),
    [modelLabel, value],
  );

  let index = -1;
  return (
    <div className="model-select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="model-trigger"
        disabled={props.disabled}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Driver and model for this dispatch"
      >
        <ProviderIcon driver={value.driver} />
        <span>{current.label}</span>
        <span className="model-caret" aria-hidden="true">
          {open ? "▾" : "▴"}
        </span>
      </button>
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
            onKeyDown={onKeyDown}
            style={
              anchor === null
                ? { visibility: "hidden" }
                : { left: anchor.left, bottom: anchor.bottom }
            }
          >
          <input
            ref={searchRef}
            type="text"
            className="model-search"
            placeholder="Search models"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="model-list">
            {flatRows.length === 0 && (
              <div className="model-empty">No models match “{query}”</div>
            )}
            {groups.map((group) => (
              <div key={group.title} className="model-group">
                <div className="model-group-title">
                  {group.driver !== undefined && (
                    <ProviderIcon driver={group.driver} size={11} />
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
                      className={
                        "model-row" +
                        (i === active ? " model-row-active" : "") +
                        (isSelected ? " model-row-selected" : "")
                      }
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => {
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
                          className={"model-star" + (isStarred ? " starred" : "")}
                          title={isStarred ? "unfavorite" : "favorite"}
                          onMouseDown={(e) => {
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
    </div>
  );
}
