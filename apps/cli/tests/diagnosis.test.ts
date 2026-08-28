import { describe, expect, it } from "vitest";
import type { FiberDump } from "@daydream-code/kernel";
import { bootDiagnosis } from "../src/bin.js";

const fiber = (over: Partial<FiberDump>): FiberDump => ({
  uid: 1,
  name: "plugin",
  state: "active",
  inject: [],
  missing: [],
  effects: [],
  ...over,
});

const ABI_ERROR =
  "Error: The module '/x/better_sqlite3.node'\nwas compiled against a different " +
  "Node.js version using\nNODE_MODULE_VERSION 139.";

describe("bootDiagnosis", () => {
  it("stays silent on a healthy boot", () => {
    expect(bootDiagnosis([fiber({}), fiber({ name: "b" })])).toBeNull();
  });

  it("does not refuse to run over a merely pending optional plugin", () => {
    // A disabled optional row leaves its dependents pending forever, and that
    // is a healthy tree. Only a fiber that threw is fatal.
    const dump = [fiber({ name: "opt", state: "pending", missing: ["actions"] })];
    expect(bootDiagnosis(dump)).toBeNull();
  });

  it("names the fiber that threw and counts the cascade rather than listing it", () => {
    const dump = [
      fiber({ name: "SqliteStore", state: "failed", error: ABI_ERROR }),
      fiber({ name: "SessionRunner", state: "pending", missing: ["store"] }),
      fiber({ name: "recall-tools", state: "pending", missing: ["store"] }),
    ];
    const out = bootDiagnosis(dump);
    expect(out).toContain("SqliteStore failed");
    expect(out).toContain("2 more plugin(s) never loaded");
    // The cascade is derivative; enumerating it buries the cause.
    expect(out).not.toContain("SessionRunner needs");
    expect(out).toContain("daydream-code fiber-state");
  });

  it("gives the native-ABI mismatch its own remedy", () => {
    const out = bootDiagnosis([
      fiber({ name: "SqliteStore", state: "failed", error: ABI_ERROR }),
    ]);
    expect(out).toContain("pnpm -C apps/desktop rebuild:node");
  });

  it("does not offer the sqlite remedy for an unrelated failure", () => {
    const out = bootDiagnosis([
      fiber({ name: "server", state: "failed", error: "Error: EADDRINUSE" }),
    ]);
    expect(out).toContain("server failed");
    expect(out).not.toContain("rebuild:node");
  });
});
