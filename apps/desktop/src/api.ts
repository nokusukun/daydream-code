/**
 * HTTP client for the harness server. Renderer-free on purpose: plain fetch
 * against a base URL + bearer token, so it unit-tests with a fake fetch and
 * could point at a remote core just as well as the local one.
 */
import type { QuickActionRecord } from "@daydream-code/actions";
import type { BlobRef } from "@daydream-code/blobs";
import type { AgentSkill } from "@daydream-code/driver";
import type { AttachmentInput, NextMessage } from "@daydream-code/session";
import type { EditableMessage } from "@daydream-code/session/transcript";
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

export type { QuickActionRecord } from "@daydream-code/actions";
export type { AgentSkill } from "@daydream-code/driver";
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
  /** Reasoning-effort level in the driver's vocabulary; omit for default. */
  effort?: string;
  fastMode?: boolean;
  name?: string;
  attachments?: AttachmentInput[];
}

/**
 * A mid-thread agent switch: absent keeps the current value, null clears
 * model or effort back to the driver's own default.
 */
export interface ModelChangeInput {
  driver?: string;
  modelId?: string | null;
  effort?: string | null;
  fastMode?: boolean;
}

/** Spin a thread's work off to a new thread, optionally under a new agent. */
export interface HandoffInput {
  mode: "transcript" | "summary";
  task?: string;
  driver?: string;
  modelId?: string;
  effort?: string;
  fastMode?: boolean;
}

/** A stored blob plus its bytes, which is the only way JSON can carry them. */
export interface BlobContent extends BlobRef {
  /** Raw base64, no data-URL prefix. */
  data: string;
}

export interface DriverModel {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  /** Effort levels this model accepts, in display order; absent = default only. */
  efforts?: string[];
}

export interface DriverCatalogEntry {
  driver: string;
  models: DriverModel[];
  supportsFastMode: boolean;
}

export interface JournalQuery {
  sessionId?: string;
  afterId?: number;
  /** Event types to keep; empty or absent means every type. */
  types?: string[];
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
  nextMessages: NextMessage[];
  editableMessage: EditableMessage | null;
}

export interface ApiClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

