import { Service, type Context, type Disposer } from "@daydream-code/kernel";

declare module "@daydream-code/kernel" {
  interface Context {
    routes: HttpRoutes;
  }
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A request, reduced to what a handler can act on. Deliberately framework-free:
 * this package depends on the kernel and nothing else, so a capability package
 * can ship its HTTP surface without depending on whichever transport is
 * mounted — or on any transport being mounted at all.
 */
export interface RouteRequest {
  method: HttpMethod;
  /** Path only, no query string, no trailing slash (except "/"). */
  path: string;
  /** Values captured by `:name` segments of the route's path. */
  params: Record<string, string>;
  /** First value per key; transports collapse repeats. */
  query: Record<string, string | undefined>;
  /** Lowercased header names. */
  headers: Record<string, string | undefined>;
  /** Parsed body, or undefined when the request carried none. */
  body: unknown;
}

export interface RouteDefinition {
  method: HttpMethod;
  /** `/api/sessions/:id` — static segments and `:name` params, no wildcards. */
  path: string;
  /**
   * Reachable without the transport's auth token. Only liveness checks should
   * set this: it is the one thing standing between an unauthenticated caller
   * and the handler.
   */
  public?: boolean;
  /**
   * The handler's return value is the response body, sent as JSON with status
   * 200. Any other status is an `HttpError` thrown from here — there is no
   * reply object, because a handler that could write the response directly
   * would be writing to one specific transport.
   */
  handle(request: RouteRequest): unknown | Promise<unknown>;
}

export interface RouteMatch {
  route: RouteDefinition;
  params: Record<string, string>;
}

/**
 * A response status other than 200. Transports map this to the wire; anything
 * else that escapes a handler is a 500, because an unrecognized throw is a bug
 * and not a status the client should be asked to interpret.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface Segment {
  /** Literal text, or the param name when `param` is true. */
  value: string;
  param: boolean;
}

interface CompiledRoute {
  route: RouteDefinition;
  segments: Segment[];
  /** How many segments are literal; the tie-break for overlapping patterns. */
  statics: number;
}

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function compile(route: RouteDefinition): CompiledRoute {
  const segments = splitPath(route.path).map((segment): Segment =>
    segment.startsWith(":")
      ? { value: segment.slice(1), param: true }
      : { value: segment, param: false },
  );
  for (const segment of segments) {
    if (segment.param && segment.value.length === 0) {
      throw new Error(`route "${route.path}" has an unnamed ":" parameter`);
    }
  }
  return {
    route,
    segments,
    statics: segments.filter((segment) => !segment.param).length,
  };
}

/**
 * Identity of a route for conflict detection: two routes that would match
 * exactly the same requests collide even when their params are spelled
 * differently, so param names are erased.
 */
function shapeKey(method: string, segments: Segment[]): string {
  const shape = segments.map((s) => (s.param ? ":" : s.value)).join("/");
  return `${method} /${shape}`;
}

/**
 * Registry seam: the harness HTTP surface, as data. Capability packages
 * register their own routes here; a transport provider (`server/fastify`, or a
 * replacement) mounts one catch-all and dispatches through `match`.
 *
 * Matching lives here rather than in the transport because plugins load and
 * unload at any point in a fiber's life, and every real HTTP framework — this
 * one included — freezes its router once it is listening. Resolving per
 * request is what makes a route plugin loaded after boot, or unloaded when its
 * provider goes away, behave like every other effect in the kernel.
 */
export class HttpRoutes extends Service {
  /** Keyed by shape, so registration order is preserved for tie-breaking. */
  #routes = new Map<string, CompiledRoute>();

  constructor(ctx: Context) {
    super(ctx, "routes");
  }

  /**
   * Register a route owned by the calling plugin: pass the caller's own ctx so
   * the route disappears when the caller unloads, not when the registry does.
   */
  register(owner: Context, route: RouteDefinition): Disposer {
    const compiled = compile(route);
    const key = shapeKey(route.method, compiled.segments);
    if (this.#routes.has(key)) {
      throw new Error(`route "${route.method} ${route.path}" is already registered`);
    }
    return owner.effect(() => {
      this.#routes.set(key, compiled);
      return () => this.#routes.delete(key);
    }, `route(${route.method} ${route.path})`);
  }

  /** Register several routes as one unit; the disposer unwinds all of them. */
  registerAll(owner: Context, routes: readonly RouteDefinition[]): Disposer {
    const disposers = routes.map((route) => this.register(owner, route));
    return async () => {
      for (const dispose of disposers.reverse()) await dispose();
    };
  }

  list(): RouteDefinition[] {
    return [...this.#routes.values()].map((entry) => entry.route);
  }

  /**
   * Resolve a request to a route and its captured params.
   *
   * HEAD resolves against GET: transports commonly synthesize HEAD from a GET
   * route, and a registry that did not would 404 a request the same transport
   * claims to serve. Where two patterns both match, the one with more literal
   * segments wins (`/api/journal/search` over `/api/journal/:id`); an exact
   * tie goes to whichever registered first.
   */
  match(method: string, path: string): RouteMatch | undefined {
    const wanted = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
    const segments = splitPath(path);
    let best: RouteMatch | undefined;
    let bestStatics = -1;
    for (const entry of this.#routes.values()) {
      if (entry.route.method !== wanted) continue;
      if (entry.segments.length !== segments.length) continue;
      if (entry.statics <= bestStatics) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (const [index, segment] of entry.segments.entries()) {
        const actual = segments[index]!;
        if (segment.param) params[segment.value] = decodeURIComponent(actual);
        else if (segment.value !== actual) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      best = { route: entry.route, params };
      bestStatics = entry.statics;
    }
    return best;
  }
}

/** Parse an integer query param; blank and non-numeric read as absent. */
export function intParam(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}
