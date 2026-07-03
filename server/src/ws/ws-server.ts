/**
 * WsServer — the C2 IO edge. Wraps real `ws`/`http` sockets into
 * {@link ClientTransport}s for {@link FleetWsGateway}; carries ZERO fanout/resume/
 * backpressure logic itself (that's the pure gateway, unit-tested without a socket) -
 * this file only translates `ws`/`http` events into gateway calls and back.
 *
 * Library choice: `ws` + `node:http` rather than a framework (fastify, etc.). This
 * slice serves exactly one real endpoint (`/ws`) plus a trivial `/healthz` probe - no
 * routing, no middleware, no request bodies to parse. `ws` is the de facto standard
 * Node WebSocket server (small, dependency-light, actively maintained, MIT), and
 * `node:http` needs no extra dependency for the plain upgrade + health-check surface.
 * Pulling in a full HTTP framework for two routes would be dead weight; if C3+ later
 * grows a real HTTP API surface (auth callbacks, REST alongside WS), revisit then.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { logger } from "@edgecommons/ggcommons";
import type { ClientTransport, FleetWsGateway } from "./gateway";

let nextClientId = 1;

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
}

/** The C2 gateway's real socket edge: HTTP server + WS upgrade on `/ws`, plus `/healthz`. */
export class WsServer {
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;

  constructor(
    private readonly gateway: FleetWsGateway,
    private readonly opts: WsServerOptions,
  ) {
    this.http = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    });
    this.wss = new WebSocketServer({ server: this.http, path: "/ws" });
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => this.onConnection(ws, req));
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