/**
 * A non-2xx response, carrying the status so a caller can tell "gone" from
 * "could not reach it". A draft holding an attachment that has been deleted
 * has to retire the chip; a dropped connection must leave it alone.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * The server's own sentence, without the request path in front of it.
     * `message` is for a log, where knowing which call failed is the point;
     * this is for a person, who is looking at the thing that failed already.
     */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
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
      let detail: string | undefined;
      try {
        const body = (await response.json()) as { error?: string };
        if (typeof body.error === "string") detail = body.error;
      } catch {
        // non-JSON error body; status alone will do
      }
      throw new ApiError(
        response.status,
        `${path} failed (${response.status})${detail !== undefined ? `: ${detail}` : ""}`,
        detail,
      );
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

  skills(driver: string): Promise<AgentSkill[]> {
    return this.#request("/api/skills", { driver });
  }

  session(id: string, limit = 500): Promise<SessionDetail> {
    return this.#request(`/api/sessions/${encodeURIComponent(id)}`, { limit });
  }

  dispatch(input: DispatchInput): Promise<SessionRecord> {
    return this.#post("/api/sessions", input);
  }

  setModel(id: string, change: ModelChangeInput): Promise<SessionRecord> {
    return this.#post(`/api/sessions/${encodeURIComponent(id)}/model`, change);
  }

  undoModelChange(id: string): Promise<SessionRecord> {
    return this.#post(`/api/sessions/${encodeURIComponent(id)}/model/undo`, {});
  }

  handoff(id: string, input: HandoffInput): Promise<SessionRecord> {
    return this.#post(`/api/sessions/${encodeURIComponent(id)}/handoff`, input);
  }

  message(
    id: string,
    message: string,
    attachments?: AttachmentInput[],
  ): Promise<SessionRecord> {
    return this.#post(`/api/sessions/${encodeURIComponent(id)}/message`, {
      message,
      ...(attachments !== undefined && attachments.length > 0
        ? { attachments }
        : {}),
    });
  }

  checkpoint(
    id: string,
    fromEventId: number,
    message: string,
    attachments?: AttachmentInput[],
  ): Promise<SessionRecord> {
    return this.#post(`/api/sessions/${encodeURIComponent(id)}/checkpoint`, {
      fromEventId,
      message,
      ...(attachments !== undefined && attachments.length > 0
        ? { attachments }
        : {}),
    });
  }

  enqueueNextMessage(
    id: string,
    message: string,
    attachments?: AttachmentInput[],
  ): Promise<NextMessage> {
    return this.#post(`/api/sessions/${encodeURIComponent(id)}/next-messages`, {
      message,
      ...(attachments !== undefined && attachments.length > 0
        ? { attachments }
        : {}),
    });
  }

  beginNextMessageEdit(id: string, deliveryId: string): Promise<NextMessage> {
    return this.#post(
      `/api/sessions/${encodeURIComponent(id)}/next-messages/${encodeURIComponent(deliveryId)}/edit`,
      {},
    );
  }

  updateNextMessage(
    id: string,
    deliveryId: string,
    message: string,
    attachments?: AttachmentInput[],
  ): Promise<NextMessage> {
    return this.#request(
      `/api/sessions/${encodeURIComponent(id)}/next-messages/${encodeURIComponent(deliveryId)}`,
      undefined,
      {
        method: "PUT",
        body: JSON.stringify({
          message,
          ...(attachments !== undefined && attachments.length > 0
            ? { attachments }
            : {}),
        }),
      },
    );
  }

  cancelNextMessageEdit(id: string, deliveryId: string): Promise<NextMessage> {
    return this.#post(
      `/api/sessions/${encodeURIComponent(id)}/next-messages/${encodeURIComponent(deliveryId)}/edit/cancel`,
      {},
    );
  }

  cancelNextMessage(
    id: string,
    deliveryId: string,
  ): Promise<{ cancelled: boolean }> {
    return this.#request(
      `/api/sessions/${encodeURIComponent(id)}/next-messages/${encodeURIComponent(deliveryId)}`,
      undefined,
      { method: "DELETE" },
    );
  }

  /**
   * Store an image and get back a reference to it. Composers call this when a
   * file is pasted or dropped rather than when the message is sent, so the
   * bytes cross the wire once no matter how the draft is edited afterwards.
   */
  uploadBlob(data: string, alt?: string): Promise<BlobRef> {
    return this.#post("/api/blobs", {
      data,
      ...(alt !== undefined ? { alt } : {}),
    });
  }

  /** Bytes for a stored blob. Rejects with a 404 once it is gone. */
  blob(id: string): Promise<BlobContent> {
    return this.#request(`/api/blobs/${encodeURIComponent(id)}`);
  }

  stop(id: string): Promise<{ stopped: boolean }> {
    return this.#post(`/api/sessions/${encodeURIComponent(id)}/stop`, {});
  }

  /**
   * Shelve a finished run, or put it back. Rejects with a 409 while the run is
   * live — the rail refuses to hide work that is still going.
   */
  archive(id: string, archived: boolean): Promise<SessionRecord> {
    return this.#post(`/api/sessions/${encodeURIComponent(id)}/archive`, {
      archived,
    });
  }

  /**
   * Erase a run and its journal. Returns the record as it last was, so a
   * caller can name what it just destroyed. 409 while the run is live.
   */
  remove(id: string): Promise<SessionRecord> {
    return this.#request(`/api/sessions/${encodeURIComponent(id)}`, undefined, {
      method: "DELETE",
    });
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
    const { types, ...rest } = query;
    return this.#request("/api/journal", {
      ...rest,
      ...(types !== undefined && types.length > 0 ? { types: types.join(",") } : {}),
    });
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

  /**
   * The project's saved quick actions, oldest first. Read rather than
   * subscribed: a session can add one at any time, so the toolbar asks when it
   * opens instead of trusting a copy it fetched at launch.
   */
  actions(): Promise<QuickActionRecord[]> {
    return this.#request("/api/actions");
  }

  addAction(input: { command: string; label?: string }): Promise<QuickActionRecord> {
    return this.#post("/api/actions", input);
  }

  updateAction(
    id: string,
    patch: { command?: string; label?: string },
  ): Promise<QuickActionRecord> {
    return this.#request(`/api/actions/${encodeURIComponent(id)}`, undefined, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  removeAction(id: string): Promise<{ ok: true }> {
    return this.#request(`/api/actions/${encodeURIComponent(id)}`, undefined, {
      method: "DELETE",
    });
  }

  /** Project-row settings; these live in the database, not in a config layer. */
  patchProject(patch: Partial<ProjectConfig>): Promise<ProjectRecord> {
    return this.#request("/api/project", undefined, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }
}
