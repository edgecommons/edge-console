/**
 * FleetClient — the browser's WS IO shell around the pure {@link FleetStore} (C3).
 *
 * The same pure/IO split as the server (`FleetWsGateway` core vs `ws-server.ts` edge):
 * ALL fold logic lives in the store; this class only speaks the C2 wire protocol —
 * dial, `hello`, dispatch `snapshot`/`delta`/`heartbeat`/`error` frames — and owns the
 * connection lifecycle. The socket is INJECTED (a {@link SocketFactory} returning the
 * minimal {@link SocketLike} surface), so every reconnect/resume/gap path is
 * unit-testable with a fake socket and fake timers — no network, no sleeps.
 *
 * Lifecycle:
 *  - `start()` dials; on open the client sends `hello{protocolVersion[, resumeSeq]}` —
 *    `resumeSeq` is the store's last applied seq whenever a snapshot baseline exists
 *    (i.e. on every reconnect), so the gateway can resume with only the missed deltas
 *    or fall back to a fresh snapshot (its call — the client accepts either).
 *  - A delta GAP (the store's fold reports one) forces a resync: drop the socket and
 *    redial immediately with `resumeSeq`; the gateway's DeltaBuffer proves coverage or
 *    re-snapshots. The client never guesses around a gap.
 *  - Reconnects back off exponentially (1 s doubling to 30 s), reset by any applied
 *    server frame. An `unsupported-protocol-version` error is FATAL (a stale tab
 *    against a redeployed gateway): no retry loop, the UI tells the user to reload.
 *  - A watchdog treats a silent connection (no frame within `idleTimeoutMs`, default
 *    3x the gateway's 15 s heartbeat) as dead and redials — half-open TCP hygiene.
 */
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ClientMessage, ServerMessage } from "@edgecommons/edge-console-protocol";
import type { LadderOptions } from "./store";
import { FleetStore } from "./store";
import type { FleetView } from "./store";

/** Connection status surfaced to the UI. */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

/** The minimal socket surface the client needs (a browser `WebSocket` satisfies it via {@link browserSocketFactory}). */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/** Dial one socket. Injected; tests substitute an in-memory fake. */
export type SocketFactory = (url: string) => SocketLike;

