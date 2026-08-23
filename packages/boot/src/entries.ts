/**
 * Config is a flat list of entries; layers apply as patches over an empty
 * list. A patch targeting an existing id replaces the row's whole `config`
 * (no deep-merge — a row's value lives in exactly one layer plus the user's).
 */

export interface EntryOptions {
  /** Stable identity; the loader diffs by id. Entries without one remount on every edit. */
  id: string;
  /** Module specifier: npm package (subpaths allowed) or path relative to the layer file. */
  name?: string;
  config?: unknown;
  disabled?: boolean;
  /** Service names to isolate for this entry's subtree. */
  isolate?: string[];
}

export interface PatchRow {
  id?: string;
  name?: string;
  config?: unknown;
  disabled?: boolean;
  isolate?: string[];
  insert?: EntryOptions[];
}

export interface Layer {
  /** Where this layer came from, for --dump-config annotations. */
  source: string;
  /** Directory relative module specifiers resolve against. */
  baseDir: string;
  rows: PatchRow[];
}

export interface ComposedEntry extends EntryOptions {
  /** Layer sources that touched this row, in application order. */
  layers: string[];
  /** baseDir of the layer that set `name` (for relative resolution). */
  baseDir: string;
}

export interface ComposeWarning {
  source: string;
  message: string;
}

export function composeEntries(layers: Layer[]): {
  entries: ComposedEntry[];
  warnings: ComposeWarning[];
} {
  const entries: ComposedEntry[] = [];
  const warnings: ComposeWarning[] = [];
  const byId = new Map<string, ComposedEntry>();

  const insert = (row: EntryOptions, layer: Layer) => {
    if (!row.id) {
      warnings.push({
        source: layer.source,
        message: `entry with name "${row.name}" has no id; it will remount on every config edit`,
      });
    }
    const entry: ComposedEntry = {
      ...row,
      id: row.id || `anon-${entries.length}-${row.name ?? "unnamed"}`,
      layers: [layer.source],
      baseDir: layer.baseDir,
    };
    if (row.id && byId.has(row.id)) {
      warnings.push({
        source: layer.source,
        message: `duplicate entry id "${row.id}"; later insert wins`,
      });
      const index = entries.indexOf(byId.get(row.id)!);
      entries.splice(index, 1);
    }
    entries.push(entry);
    if (row.id) byId.set(row.id, entry);
  };

  for (const layer of layers) {
    for (const row of layer.rows) {
      if (row.insert) {
        for (const inserted of row.insert) insert(inserted, layer);
        continue;
      }
      const target = row.id ? byId.get(row.id) : undefined;
      if (target) {
        // Patch: replace whole fields, never deep-merge config.
        if (row.name !== undefined) {
          target.name = row.name;
          target.baseDir = layer.baseDir;
        }
        if (row.config !== undefined) target.config = row.config;
        if (row.disabled !== undefined) target.disabled = row.disabled;
        if (row.isolate !== undefined) target.isolate = row.isolate;
        target.layers.push(layer.source);
      } else if (row.name !== undefined || row.id === undefined) {
        insert(row as EntryOptions, layer);
      } else {
        warnings.push({
          source: layer.source,
          message: `patch targets unknown id "${row.id}" and has no name; ignored`,
        });
      }
    }
  }
  return { entries, warnings };
}

export function renderConfigDump(
  entries: ComposedEntry[],
  warnings: ComposeWarning[],
): string {
  const lines: string[] = [];
  for (const warning of warnings) {
    lines.push(`# WARNING (${warning.source}): ${warning.message}`);
  }
  let lastLayers = "";
  for (const entry of entries) {
    const layerNote = entry.layers.join(" -> ");
    if (layerNote !== lastLayers) {
      lines.push(`# == ${layerNote}`);
      lastLayers = layerNote;
    }
    lines.push(`- id: ${entry.id}`);
    if (entry.name) lines.push(`  name: ${JSON.stringify(entry.name)}`);
    if (entry.disabled) lines.push(`  disabled: true`);
    if (entry.isolate?.length) {
      lines.push(`  isolate: [${entry.isolate.join(", ")}]`);
    }
    if (entry.config !== undefined) {
      lines.push(
        `  config: ${JSON.stringify(entry.config, null, 2).split("\n").join("\n  ")}`,
      );
    }
  }
  return lines.join("\n");
}
