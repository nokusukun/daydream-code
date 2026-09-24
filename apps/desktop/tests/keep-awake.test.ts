import { describe, expect, it } from "vitest";
import type { SessionRecord } from "@daydream-code/shared";
import type { ConnectionInfo } from "../src/bridge.js";
import type { ProjectActivity } from "../src/project-activity.js";
import {
  keepAwakeDesired,
  readKeepAwakePreference,
  writeKeepAwakePreference,
  type PreferenceStorage,
} from "../src/keep-awake.js";

function connection(name: string): ConnectionInfo {
  return {
    name,
    rootPath: `/projects/${name}`,
    url: `http://127.0.0.1/${name}`,
    token: `${name}-token`,
  };
}

function session(
  name: string,
  status: SessionRecord["status"],
  endedAt: string | null = null,
): SessionRecord {
  return {
    id: `ses_${name}` as SessionRecord["id"],
    projectId: "prj_test" as SessionRecord["projectId"],
    threadId: "thr_test" as SessionRecord["threadId"],
    name,
    title: name,
    task: name,
    driver: "mock",
    modelId: null,
    status,
    lastSeenMasterSeq: 0,
    startedAt: "2026-09-24T10:00:00.000Z",
    endedAt,
    summary: null,
    tldr: null,
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  };
}

function activity(
  project: string,
  run: SessionRecord,
): ProjectActivity {
  return { connection: connection(project), session: run };
}

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe("keep-awake preference", () => {
  it("defaults to off, including with no storage at all", () => {
    expect(readKeepAwakePreference(memoryStorage())).toBe(false);
    expect(readKeepAwakePreference(null)).toBe(false);
  });

  it("round-trips on and off", () => {
    const storage = memoryStorage();
    writeKeepAwakePreference(true, storage);
    expect(readKeepAwakePreference(storage)).toBe(true);
    writeKeepAwakePreference(false, storage);
    expect(readKeepAwakePreference(storage)).toBe(false);
  });

  it("treats an unrecognized stored value as off", () => {
    const storage = memoryStorage({ "daydream.keep-awake": "yes please" });
    expect(readKeepAwakePreference(storage)).toBe(false);
  });

  it("survives a storage that throws", () => {
    const hostile: PreferenceStorage = {
      getItem: () => {
        throw new Error("quota");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(readKeepAwakePreference(hostile)).toBe(false);
    expect(() => writeKeepAwakePreference(true, hostile)).not.toThrow();
  });
});

describe("keepAwakeDesired", () => {
  it("wants the screen held only when enabled and something is live", () => {
    const running = [activity("alpha", session("build", "running"))];
    expect(keepAwakeDesired(true, running)).toBe(true);
    expect(keepAwakeDesired(false, running)).toBe(false);
    expect(keepAwakeDesired(true, [])).toBe(false);
  });

  it("counts a waiting thread as live — a pending question is activity", () => {
    const waiting = [activity("alpha", session("ask", "waiting"))];
    expect(keepAwakeDesired(true, waiting)).toBe(true);
  });

  it("does not hold the screen for finished threads", () => {
    const done = [
      activity("alpha", session("old", "completed", "2026-09-24T11:00:00.000Z")),
      activity("beta", session("bad", "failed", "2026-09-24T11:00:00.000Z")),
    ];
    expect(keepAwakeDesired(true, done)).toBe(false);
  });

  it("sees liveness across projects, not just the current one", () => {
    const mixed = [
      activity("alpha", session("old", "completed", "2026-09-24T11:00:00.000Z")),
      activity("beta", session("busy", "running")),
    ];
    expect(keepAwakeDesired(true, mixed)).toBe(true);
  });
});