/** Wraps the real browser `WebSocket` into {@link SocketLike}. */
export function browserSocketFactory(url: string): SocketLike {
  const ws = new WebSocket(url);
  const like: SocketLike = {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => like.onopen?.();
  ws.onmessage = (ev) => like.onmessage?.(String(ev.data));
  ws.onclose = () => like.onclose?.();
  ws.onerror = () => like.onerror?.();
  return like;
}

export interface FleetClientOptions {
  url: string;
  socketFactory?: SocketFactory;
  /** First-retry backoff (ms); doubles per consecutive failure. Default 1000. */
  minRetryDelayMs?: number;
  /** Backoff ceiling (ms). Default 30000. */
  maxRetryDelayMs?: number;
  /** No inbound frame for this long ⇒ the connection is considered dead. Default 45000 (3x the gateway heartbeat). */
  idleTimeoutMs?: number;
  /** Client clock (ms epoch); injected for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** Store ladder options (the snapshot-under-outage fill-in only). */
  ladder?: Partial<LadderOptions>;
}

/** The immutable client state handed to React (identity-stable between changes). */
export interface ClientState {
  status: ConnectionStatus;
  /** Set only on a fatal, non-retried failure (protocol version skew). */
  fatalError?: string;
  hasSnapshot: boolean;
  fleet: FleetView;
  wsUrl: string;
}

export class FleetClient {
  readonly store: FleetStore;

  private readonly url: string;
  private readonly socketFactory: SocketFactory;
  private readonly minRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;

  private socket: SocketLike | undefined;
  private status: ConnectionStatus = "disconnected";
  private fatalError: string | undefined;
  private stopped = true;
  private everConnected = false;
  private retries = 0;
  private lastFrameAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdogTimer: ReturnType<typeof setInterval> | undefined;

  private readonly listeners: Array<() => void> = [];
  private stateCache: ClientState | undefined;

  constructor(opts: FleetClientOptions) {
    this.url = opts.url;
    this.socketFactory = opts.socketFactory ?? browserSocketFactory;
    this.minRetryDelayMs = opts.minRetryDelayMs ?? 1000;
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? 30_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 45_000;
    this.now = opts.now ?? Date.now;
    this.store = new FleetStore(opts.ladder);
  }

  /** Dial and keep the connection alive until {@link stop}. Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.fatalError = undefined;
    this.lastFrameAt = this.now();
    this.watchdogTimer = setInterval(
      () => this.checkIdle(),
      Math.max(1000, Math.floor(this.idleTimeoutMs / 3)),
    );
    this.connect();
  }

  /** Tear down: close the socket, cancel timers, no reconnects. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.watchdogTimer !== undefined) clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
    this.teardownSocket();
    this.setStatus("disconnected");
  }

  /** Subscribe to state changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** The current immutable state (cached — stable identity until the next change). */
  getState(): ClientState {
    const fleet = this.store.view();
    if (
      this.stateCache === undefined ||
      this.stateCache.fleet !== fleet ||
      this.stateCache.status !== this.status ||
      this.stateCache.fatalError !== this.fatalError
    ) {
      this.stateCache = {
        status: this.status,
        ...(this.fatalError !== undefined ? { fatalError: this.fatalError } : {}),
        hasSnapshot: this.store.hasSnapshot(),
        fleet,
        wsUrl: this.url,
      };
    }
    return this.stateCache;
  }

  // ------------------------------------------------------------------ internals

  private connect(): void {
    this.setStatus(this.everConnected ? "reconnecting" : "connecting");
    let socket: SocketLike;
    try {
      socket = this.socketFactory(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return; // a stale socket's event — ignore
      this.everConnected = true;
      this.lastFrameAt = this.now();
      const hello: ClientMessage = {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        // Resume whenever a baseline exists; the gateway resumes or re-snapshots.
        ...(this.store.hasSnapshot() ? { resumeSeq: this.store.lastAppliedSeq() } : {}),
      };
      socket.send(JSON.stringify(hello));
      this.setStatus("connected");
    };
    socket.onmessage = (data) => {
      if (this.socket !== socket) return;
      this.onFrame(data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.stopped && this.fatalError === undefined) this.scheduleReconnect();
    };
    socket.onerror = () => {
      // The close event (which always follows) drives the reconnect.
    };
  }

  private onFrame(data: string): void {
    this.lastFrameAt = this.now();
    let msg: ServerMessage;
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      msg = parsed as ServerMessage;
    } catch {
      return; // not JSON — ignore (the gateway never sends non-JSON)
    }
    switch (msg.type) {
      case "snapshot":
        this.store.applySnapshot(msg.snapshot, this.now());
        this.retries = 0;
        this.notify();
        return;
      case "delta": {
        const result = this.store.applyDeltas(msg.deltas, this.now());
        this.retries = 0;
        if (result.gap) {
          // Contiguity lost (backpressure skip, or deltas before any snapshot):
          // resync through a fresh dial — hello carries resumeSeq, the gateway
          // decides resume-vs-snapshot. Never fold past a hole.
          this.resyncNow();
        }
        this.notify();
        return;
      }
      case "heartbeat":
        this.store.noteHeartbeat(msg.at, this.now());
        this.retries = 0;
        this.notify();
        return;
      case "error":
        if (msg.code === "unsupported-protocol-version") {
          // Version skew between this tab and a redeployed gateway — reload needed;
          // retrying would loop forever with the same version.
          this.fatalError = msg.message;
          this.teardownSocket();
          this.setStatus("disconnected");
        }
        // "malformed" would be a client bug; the gateway closes the socket and the
        // close handler drives a normal reconnect.
        return;
      default:
        return; // unknown frame type — ignore (forward compatibility)
    }
  }

  private resyncNow(): void {
    this.teardownSocket();
    if (!this.stopped) this.connect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer !== undefined) return;
    const delay = Math.min(this.maxRetryDelayMs, this.minRetryDelayMs * 2 ** this.retries);
    this.retries++;
    this.setStatus(this.everConnected ? "reconnecting" : "connecting");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private checkIdle(): void {
    if (this.stopped || this.socket === undefined) return;
    if (this.now() - this.lastFrameAt > this.idleTimeoutMs) {
      // Silent connection — treat as dead (half-open socket) and redial.
      this.teardownSocket();
      this.scheduleReconnect();
    }
  }

  private teardownSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, "client teardown");
      } catch {
        // already closed/failed — nothing to release
      }
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
