/**
 * HTTP client for the harness server. Renderer-free on purpose: plain fetch
 * against a base URL + bearer token, so it unit-tests with a fake fetch and
 * could point at a remote core just as well as the local one.
 */
import type {
  JournalEvent,
  ProjectRecord,
  SessionRecord,
  ThreadEntry,
} from "@daydream-code/shared";

export interface DispatchInput {
  task: string;
  driver?: string;
  modelId?: string;
  title?: string;
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
}
