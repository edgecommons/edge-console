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
import { PROTOCOL_VERSION, componentKeyId } from "@edgecommons/edge-console-protocol";
import type {
  ClientMessage,
  CommandError,
  ComponentKey,
  ServerMessage,
} from "@edgecommons/edge-console-protocol";
import type { LadderOptions } from "./store";
import { FleetStore } from "./store";
import type { FleetView } from "./store";
import { ConfigStore } from "./config-store";
import type { ConfigView } from "./config-store";
import { EventLogStore } from "./event-log-store";
import type { EventsView } from "./event-log-store";
import { AlarmStore } from "./alarm-store";
import type { AlarmsView } from "./alarm-store";
import { CommandStore } from "./command-store";
import type { CommandView } from "./command-store";

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
  /** How long a Refresh stays "in flight" without any config arrival before its UX flag clears. Default 10000. */
  refreshTimeoutMs?: number;
  /**
   * Client-side backstop (ms) before an in-flight command is failed locally when the
   * gateway never answers (only reachable if the connection drops mid-flight — the
   * gateway always answers otherwise, even on its own TIMEOUT). Default 65000, just above
   * the gateway's 60 s command ceiling. Default `Math.random`-free id via a counter.
   */
  commandTimeoutMs?: number;
}

/** The immutable client state handed to React (identity-stable between changes). */
export interface ClientState {
  status: ConnectionStatus;
  /** Set only on a fatal, non-retried failure (protocol version skew). */
  fatalError?: string;
  hasSnapshot: boolean;
  fleet: FleetView;
  /** The C5 config-review entries (per requested component key). */
  configs: ConfigView;
  /** The C6 rolling event log (newest-first, populated while subscribed). */
  events: EventsView;
  /** The R0 console-side alarm surface (active list + counts) — the notifications badge. */
  alarms: AlarmsView;
  /** The connection's resolved RBAC role (from the `welcome` frame) — the account indicator. */
  role?: string;
  /** The C4 command state (per-request phases + per-button latest + the toast feed). */
  commands: CommandView;
  wsUrl: string;
}

export class FleetClient {
  readonly store: FleetStore;
  /** The C5 config-review fold core (pure; this client is its IO shell). */
  readonly configStore: ConfigStore;
  /** The C6 event-log fold core (pure; this client is its IO shell). */
  readonly eventLog: EventLogStore;
  /** The R0 alarm fold core (pure; this client is its IO shell). */
  readonly alarmStore: AlarmStore;
  /** The C4 command fold core (pure; this client is its IO shell). */
  readonly commandStore: CommandStore;

  private readonly url: string;
  private readonly socketFactory: SocketFactory;
  private readonly minRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly idleTimeoutMs: number;
  private readonly refreshTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly now: () => number;
  /** Monotonic source for client-chosen command `requestId`s. */
  private commandCounter = 0;
  /** Per-command backstop timers (cleared on the matching result). */
  private readonly commandTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private socket: SocketLike | undefined;
  private status: ConnectionStatus = "disconnected";
  private fatalError: string | undefined;
  private stopped = true;
  private everConnected = false;
  private retries = 0;
  private lastFrameAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdogTimer: ReturnType<typeof setInterval> | undefined;
  /** Per-component-key refresh UX timers (cleared on answer/teardown). */
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly listeners: Array<() => void> = [];
  private stateCache: ClientState | undefined;

  constructor(opts: FleetClientOptions) {
    this.url = opts.url;
    this.socketFactory = opts.socketFactory ?? browserSocketFactory;
    this.minRetryDelayMs = opts.minRetryDelayMs ?? 1000;
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? 30_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 45_000;
    this.refreshTimeoutMs = opts.refreshTimeoutMs ?? 10_000;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 65_000;
    this.now = opts.now ?? Date.now;
    this.store = new FleetStore(opts.ladder);
    this.configStore = new ConfigStore();
    this.eventLog = new EventLogStore();
    this.alarmStore = new AlarmStore();
    this.commandStore = new CommandStore();
  }

