/**
 * WsServer — the C2 IO edge. Wraps real `ws`/`http` sockets into
 * {@link ClientTransport}s for {@link FleetWsGateway}; carries ZERO fanout/resume/
 * backpressure logic itself (that's the pure gateway, unit-tested without a socket) -
 * this file only translates `ws`/`http` events into gateway calls and back.
 *
 * Library choice: `ws` + `node:http` rather than a framework (fastify, etc.). This
 * slice serves `/ws`, a trivial `/healthz` probe, and (opt-in, `console.ws.webRoot`)
 * the console's OWN built UI as static files on the same origin - no routing table,
 * no middleware, no request bodies to parse. `ws` is the de facto standard Node
 * WebSocket server (small, dependency-light, actively maintained, MIT); `node:http` +
 * `node:fs`/`node:path` need no extra dependency for the upgrade + health-check +
 * static-file surface. Pulling in a full HTTP framework (or `serve-static`) for this
 * would be dead weight; if C3+ later grows a real HTTP API surface (auth callbacks,
 * REST alongside WS), revisit then.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { extname, join, resolve as resolvePath } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { logger } from "@edgecommons/ggcommons";
import type { ClientTransport, FleetWsGateway } from "./gateway";

let nextClientId = 1;

/** Content-type by lower-cased file extension (dot included); anything else is a generic binary stream. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** `fs.statSync`, or `undefined` for any error (missing path, permission, etc.) - never throws. */
function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Decode + split a request URL's path into safe path segments under a web root: strips
 * the query/fragment, rejects a decode failure or an embedded NUL, then keeps only
 * non-empty, non-`.` segments and REJECTS the whole path if any segment is `..` (a
 * traversal attempt) - so the joined result can never climb above the root. Returns
 * `undefined` for a rejected path.
 */
