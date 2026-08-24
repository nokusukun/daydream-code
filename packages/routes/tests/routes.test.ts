import { describe, expect, it } from "vitest";
import { App, type Context } from "@daydream-code/kernel";
import { HttpError, HttpRoutes, intParam, type RouteDefinition } from "../src/index.js";

function makeApp() {
  const app = new App();
  const errors: unknown[] = [];
  app.onError = (error) => errors.push(error);
  return { app, ctx: app.rootCtx as Context, errors };
}

async function withRegistry() {
  const { app, ctx, errors } = makeApp();
  ctx.plugin(HttpRoutes);
  await app.settle();
  return { app, ctx, errors, routes: ctx.get<HttpRoutes>("routes")! };
}

const ok = (path: string, method: RouteDefinition["method"] = "GET"): RouteDefinition => ({
  method,
  path,
  handle: () => ({ path }),
});

describe("HttpRoutes", () => {
  it("provides itself as ctx.routes and matches a static path", async () => {
    const { ctx, routes } = await withRegistry();
    expect(ctx.routes).toBe(routes);
    routes.register(ctx, ok("/api/models"));
    const match = routes.match("GET", "/api/models");
    expect(match?.route.path).toBe("/api/models");
    expect(match?.params).toEqual({});
    expect(routes.match("POST", "/api/models")).toBeUndefined();
    expect(routes.match("GET", "/api/nope")).toBeUndefined();
  });

  it("captures :params and url-decodes them", async () => {
    const { ctx, routes } = await withRegistry();
    routes.register(ctx, ok("/api/sessions/:id/message", "POST"));
    const match = routes.match("POST", "/api/sessions/fix%20tests/message");
    expect(match?.params).toEqual({ id: "fix tests" });
    // A param matches exactly one segment.
    expect(routes.match("POST", "/api/sessions/a/b/message")).toBeUndefined();
  });

  it("prefers the pattern with more literal segments", async () => {
    const { ctx, routes } = await withRegistry();
    routes.register(ctx, ok("/api/journal/:id"));
    routes.register(ctx, ok("/api/journal/search"));
    expect(routes.match("GET", "/api/journal/search")?.route.path).toBe(
      "/api/journal/search",
    );
    expect(routes.match("GET", "/api/journal/12")?.route.path).toBe("/api/journal/:id");
  });

  it("rejects two routes that would match the same requests", async () => {
    const { ctx, routes } = await withRegistry();
    routes.register(ctx, ok("/api/sessions/:id"));
    // Same shape, different spelling of the param — still the same route.
    expect(() => routes.register(ctx, ok("/api/sessions/:name"))).toThrow(
      /already registered/,
    );
    // Same path on a different method is a different route.
    expect(() => routes.register(ctx, ok("/api/sessions/:id", "POST"))).not.toThrow();
  });

  it("resolves HEAD against GET, and ignores trailing slashes", async () => {
    const { ctx, routes } = await withRegistry();
    routes.register(ctx, ok("/health"));
    expect(routes.match("HEAD", "/health")?.route.path).toBe("/health");
    expect(routes.match("head", "/health/")?.route.path).toBe("/health");
    expect(routes.match("get", "/health")?.route.path).toBe("/health");
  });

  it("refuses an unnamed parameter", async () => {
    const { ctx, routes } = await withRegistry();
    expect(() => routes.register(ctx, ok("/api/sessions/:"))).toThrow(/unnamed/);
  });

  it("unregisters routes when the owning plugin unloads", async () => {
    const { app, ctx, routes } = await withRegistry();
    const fiber = ctx.plugin({
      name: "some-routes",
      inject: ["routes"],
      apply(own: Context) {
        own.routes.registerAll(own, [ok("/api/a"), ok("/api/b")]);
      },
    });
    await app.settle();
    expect(routes.list().map((r) => r.path).sort()).toEqual(["/api/a", "/api/b"]);

    await app.dispose(fiber);
    expect(routes.list()).toEqual([]);
    expect(routes.match("GET", "/api/a")).toBeUndefined();

    // The shape is free again, so the same plugin can remount.
    ctx.plugin({
      name: "some-routes",
      inject: ["routes"],
      apply: (own: Context) => void own.routes.register(own, ok("/api/a")),
    });
    await app.settle();
    expect(routes.list().map((r) => r.path)).toEqual(["/api/a"]);
  });

  it("keeps a route registered against a dependent plugin out of the registry's lifetime", async () => {
    // Registering against the registry's own ctx would outlive the caller;
    // `register(owner, …)` is what makes the two lifetimes distinct.
    const { app, ctx, routes } = await withRegistry();
    let ownerCtx!: Context;
    const fiber = ctx.plugin({
      name: "owner",
      inject: ["routes"],
      apply(own: Context) {
        ownerCtx = own;
        own.routes.register(own, ok("/api/owned"));
      },
    });
    await app.settle();
    expect(ownerCtx.fiber).toBe(fiber);
    expect(routes.match("GET", "/api/owned")).toBeDefined();
    await app.dispose(fiber);
    expect(routes.match("GET", "/api/owned")).toBeUndefined();
  });
});

describe("HttpError", () => {
  it("carries the status a transport should send", () => {
    const error = new HttpError(404, "unknown session: nope");
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(404);
    expect(error.name).toBe("HttpError");
    expect(error.message).toBe("unknown session: nope");
  });
});

describe("intParam", () => {
  it("reads integers and treats blank or junk as absent", () => {
    expect(intParam("12")).toBe(12);
    expect(intParam("12.7")).toBe(12);
    expect(intParam("")).toBeUndefined();
    expect(intParam(undefined)).toBeUndefined();
    expect(intParam("abc")).toBeUndefined();
  });
});