  /** The connection's resolved RBAC role (from the `welcome` frame); undefined until it arrives. */
  private role: string | undefined;

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
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    this.failPendingCommands({ code: "DISCONNECTED", message: "the console client stopped" });
    this.teardownSocket();
    this.setStatus("disconnected");
  }

  /**
   * Request a component's retained cfg (C5 `get-config`). Marks the entry loading in
   * the store and — when connected — sends the frame, which also registers this
   * connection's interest server-side (later pushes arrive unprompted). Server-side
   * interest dies with the connection, so the owning view re-requests whenever
   * `(selection, connected)` changes — that covers reconnects with no client-side
   * resubscribe machinery.
   */
  requestConfig(key: ComponentKey): void {
    this.configStore.noteRequested(key);
    this.sendFrame({ type: "get-config", protocolVersion: PROTOCOL_VERSION, key });
    this.notify();
  }

  /**
   * Ask the components on the key's device to re-push their cfg (C5 `refresh-config`
   * → the server's per-device `republish-cfg` broadcast). No direct reply: a fresh
   * `config` push clears the entry's `refreshing` flag, or the client-side timeout
   * does (a fleet whose devices lack the republish listener simply never answers —
   * absence is silent by design).
   */
  refreshConfig(key: ComponentKey): void {
    this.configStore.noteRefreshRequested(key);
    this.sendFrame({ type: "refresh-config", protocolVersion: PROTOCOL_VERSION, device: key.device });
    const id = componentKeyId(key);
    const existing = this.refreshTimers.get(id);
    if (existing !== undefined) clearTimeout(existing);
    this.refreshTimers.set(
      id,
      setTimeout(() => {
        this.refreshTimers.delete(id);
        this.configStore.clearRefreshing(key);
        this.notify();
      }, this.refreshTimeoutMs),
    );
    this.notify();
  }

  /**
   * Subscribe to the fleet-wide event stream (C6 `subscribe-events`). The gateway
   * answers with the recent backlog (replacing the local log) and streams every
   * later arrival. Server-side interest dies with the connection, so the owning
   * view re-subscribes whenever the connection comes (back) up — the same
   * reconnect story as `requestConfig` (no client-side resubscribe machinery).
   */
  subscribeEvents(limit?: number): void {
    this.sendFrame({
      type: "subscribe-events",
      protocolVersion: PROTOCOL_VERSION,
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  /** Stop the event stream (e.g. the Events view unmounted). Idempotent. */
  unsubscribeEvents(): void {
    this.sendFrame({ type: "unsubscribe-events", protocolVersion: PROTOCOL_VERSION });
  }

  /**
   * Subscribe to the console-side alarm surface (R0 `subscribe-alarms`): one replace
   * `alarms` snapshot (active list + counts) arrives immediately and again on every
   * later change. The app shell subscribes on connect (the notifications badge is
   * global); server-side interest is per-connection, so the shell re-subscribes
   * whenever the connection comes (back) up — the same reconnect story as the others.
   */
  subscribeAlarms(): void {
    this.sendFrame({ type: "subscribe-alarms", protocolVersion: PROTOCOL_VERSION });
  }

  /** Stop the alarm stream. Idempotent. */
  unsubscribeAlarms(): void {
    this.sendFrame({ type: "unsubscribe-alarms", protocolVersion: PROTOCOL_VERSION });
  }

  /**
   * Acknowledge an active alarm (R0 `ack-alarm`) — console-side state that does not
   * clear the alarm. No direct reply: the tracker re-pushes a fresh `alarms` snapshot
   * (with the alarm now `acked`) to every subscribed client.
   */
  ackAlarm(alarmId: string): void {
    this.sendFrame({ type: "ack-alarm", protocolVersion: PROTOCOL_VERSION, alarmId });
  }

  /**
   * Invoke a UNS command `verb` on `key` (C4 `invoke-command`). Returns the client-chosen
   * `requestId` (also stamped into the store) so a caller can correlate. Marks the command
   * `pending` in the store immediately, and:
   *  - if there is no live connection, settles it locally at once (server command state is
   *    per-connection — it could never be answered after a reconnect anyway);
   *  - otherwise sends the frame and arms a backstop timer so a connection that drops
   *    mid-flight still settles the entry (the gateway itself always answers otherwise).
   * The result arrives as a `command-result` frame correlated by `requestId`.
   */
  invokeCommand(key: ComponentKey, verb: string, args?: Record<string, unknown>): string {
    const requestId = `cmd-${++this.commandCounter}`;
    this.commandStore.notePending(requestId, key, verb);
    if (this.socket === undefined || this.status !== "connected") {
      this.commandStore.failClient(requestId, {
        code: "DISCONNECTED",
        message: "not connected to the console gateway",
      });
    } else {
      this.sendFrame({
        type: "invoke-command",
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        key,
        verb,
        ...(args !== undefined ? { args } : {}),
      });
      this.commandTimers.set(
        requestId,
        setTimeout(() => {
          this.commandTimers.delete(requestId);
          this.commandStore.failClient(requestId, {
            code: "TIMEOUT",
            message: "the gateway did not answer in time",
          });
          this.notify();
        }, this.commandTimeoutMs),
      );
    }
    this.notify();
    return requestId;
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
    const configs = this.configStore.view();
    const events = this.eventLog.view();
    const alarms = this.alarmStore.view();
    const commands = this.commandStore.view();
    if (
      this.stateCache === undefined ||
      this.stateCache.fleet !== fleet ||
      this.stateCache.configs !== configs ||
      this.stateCache.events !== events ||
      this.stateCache.alarms !== alarms ||
      this.stateCache.commands !== commands ||
      this.stateCache.status !== this.status ||
      this.stateCache.role !== this.role ||
      this.stateCache.fatalError !== this.fatalError
    ) {
      this.stateCache = {
        status: this.status,
        ...(this.fatalError !== undefined ? { fatalError: this.fatalError } : {}),
        hasSnapshot: this.store.hasSnapshot(),
        fleet,
        configs,
        events,
        alarms,
        ...(this.role !== undefined ? { role: this.role } : {}),
        commands,
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
      // In-flight commands are lost with the connection (server command state is
      // per-connection) — settle them so their buttons don't spin forever.
      this.failPendingCommands({ code: "DISCONNECTED", message: "the gateway connection dropped" });
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
      case "config": {
        this.clearRefreshTimer(componentKeyId(msg.key));
        this.configStore.applyConfig(msg.key, msg.cfg, msg.receivedAt, msg.sourceTimestamp);
        this.retries = 0;
        this.notify();
        return;
      }
      case "config-unavailable":
        this.configStore.applyUnavailable(msg.key);
        this.retries = 0;
        this.notify();
        return;
      case "events":
        this.eventLog.applyBacklog(msg.events);
        this.retries = 0;
        this.notify();
        return;
      case "event":
        this.eventLog.applyEvent(msg.event);
        this.retries = 0;
        this.notify();
        return;
      case "welcome":
        this.role = msg.role;
        this.retries = 0;
        this.notify();
        return;
      case "alarms":
        this.alarmStore.applySnapshot(msg.snapshot);
        this.retries = 0;
        this.notify();
        return;
      case "command-result":
        this.clearCommandTimer(msg.requestId);
        this.commandStore.applyResult({
          requestId: msg.requestId,
          key: msg.key,
          verb: msg.verb,
          ok: msg.ok,
          ...(msg.result !== undefined ? { result: msg.result } : {}),
          ...(msg.error !== undefined ? { error: msg.error } : {}),
          elapsedMs: msg.elapsedMs,
        });
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

  /**
   * Best-effort send of a client frame. Quietly skipped when not connected — the
   * store state (e.g. a `loading` entry) survives, and the owning view re-issues the
   * request when the connection is back (its effect keys on the connection status).
   */
  private sendFrame(frame: ClientMessage): void {
    if (this.socket === undefined || this.status !== "connected") return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      // Socket died mid-send; the close handler drives the reconnect.
    }
  }

  private clearRefreshTimer(id: string): void {
    const timer = this.refreshTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.refreshTimers.delete(id);
    }
  }

  private clearCommandTimer(requestId: string): void {
    const timer = this.commandTimers.get(requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.commandTimers.delete(requestId);
    }
  }

  /**
   * Fail every in-flight command (the connection went away — the gateway's per-connection
   * command state cannot answer them, even if a reconnect follows). Clears their backstop
   * timers and notifies.
   */
  private failPendingCommands(error: CommandError): void {
    for (const timer of this.commandTimers.values()) clearTimeout(timer);
    this.commandTimers.clear();
    this.commandStore.failAllPending(error);
    this.notify();
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
