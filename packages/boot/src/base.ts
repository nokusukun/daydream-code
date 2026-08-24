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
      // The route registry and its consumers stay enabled even though no
      // transport is: registering a route costs nothing, and it means turning
      // the server on is a one-row edit rather than one per surface.
      { id: "routes", name: "@daydream-code/routes/registry" },
      { id: "meta-routes", name: "@daydream-code/routes/meta" },
      { id: "store", name: "@daydream-code/store/sqlite", config: { rootPath: projectRoot } },
      { id: "store-routes", name: "@daydream-code/store/routes" },
      // Reads the composition it is itself part of, so it can only sit after
      // the store it takes the project root from.
      { id: "settings", name: "@daydream-code/settings/live" },
      { id: "settings-routes", name: "@daydream-code/settings/routes" },
      { id: "blobs", name: "@daydream-code/blobs/fs" },
      { id: "blob-routes", name: "@daydream-code/blobs/routes" },
      // Read-only view of the working tree. The UI's Code mode and every
      // "what did this run change" surface reads through here; nothing in the
      // harness writes through it, so it is safe to mount unconditionally.
      { id: "workspace", name: "@daydream-code/workspace/git" },
      { id: "workspace-routes", name: "@daydream-code/workspace/routes" },
      { id: "tokens", name: "@daydream-code/tokens/estimate" },
      { id: "normalizer", name: "@daydream-code/normalize/service" },
      { id: "normalize-durable", name: "@daydream-code/normalize/durable" },
      { id: "journal", name: "@daydream-code/journal/sqlite" },
      { id: "journal-routes", name: "@daydream-code/journal/routes" },
      { id: "threads", name: "@daydream-code/thread/sqlite" },
      { id: "thread-routes", name: "@daydream-code/thread/routes" },
      { id: "master-writeback", name: "@daydream-code/thread/master-writeback" },
      { id: "master-inject", name: "@daydream-code/thread/master-inject" },
      { id: "compaction", name: "@daydream-code/compaction/two-tier" },
      { id: "summarizer", name: "@daydream-code/summarize/mechanical" },
      { id: "questions", name: "@daydream-code/questions/registry" },
      { id: "question-routes", name: "@daydream-code/questions/routes" },
      { id: "asks", name: "@daydream-code/asks/registry" },
      { id: "tools", name: "@daydream-code/tools/registry" },
      { id: "recall-tools", name: "@daydream-code/tools/recall" },
      { id: "ask-tools", name: "@daydream-code/tools/ask" },
      { id: "ask-session-tools", name: "@daydream-code/tools/ask-session" },
      { id: "drivers", name: "@daydream-code/driver/registry" },
      { id: "driver-routes", name: "@daydream-code/driver/routes" },
      { id: "driver-claude", name: "@daydream-code/driver/claude" },
      { id: "driver-codex", name: "@daydream-code/driver/codex", disabled: true },
      { id: "driver-mock", name: "@daydream-code/driver/mock", disabled: true },
      { id: "sessions", name: "@daydream-code/session/runner" },
      { id: "session-routes", name: "@daydream-code/session/routes" },
      { id: "send-tools", name: "@daydream-code/session/send-tool" },
      { id: "server", name: "@daydream-code/server/fastify", disabled: true },
    ],
  };
}
