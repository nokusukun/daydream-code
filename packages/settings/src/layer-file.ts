import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Document, isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import type { WriteRequest } from "./index.js";

/**
 * Edit one row of a layer file in place.
 *
 * Goes through yaml's Document API rather than parse -> mutate -> stringify
 * because these files are hand-written as often as they are UI-written, and a
 * round trip through plain objects silently deletes every comment in them.
 * Someone who wrote `# codex needs an API key in the env` above a row should
 * still have that line after toggling a checkbox somewhere else.
 */
export function patchLayerFile(file: string, request: WriteRequest): void {
  const doc = readDocument(file);
  const seq = doc.contents as YAMLSeq;

  let row = seq.items.find(
    (item): item is YAMLMap =>
      isMap(item) && String(item.get("id") ?? "") === request.id,
  );

  if (row === undefined) {
    // Nothing to remove from a row that was never in this layer.
    if (request.set === undefined || Object.keys(request.set).length === 0) return;
    row = doc.createNode({ id: request.id }) as unknown as YAMLMap;
    seq.items.push(row);
  }

  for (const key of request.unset ?? []) row.delete(key);
  for (const [key, value] of Object.entries(request.set ?? {})) {
    if (value === undefined) continue;
    row.set(key, doc.createNode(value));
  }

  // A row carrying only its id says nothing; leaving it would make the layer
  // look like it has an opinion it does not have.
  if (row.items.filter((item) => String(item.key) !== "id").length === 0) {
    seq.items = seq.items.filter((item) => item !== row);
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, doc.toString({ lineWidth: 0 }), "utf8");
}

function readDocument(file: string): Document {
  if (!existsSync(file)) return emptyDocument();
  const doc = parseDocument(readFileSync(file, "utf8"));
  if (doc.contents === null) {
    // The file exists but holds only comments; keep them and add the list.
    const seeded = new Document([] as unknown[]);
    seeded.commentBefore = doc.commentBefore ?? null;
    return seeded;
  }
  if (!isSeq(doc.contents)) {
    throw new Error(`${file}: config must be a YAML list of entries`);
  }
  return doc;
}

function emptyDocument(): Document {
  const doc = new Document([] as unknown[]);
  doc.commentBefore =
    " daydream-code config. Rows patch the base bundle by id;\n" +
    " a row's `config` is replaced whole, never deep-merged.";
  return doc;
}
