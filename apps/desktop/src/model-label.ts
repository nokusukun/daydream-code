/**
 * Turning a model id into something worth reading.
 *
 * Drivers report *runtime* ids, not catalog ids: the Claude SDK says
 * `claude-opus-5[1m]`, where the bracket carries the context-window variant.
 * The strip should read "Claude Opus 5" with `1m` as a footnote, not dump the
 * raw id, so the id is split before the catalog is consulted.
 */
import type { DriverCatalogEntry } from "./api.js";

/** A model id split into what to read and what to footnote. */
export interface ModelLabel {
  label: string;
  /** Context-window or deployment variant, e.g. `1m`. */
  variant?: string;
}

/** `claude-opus-5[1m]` → `{ base: "claude-opus-5", variant: "1m" }`. */
export function splitModelId(modelId: string): {
  base: string;
  variant?: string;
} {
  const match = /^(.*?)\[([^\]]+)\]$/.exec(modelId);
  if (match === null) return { base: modelId };
  const base = match[1];
  const variant = match[2];
  if (base === undefined || base.length === 0 || variant === undefined) {
    return { base: modelId };
  }
  return { base, variant };
}

export function labelForModel(
  catalog: readonly DriverCatalogEntry[],
  driver: string,
  modelId: string | null,
): ModelLabel {
  const entry = catalog.find((e) => e.driver === driver);
  if (modelId === null) {
    // Name the model the driver will actually pick, when it advertises one.
    const fallback = entry?.models.find((m) => m.isDefault === true);
    return { label: fallback?.label ?? "Default model" };
  }
  // Provider catalogs may expose a friendly selectable alias (`opus[1m]`)
  // beside the canonical id reported by a completed run. Match either side
  // before stripping variants so both render with the provider's own label.
  const exact = entry?.models.find(
    (model) => model.id === modelId || model.resolvedId === modelId,
  );
  if (exact !== undefined) return { label: exact.label };
  const { base, variant } = splitModelId(modelId);
  const known = entry?.models.find((model) => {
    if (model.id === base) return true;
    return model.resolvedId !== undefined && splitModelId(model.resolvedId).base === base;
  })?.label;
  return {
    label: known ?? base,
    ...(variant !== undefined ? { variant } : {}),
  };
}