function safeRelativeSegments(rawUrl: string): string[] | undefined {
  const pathOnly = rawUrl.split(/[?#]/)[0] ?? "/";
  if (pathOnly.includes("\0")) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const segments = decoded.split(/[/\\]+/).filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) return undefined;
  return segments;
}

export interface WsServerOptions {
  /** TCP port to bind. Pass 0 for an OS-assigned ephemeral port (tests). */
  port: number;
  bindAddress: string;
  /**
   * The C4 AUTH SEAM: resolve a connection's RBAC role from its upgrade request. This is
   * where a real bearer/mTLS/OIDC check plugs in (inspect `req.headers`/the client cert,
   * reject the upgrade if unauthenticated, else map the principal to a console role). The
   * composition root passes `() => config.rbac.defaultRole` for now, so every connection
   * gets the configured permissive default — the RBAC ENFORCEMENT (in the CommandGateway)
   * is real; only the identity source is stubbed. Absent ⇒ no role (commanding falls back
   * to the gateway's own default/UNAVAILABLE handling).
   */
  resolveRole?: (req: IncomingMessage) => string;
  /**
   * Absolute (or cwd-relative) filesystem path to serve static files from (the built UI,
   * `ui/dist`), on this SAME HTTP+WS origin — **opt-in**: `undefined` (the default)
   * preserves the exact pre-existing behavior (only `/healthz` + `/ws`; every other GET
   * 404s). The composition root passes `config.ws.webRoot` (already cwd-resolved by
   * {@link consoleConfigFromGlobal}); this constructor re-resolves it defensively so a
   * caller (e.g. a test) can also just pass a plain relative/absolute path.
   */
  webRoot?: string;
}

/** The C2 gateway's real socket edge: HTTP server + WS upgrade on `/ws`, plus `/healthz` (+ opt-in static UI). */
export class WsServer {
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly webRoot?: string;

  constructor(
    private readonly gateway: FleetWsGateway,
    private readonly opts: WsServerOptions,
  ) {
    this.webRoot = opts.webRoot !== undefined ? resolvePath(opts.webRoot) : undefined;
    this.http = createServer((req, res) => this.handleRequest(req, res));
    this.wss = new WebSocketServer({ server: this.http, path: "/ws" });
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => this.onConnection(ws, req));
  }

  /**
   * Route ordering: `/healthz` first (cheapest, most probed), then — only when a
   * `webRoot` is configured — static file serving for every other GET; anything else
   * (non-GET, or GET with no `webRoot`) 404s exactly as before this feature existed. The
   * `/ws` upgrade never reaches this handler at all: Node's `http` module dispatches an
   * `Upgrade: websocket` request to the server's `upgrade` event (which `ws` owns), not
   * to the plain `request` event this handler is bound to — so routing precedence
   * between `/ws` and static serving is a non-issue by construction.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }
    if (req.method === "GET" && this.webRoot !== undefined) {
      this.serveStatic(req, this.webRoot, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
  }

  /**
   * Serve a file from `root` for `req`, with an SPA fallback and a traversal guard.
   *
   * - The request path is decoded and split into segments; any `..` segment (or a
   *   decode failure / embedded NUL) is REJECTED (403) — {@link safeRelativeSegments}
   *   guarantees the joined path can never climb above `root` (see its comment + the
   *   join below).
   * - A path resolving to a directory serves that directory's `index.html`.
   * - **SPA fallback**: when the resolved file is missing AND the requested path has no
   *   file extension (i.e. it isn't an "asset request" like `/assets/app-abc123.js`),
   *   the console assumes a client-side route and serves the root `index.html` instead —
   *   so deep-linking into the UI's router works. A missing path that DOES look like an
   *   asset (has an extension) 404s for real: only genuine app routes get the fallback.
   * - `index.html` is served `no-cache` (a redeploy must be picked up immediately);
   *   every other file gets a long, `immutable` cache lifetime (Vite content-hashes
   *   every non-`index.html` asset, so a changed file is always a new URL).
   */
  private serveStatic(req: IncomingMessage, root: string, res: ServerResponse): void {
    // The traversal guard: decode + normalize the URL path into a whitelist of plain path
    // segments (no `/`, `\`, or `..` can survive into any segment - safeRelativeSegments
    // rejects the whole request if one appears), then `join` them onto `root`. Because
    // `join` only concatenates + normalizes (it never lets a later argument re-anchor the
    // path the way `resolve` would), and no segment can contain a separator or `..`, the
    // joined result is PROVABLY confined under `root` - there is no path string this can
    // produce that escapes it, on POSIX or Windows.
    const segments = safeRelativeSegments(req.url ?? "/");
    if (segments === undefined) {
      res.writeHead(403, { "content-type": "text/plain" }).end("forbidden\n");
      return;
    }
    const requestedPath = join(root, ...segments);

    let filePath = requestedPath;
    let stat = statOrUndefined(filePath);
    if (stat?.isDirectory() === true) {
      filePath = join(filePath, "index.html");
      stat = statOrUndefined(filePath);
    }
    const looksLikeAsset = extname(segments[segments.length - 1] ?? "") !== "";
    if ((stat === undefined || !stat.isFile()) && !looksLikeAsset) {
      filePath = join(root, "index.html");
      stat = statOrUndefined(filePath);
    }
    if (stat === undefined || !stat.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? DEFAULT_CONTENT_TYPE;
    const cacheControl = ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable";
    res.writeHead(200, { "content-type": contentType, "cache-control": cacheControl });
    // Headers are already flushed by the time a read can fail (writeHead ran synchronously
    // above), so a stream error can only end the response, not recover it with a status.
    const stream = createReadStream(filePath);
    stream.on("error", (err) => {
      logger.warn(`edge-console ws: static-file read error for ${filePath}: ${String(err)}`);
      res.destroy();
    });
    stream.pipe(res);
  }

  /** Bind and start listening. */
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.http.once("error", onError);
      this.http.listen(this.opts.port, this.opts.bindAddress, () => {
        this.http.off("error", onError);
        resolve();
      });
    });
    const addr = this.address();
    logger.info(
      `edge-console ws gateway listening on ${this.opts.bindAddress}:${addr?.port ?? this.opts.port}/ws`,
    );
  }

  /** The bound address (only meaningful after {@link start} resolves); `null` if not listening. */
  address(): AddressInfo | null {
    const addr = this.http.address();
    return addr !== null && typeof addr === "object" ? addr : null;
  }

  /** Stop the gateway (closes every client) and tear down the listener. Safe to call once, after start(). */
  async stop(): Promise<void> {
    this.gateway.stop();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      this.http.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    // SECURITY / AUTH SEAM (C4): an upgrade-time credential check belongs here (bearer
    // token / mTLS client cert / OIDC session cookie from `req.headers`) — reject before
    // `gateway.connect()` ever runs for an unauthenticated client. Today `resolveRole`
    // maps every connection to the configured RBAC `defaultRole` (no real auth yet); a
    // production impl verifies the principal and maps it to a console role. Nothing
    // downstream (the pure gateway) knows auth exists — it only sees the resolved role.
    const id = `${req.socket.remoteAddress ?? "unknown"}:${req.socket.remotePort ?? 0}#${nextClientId++}`;
    const role = this.opts.resolveRole?.(req);
    const transport: ClientTransport = {
      id,
      send: (data) => ws.send(data),
      bufferedAmount: () => ws.bufferedAmount,
      close: (code, reason) => ws.close(code, reason),
    };
    const session = this.gateway.connect(transport, role);
    ws.on("message", (data) => session.onMessage(data.toString()));
    ws.on("close", () => session.onClose());
    ws.on("error", (err) => {
      logger.warn(`edge-console ws: socket error on ${id}: ${String(err)}`);
    });
  }
}
