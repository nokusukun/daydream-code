/**
 * Data layer for the settings window: one fetch of the whole surface, and
 * per-row writes that report their own outcome.
 *
 * Per-row rather than a form with a Save button. macOS settings apply on
 * commit, and here the harness can genuinely apply most of them live — a Save
 * button would invent a batch that the backend does not have and that the user
 * would then have to reason about.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, SettingsView, WriteResult } from "./api.js";
import type { ProjectConfig } from "@daydream-code/shared";
import type { ApplyOutcome, WritableLayer } from "@daydream-code/settings";

/** What happened to one row, kept until the next write touches it. */
export interface RowStatus {
  state: "saving" | "applied" | "restart" | "error";
  message?: string;
}

export interface SettingsStore {
  view: SettingsView | null;
  error: string | null;
  loading: boolean;
  /** Which layer edits are written to. */
  layer: WritableLayer;
  setLayer(layer: WritableLayer): void;
  /** Per-row feedback, keyed by entry id (or "project" for the project row). */
  status: Record<string, RowStatus | undefined>;
  /** Rows saved but not live, so the window can offer a relaunch. */
  pendingRestart: string[];
  /** Replace one field inside a row's config. */
  setField(id: string, field: string, value: unknown): Promise<void>;
  /** Remove a field, so the layer below (or the schema default) shows again. */
  clearField(id: string, field: string): Promise<void>;
  /** Enable or disable a whole row. */
  setDisabled(id: string, disabled: boolean): Promise<void>;
  /** Drop this layer's opinion about a row entirely. */
  resetRow(id: string): Promise<void>;
  /** Project-row settings, which are stored in the database rather than a layer. */
  setProject(patch: Partial<ProjectConfig>): Promise<void>;
  refresh(): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The row's effective config as a plain object, whatever the server sent. */
function configObject(config: unknown): Record<string, unknown> {
  return typeof config === "object" && config !== null && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {};
}

function statusFor(outcome: ApplyOutcome | undefined): RowStatus {
  if (outcome === undefined) return { state: "applied" };
  if (outcome.status === "restart-required") {
    return { state: "restart", ...(outcome.reason !== undefined ? { message: outcome.reason } : {}) };
  }
  if (outcome.status === "failed") {
    return { state: "error", ...(outcome.reason !== undefined ? { message: outcome.reason } : {}) };
  }
  return { state: "applied" };
}

export function useSettings(api: ApiClient): SettingsStore {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [layer, setLayer] = useState<WritableLayer>("project");
  const [status, setStatus] = useState<Record<string, RowStatus | undefined>>({});
  const [tick, setTick] = useState(0);
  // Writes land out of order if the user types quickly; only the newest reply
  // may set the view, or an early one would resurrect a stale value.
  const generation = useRef(0);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    api
      .settings()
      .then((next) => {
        if (stale) return;
        setView(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!stale) setError(messageOf(e));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [api, tick]);

  const commit = useCallback(
    async (id: string, run: () => Promise<WriteResult>): Promise<void> => {
      const mine = ++generation.current;
      setStatus((current) => ({ ...current, [id]: { state: "saving" } }));
      try {
        const result = await run();
        if (generation.current !== mine) return;
        setView(result.view);
        setError(null);
        setStatus((current) => ({
          ...current,
          [id]: statusFor(result.outcomes.find((outcome) => outcome.id === id)),
        }));
      } catch (e: unknown) {
        if (generation.current !== mine) return;
        setStatus((current) => ({
          ...current,
          [id]: { state: "error", message: messageOf(e) },
        }));
      }
    },
    [],
  );

  const writeConfig = useCallback(
    (id: string, mutate: (config: Record<string, unknown>) => Record<string, unknown>) => {
      const entry = view?.entries.find((candidate) => candidate.id === id);
      const next = mutate(configObject(entry?.config));
      // A row whose config is now empty says nothing; drop the key so the
      // layer below shows through rather than pinning an empty object.
      const set = Object.keys(next).length > 0 ? { config: next } : undefined;
      return commit(id, () =>
        api.writeSetting({
          layer,
          id,
          ...(set !== undefined ? { set } : { unset: ["config"] as const }),
        }),
      );
    },
    [api, commit, layer, view],
  );

  const setField = useCallback(
    (id: string, fieldName: string, value: unknown) =>
      writeConfig(id, (config) => ({ ...config, [fieldName]: value })),
    [writeConfig],
  );

  const clearField = useCallback(
    (id: string, fieldName: string) =>
      writeConfig(id, (config) => {
        const next = { ...config };
        delete next[fieldName];
        return next;
      }),
    [writeConfig],
  );

  const setDisabled = useCallback(
    (id: string, disabled: boolean) =>
      commit(id, () => api.writeSetting({ layer, id, set: { disabled } })),
    [api, commit, layer],
  );

  const resetRow = useCallback(
    (id: string) =>
      commit(id, () =>
        api.writeSetting({ layer, id, unset: ["config", "disabled", "isolate"] }),
      ),
    [api, commit, layer],
  );

  const setProject = useCallback(
    async (patch: Partial<ProjectConfig>): Promise<void> => {
      setStatus((current) => ({ ...current, project: { state: "saving" } }));
      try {
        const project = await api.patchProject(patch);
        setView((current) => (current === null ? current : { ...current, project }));
        setStatus((current) => ({ ...current, project: { state: "applied" } }));
      } catch (e: unknown) {
        setStatus((current) => ({
          ...current,
          project: { state: "error", message: messageOf(e) },
        }));
      }
    },
    [api],
  );

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  const pendingRestart = Object.entries(status)
    .filter(([, row]) => row?.state === "restart")
    .map(([id]) => id);

  return {
    view,
    error,
    loading,
    layer,
    setLayer,
    status,
    pendingRestart,
    setField,
    clearField,
    setDisabled,
    resetRow,
    setProject,
    refresh,
  };
}
