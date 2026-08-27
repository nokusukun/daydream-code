import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/api.js";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(
  respond: (recorded: Recorded) => { status?: number; json?: unknown } = () => ({}),
): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const recorded: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(recorded);
    const { status = 200, json = {} } = respond(recorded);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function client(fetchImpl: typeof fetch, token?: string): ApiClient {
  return new ApiClient({
    baseUrl: "http://127.0.0.1:4870/",
    ...(token !== undefined ? { token } : {}),
    fetchImpl,
  });
}

describe("ApiClient", () => {
  it("strips trailing slashes and builds query params, skipping undefined", async () => {
    const { fetch: f, calls } = fakeFetch(() => ({ json: [] }));
    const api = client(f);
    await api.journal({ sessionId: "s_1", limit: 50 });
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:4870/api/journal?sessionId=s_1&limit=50",
    );
    await api.journal({ types: ["turn"], latest: true, limit: 200 });
    expect(calls[1]?.url).toBe(
      "http://127.0.0.1:4870/api/journal?latest=true&limit=200&types=turn",
    );
    await api.journal({ types: [] });
    expect(calls[2]?.url).toBe("http://127.0.0.1:4870/api/journal");
    await api.master();
    expect(calls[3]?.url).toBe("http://127.0.0.1:4870/api/master");
    await api.master(true);
    expect(calls[4]?.url).toBe("http://127.0.0.1:4870/api/master?all=true");
  });

  it("sends the bearer token on requests and the query token on the stream url", async () => {
    const { fetch: f, calls } = fakeFetch(() => ({ json: { ok: true } }));
    const api = client(f, "sekrit");
    await api.health();
    expect(calls[0]?.headers.authorization).toBe("Bearer sekrit");
    expect(api.streamUrl()).toBe("ws://127.0.0.1:4870/stream?token=sekrit");
  });

  it("omits the token when not configured", async () => {
    const { fetch: f, calls } = fakeFetch();
    const api = client(f);
    await api.health();
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(api.streamUrl()).toBe("ws://127.0.0.1:4870/stream");
  });

  it("POSTs JSON bodies for dispatch, messages, next messages and stop", async () => {
    const { fetch: f, calls } = fakeFetch(() => ({ json: { id: "s_1" } }));
    const api = client(f, "t");
    await api.dispatch({ task: "do things", driver: "mock" });
    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:4870/api/sessions",
      method: "POST",
      body: JSON.stringify({ task: "do things", driver: "mock" }),
    });
    expect(calls[0]?.headers["content-type"]).toBe("application/json");

    await api.message("s 1", "hi");
    expect(calls[1]?.url).toBe("http://127.0.0.1:4870/api/sessions/s%201/message");
    expect(calls[1]?.body).toBe(JSON.stringify({ message: "hi" }));

    await api.enqueueNextMessage("s 1", "after this run");
    expect(calls[2]?.url).toBe(
      "http://127.0.0.1:4870/api/sessions/s%201/next-messages",
    );
    expect(calls[2]?.method).toBe("POST");
    expect(calls[2]?.body).toBe(JSON.stringify({ message: "after this run" }));

    await api.beginNextMessageEdit("s 1", "msg/1");
    expect(calls[3]).toMatchObject({
      url: "http://127.0.0.1:4870/api/sessions/s%201/next-messages/msg%2F1/edit",
      method: "POST",
    });

    await api.updateNextMessage("s 1", "msg/1", "edited");
    expect(calls[4]).toMatchObject({
      url: "http://127.0.0.1:4870/api/sessions/s%201/next-messages/msg%2F1",
      method: "PUT",
      body: JSON.stringify({ message: "edited" }),
    });

    await api.cancelNextMessageEdit("s 1", "msg/1");
    expect(calls[5]).toMatchObject({
      url: "http://127.0.0.1:4870/api/sessions/s%201/next-messages/msg%2F1/edit/cancel",
      method: "POST",
    });

    await api.cancelNextMessage("s 1", "msg/1");
    expect(calls[6]).toMatchObject({
      url: "http://127.0.0.1:4870/api/sessions/s%201/next-messages/msg%2F1",
      method: "DELETE",
    });

    await api.stop("s_1");
    expect(calls[7]).toMatchObject({
      url: "http://127.0.0.1:4870/api/sessions/s_1/stop",
      method: "POST",
    });
  });

  it("encodes search queries", async () => {
    const { fetch: f, calls } = fakeFetch(() => ({ json: [] }));
    await client(f).search("hello world&x=1", { limit: 10 });
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:4870/api/journal/search?q=hello%20world%26x%3D1&limit=10",
    );
  });

  it("throws with the server's error message on non-ok responses", async () => {
    const { fetch: f } = fakeFetch(() => ({
      status: 404,
      json: { error: "unknown session: s_x" },
    }));
    await expect(client(f).session("s_x")).rejects.toThrow(
      "/api/sessions/s_x failed (404): unknown session: s_x",
    );
  });

  it("still throws usefully when the error body is not JSON-shaped", async () => {
    const impl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await expect(client(impl).health()).rejects.toThrow("/health failed (500)");
  });
});
