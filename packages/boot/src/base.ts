import type { Layer } from "./entries.js";

/**
 * The base bundle: the default composition every boot starts from. User and
 * project layers patch these rows by id (whole-config replacement) or insert
 * their own.
 */
export function baseBundle(projectRoot: string): Layer {
  return {
    source: "bundle:base",
    baseDir: projectRoot,
    rows: [
      { id: "store", name: "@daydream-code/store/sqlite", config: { rootPath: projectRoot } },
      { id: "tokens", name: "@daydream-code/tokens/estimate" },
      { id: "normalizer", name: "@daydream-code/normalize/service" },
      { id: "normalize-durable", name: "@daydream-code/normalize/durable" },
      { id: "journal", name: "@daydream-code/journal/sqlite" },
      { id: "threads", name: "@daydream-code/thread/sqlite" },
      { id: "master-writeback", name: "@daydream-code/thread/master-writeback" },
      { id: "master-inject", name: "@daydream-code/thread/master-inject" },
      { id: "compaction", name: "@daydream-code/compaction/two-tier" },
      { id: "summarizer", name: "@daydream-code/summarize/mechanical" },
      { id: "tools", name: "@daydream-code/tools/registry" },
      { id: "recall-tools", name: "@daydream-code/tools/recall" },
      { id: "drivers", name: "@daydream-code/driver/registry" },
      { id: "driver-claude", name: "@daydream-code/driver/claude" },
      { id: "driver-codex", name: "@daydream-code/driver/codex", disabled: true },
      { id: "driver-mock", name: "@daydream-code/driver/mock", disabled: true },
      { id: "sessions", name: "@daydream-code/session/runner" },
      { id: "server", name: "@daydream-code/server/fastify", disabled: true },
    ],
  };
}
