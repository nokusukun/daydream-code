/**
 * HTTP client for the harness server. Renderer-free on purpose: plain fetch
 * against a base URL + bearer token, so it unit-tests with a fake fetch and
 * could point at a remote core just as well as the local one.
 */
import type { SettingsView, WriteRequest, WriteResult } from "@daydream-code/settings";
import type {
  FileContent,
  FileDiff,
  TreeEntry,
  WorkspaceStatus,
} from "@daydream-code/workspace";
import type {
  JournalEvent,
  ProjectConfig,
  ProjectRecord,
  SessionRecord,
  ThreadEntry,
} from "@daydream-code/shared";

export type { SettingsView, EntryView, SettingDescriptor, WriteResult } from "@daydream-code/settings";
export type {
  ChangedFile,
  DiffLine,
  FileDiff,
  FileStatus,
  TreeEntry,
  WorkspaceStatus,
} from "@daydream-code/workspace";

/**
 * A file plus what git says changed in it. One response because the editor
 * cannot draw a single line without both, and two round trips would let it
 * paint the file and then reflow it as the marks arrived.
 */
export interface OpenFile extends FileContent {
  diff: FileDiff;
}

export interface DispatchInput {
  task: string;
  driver?: string;
  modelId?: string;
  name?: string;
}

export interface DriverModel {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export interface DriverCatalogEntry {
  driver: string;
  models: DriverModel[];
}

export interface JournalQuery {
  sessionId?: string;
  afterId?: number;
  limit?: number;
  latest?: boolean;
}

export interface SearchHit {
  eventId: number;
  sessionId: string;
  ts: string;
  type: string;
  snippet: string;
}

export interface FiberDump {
  uid: number;
  name: string;
  state: string;
  inject: readonly string[];
  missing: string[];
  error?: string;
  effects: Array<string | undefined>;
}

export interface SessionDetail {
  session: SessionRecord;
  journal: JournalEvent[];
}

export interface ApiClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

type Params = Record<string, string | number | boolean | undefined>;

export class ApiClient {
  readonly baseUrl: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    const impl = options.fetchImpl;
    this.#fetch =
      impl !== undefined
        ? impl
        : (input, init) => fetch(input, init);
  }

  /** ws(s):// URL of the event stream, token carried as a query param. */
  streamUrl(): string {
    const ws = this.baseUrl.replace(/^http/, "ws");
    const token = this.#token;
    return token !== undefined
      ? `${ws}/stream?token=${encodeURIComponent(token)}`
      : `${ws}/stream`;
  }

  #url(path: string, params?: Params): string {
    const query = Object.entries(params ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&");
    return `${this.baseUrl}${path}${query.length > 0 ? `?${query}` : ""}`;
  }

  async #request<T>(path: string, params?: Params, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(this.#token !== undefined ? { authorization: `Bearer ${this.#token}` } : {}),
    };
    const response = await this.#fetch(this.#url(path, params), { ...init, headers });
    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as { error?: string };
        if (typeof body.error === "string") detail = `: ${body.error}`;
      } catch {
        // non-JSON error body; status alone will do
      }
      throw new Error(`${path} failed (${response.status})${detail}`);
    }
    return (await response.json()) as T;
  }

  #post<T>(path: string, body: unknown): Promise<T> {
    return this.#request<T>(path, undefined, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  health(): Promise<{ ok: boolean }> {
    return this.#request("/health");
  }

  project(): Promise<ProjectRecord> {
    return this.#request("/api/project");
  }

  sessions(): Promise<SessionRecord[]> {
    return this.#request("/api/sessions");
  }

  models(): Promise<DriverCatalogEntry[]> {
    return this.#request("/api/models");
  }

  session(id: string, limit = 500): Promise<SessionDetail> {
    return this.#request(`/api/sessions/${encodeURIComponent(id)}`, { limit });
  }

  dispatch(input: DispatchInput): Promise<SessionRecord> {
    return this.#post("/api/sessions", input);
  }

  message(id: string, message: string): Promise<SessionRecord> {
    return this.#post(`/api/sessions/${encodeURIComponent(id)}/message`, { message });
  }

  stop(id: string): Promise<{ stopped: boolean }> {
    return this.#post(`/api/sessions/${encodeURIComponent(id)}/stop`, {});
  }

  /**
   * Settle a blocking question. `answers` maps question id (the question text)
   * to the chosen label; `decline` hands the decision back to the model.
   * Rejects with a 409 when the request is already gone — the shape a late
   * answer takes after the harness process restarted.
   */
  answer(
    id: string,
    body: { requestId?: string; answers?: Record<string, string | string[]>; decline?: boolean },
  ): Promise<{ settled: boolean }> {
    return this.#post(`/api/sessions/${encodeURIComponent(id)}/answer`, body);
  }

  journal(query: JournalQuery = {}): Promise<JournalEvent[]> {
    return this.#request("/api/journal", { ...query });
  }

  search(q: string, options: { sessionId?: string; limit?: number } = {}): Promise<SearchHit[]> {
    return this.#request("/api/journal/search", { q, ...options });
  }

  master(all = false): Promise<ThreadEntry[]> {
    return this.#request("/api/master", all ? { all: true } : {});
  }

  fibers(): Promise<FiberDump[]> {
    return this.#request("/api/fibers");
  }

  /** Branch and the working tree's changed files, with per-file line counts. */
  workspace(): Promise<WorkspaceStatus> {
    return this.#request("/api/workspace");
  }

  /** One directory's children; "" is the project root. */
  tree(path = ""): Promise<TreeEntry[]> {
    return this.#request("/api/workspace/tree", { path });
  }

  file(path: string): Promise<OpenFile> {
    return this.#request("/api/workspace/file", { path });
  }

  /** The whole configurable surface: project row, plugin rows, provenance. */
  settings(): Promise<SettingsView> {
    return this.#request("/api/settings");
  }

  /** Write one row into one layer and, unless told otherwise, apply it live. */
  writeSetting(request: WriteRequest): Promise<WriteResult> {
    return this.#post("/api/settings", request);
  }

  /** Reconcile what is mounted against the layer files, without writing. */
  applySettings(): Promise<WriteResult> {
    return this.#post("/api/settings/apply", {});
  }

  /** Project-row settings; these live in the database, not in a config layer. */
  patchProject(patch: Partial<ProjectConfig>): Promise<ProjectRecord> {
    return this.#request("/api/project", undefined, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }
}
