/**
 * FleetWsGateway — the C2 pure fanout core: snapshot-then-deltas over N concurrent
 * clients, resume-from-seq, and per-client backpressure isolation (DESIGN §6.4,
 * reconciliation §4 C2 row). No `ws`/`http` import here: clients are injected as
 * {@link ClientTransport}s - the same inject-the-socket split the FleetModel uses for
 * its clock and BusIngress uses for its messaging service. `server/src/ws/ws-server.ts`
 * is the thin `ws` IO edge that wraps real sockets into this interface; that split is
 * what makes fanout/resume/backpressure unit-testable with a fake transport and no live
 * network.
 *
 * Wire contract: `@edgecommons/edge-console-protocol` (`ClientMessage`/`ServerMessage`/
 * `parseClientMessage`). A frame that fails `parseClientMessage` or names an
 * unsupported `protocolVersion` is rejected with an `error` frame and the connection is
 * closed - no partial acceptance.
 *
 * Resume rule (reconciliation §4 / plan point 3): a client's `hello.resumeSeq` is
 * honored (send only the missed `delta` batch, no snapshot) when the bounded
 * {@link DeltaBuffer} can prove contiguous coverage from `resumeSeq` forward; on any
 * gap or uncertainty (evicted range, `resumeSeq` ahead of the server) the gateway falls
 * back to a fresh `snapshot` - correctness over cleverness.
 *
 * Backpressure (requirement 4): each client's outbound is judged independently via
 * `transport.bufferedAmount()` (mirrors `WebSocket.bufferedAmount`). A client whose
 * transport stays over `maxBufferedBytes` for more than `maxMissedPushes` consecutive
 * delta pushes is dropped-and-resnapshotted (its missed deltas are superseded by a
 * fresh snapshot, not queued) - this never blocks or delays delivery to any other
 * client, since sending is a simple non-blocking call per session in a plain loop.
 */
import { logger } from "@edgecommons/ggcommons";
import { PROTOCOL_VERSION, componentKeyId, parseClientMessage } from "@edgecommons/edge-console-protocol";
import type {
  AlarmSnapshot,
  ClientMessage,
  ComponentKey,
  ConsoleEvent,
  FleetDelta,
  FleetSnapshot,
  MetricSeriesSnapshot,
  MetricSeriesUpdate,
  RuntimeAttributes,
  ServerMessage,
  SignalSeriesSnapshot,
  SignalSeriesUpdate,
  WsErrorCode,
} from "@edgecommons/edge-console-protocol";
import type { Clock, DeltaListener } from "../fleet/fleet-model";
import type { ConfigUpdateListener, StoredConfig } from "../fleet/config-store";
import type { EventListener } from "../fleet/event-store";
import type { MetricUpdateListener } from "../fleet/metric-store";
import type { SignalUpdateListener } from "../fleet/signal-store";
import type { AttributeUpdateListener } from "../fleet/attribute-store";
import type { AlarmListener } from "../fleet/alarm-tracker";
import type { CommandGateway, CommandResultData } from "../command/command-gateway";
import type { RbacPolicy } from "../command/rbac";
import { DeltaBuffer } from "./delta-buffer";

/** What the gateway needs from the FleetModel - a narrow interface, no `ws` dependency. `FleetModel` satisfies this structurally. */
export interface FleetSource {
  snapshot(): FleetSnapshot;
  onDelta(listener: DeltaListener): () => void;
}

/** What the gateway needs from the retained-cfg cache (C5). `ConfigStore` satisfies this structurally. */
export interface ConfigSource {
  get(key: ComponentKey): StoredConfig | undefined;
  onUpdate(listener: ConfigUpdateListener): () => void;
}

/**
 * The C5 config seam (optional third constructor argument): the retained-cfg cache to
 * answer `get-config` from, and the re-pull trigger a `refresh-config` frame fires
 * (the composition root wires it to BusIngress's per-device `republish-*` `_bcast`
 * broadcast — fire-and-forget, never awaited on the WS path). Without this seam the
 * gateway still speaks the protocol honestly: every `get-config` is answered
 * `config-unavailable` (there is no cache) and `refresh-config` is a no-op.
 */
export interface ConfigGatewayDeps {
  configs: ConfigSource;
  /** Trigger the per-device `republish-cfg`/`republish-state` broadcast. */
  refreshDevice: (device: string) => void;
}

/** What the gateway needs from the rolling event store (C6). `EventStore` satisfies this structurally. */
export interface EventFeedSource {
  recent(limit?: number): ConsoleEvent[];
  onEvent(listener: EventListener): () => void;
}

/** What the gateway needs from the metric surface (C6). `MetricStore` satisfies this structurally. */
export interface MetricFeedSource {
  snapshot(): MetricSeriesSnapshot[];
  onUpdate(listener: MetricUpdateListener): () => void;
}

/** What the gateway needs from the DATA-plane signal surface (R0). `SignalStore` satisfies this structurally. */
export interface SignalFeedSource {
  snapshot(): SignalSeriesSnapshot[];
  onUpdate(listener: SignalUpdateListener): () => void;
}

/** What the gateway needs from the runtime-attribute surface (R0). `AttributeStore` satisfies this structurally. */
export interface AttributeFeedSource {
  snapshot(): RuntimeAttributes[];
  onUpdate(listener: AttributeUpdateListener): () => void;
}

/** What the gateway needs from the console-side alarm tracker (R0). `AlarmTracker` satisfies this structurally. */
export interface AlarmFeedSource {
  snapshot(): AlarmSnapshot;
  onUpdate(listener: AlarmListener): () => void;
  /** Toggle console-side ack for an active alarm; returns whether it changed. */
  ack(alarmId: string): boolean;
}

/**
 * The activity seam (optional fourth constructor argument). `events`/`metrics` are the
 * C6 surfaces (backlog/snapshot reply + live streaming). `signals`/`attributes`/`alarms`
 * are the R0 additions (the data-plane signal surface, the runtime-attribute projection,
 * and the console-side alarm tracker) — all optional, all following the same
 * per-connection subscribe/snapshot-then-push discipline. Without a given source the
 * gateway still speaks the protocol honestly: subscriptions are accepted and answered with
 * an empty backlog/snapshot, and no pushes ever arrive.
 */
export interface ActivityGatewayDeps {
  events: EventFeedSource;
  metrics: MetricFeedSource;
  signals?: SignalFeedSource;
  attributes?: AttributeFeedSource;
  alarms?: AlarmFeedSource;
}

/** The empty alarm snapshot the gateway answers with when there is no alarm source. */
const EMPTY_ALARM_SNAPSHOT: AlarmSnapshot = {
  active: [],
  counts: { critical: 0, warning: 0, active: 0, contained: 0, acked: 0 },
};

/**
 * The C4 command seam (optional fifth constructor argument): the pure
 * {@link CommandGateway} that turns an `invoke-command` into a site-bus request/reply,
 * plus the {@link RbacPolicy} whose `defaultRole` is the fallback for a connection with
 * no {@link FleetWsGateway.connect}-supplied role (the auth seam's stub). Without this
 * seam the gateway still speaks the protocol honestly: every `invoke-command` is answered
 * `command-result{ok:false, error:{code:"UNAVAILABLE"}}` (there is no bus request path).
 */
export interface CommandSeamDeps {
  gateway: CommandGateway;
  rbac: RbacPolicy;
}

/** The gateway's view of one client connection. The real `ws` IO edge implements this; tests use an in-memory fake. */
export interface ClientTransport {
  /** Opaque, unique per connection - logging/bookkeeping only. */
  readonly id: string;
  send(data: string): void;
  /** Bytes still queued for send (mirrors `WebSocket.bufferedAmount`) - the backpressure signal. */
  bufferedAmount(): number;
  close(code: number, reason: string): void;
}

/** A connected client's inbound handle, returned by {@link FleetWsGateway.connect}. */
export interface ClientSession {
  /** Feed one raw inbound WS text frame. */
  onMessage(raw: string): void;
  /** The transport closed (any reason, any side) - detach bookkeeping. Idempotent. */
  onClose(): void;
}

export interface FleetWsGatewayOptions {
  clock: Clock;
  /** Bounded recent-delta ring backing resume (count of deltas, not bytes). Default 1000. */
  deltaBufferSize: number;
  /** A transport reporting more than this many buffered bytes is considered backpressured for the current push. Default 1 MiB. */
  maxBufferedBytes: number;
  /** Consecutive backpressured delta pushes tolerated before a client is force-resynced with a fresh snapshot (dropping the missed deltas). Default 5. */
  maxMissedPushes: number;
  /** A connected client must send `hello` within this many ms or is dropped. Default 20000. */
  helloTimeoutMs: number;
}

export const DEFAULT_GATEWAY_OPTIONS: Omit<FleetWsGatewayOptions, "clock"> = {
  deltaBufferSize: 1000,
  maxBufferedBytes: 1 << 20,
  maxMissedPushes: 5,
  helloTimeoutMs: 20_000,
};

/** Mutable per-connection bookkeeping. */
interface Session {
  transport: ClientTransport;
  connectedAt: number;
  /** The connection's RBAC role (resolved by the auth seam at connect; C4). */
  role: string;
  /** Set once a valid `hello` has been processed; pre-hello clients receive nothing (not even heartbeats). */
  ready: boolean;
  /** Consecutive delta pushes skipped due to backpressure since the last successful send/resync. */
  missedPushes: number;
  /** Component-key ids this client requested config for — fresh `cfg` arrivals for them are pushed (C5). */
  configKeys: Set<string>;
  /** Live `event` pushes are streamed while set (C6 `subscribe-events`). */
  eventsSubscribed: boolean;
  /** Live `metric` pushes are streamed while set (C6 `subscribe-metrics`). */
  metricsSubscribed: boolean;
  /** Live `signal` pushes are streamed while set (R0 `subscribe-signals`). */
  signalsSubscribed: boolean;
  /** Live `attribute` pushes are streamed while set (R0 `subscribe-attributes`). */
  attributesSubscribed: boolean;
  /** Live `alarms` pushes are streamed while set (R0 `subscribe-alarms`). */
  alarmsSubscribed: boolean;
  /** In-flight command `requestId`s (C4) — for correlation + drop-on-disconnect. */
  pendingCommands: Set<string>;
}

/** The C2 pure fanout core over the FleetModel's snapshot + delta stream. */
export class FleetWsGateway {
  private readonly opts: FleetWsGatewayOptions;
  private readonly sessions = new Map<string, Session>();
  private readonly buffer: DeltaBuffer;
  private readonly detach: () => void;
  private readonly detachConfig: (() => void) | undefined;
  private readonly detachEvents: (() => void) | undefined;
  private readonly detachMetrics: (() => void) | undefined;
  private readonly detachSignals: (() => void) | undefined;
  private readonly detachAttributes: (() => void) | undefined;
  private readonly detachAlarms: (() => void) | undefined;

  constructor(
    private readonly source: FleetSource,
    opts: Partial<Omit<FleetWsGatewayOptions, "clock">> & { clock: Clock },
    private readonly config?: ConfigGatewayDeps,
    private readonly activity?: ActivityGatewayDeps,
    private readonly command?: CommandSeamDeps,
  ) {
    this.opts = { ...DEFAULT_GATEWAY_OPTIONS, ...opts };
    this.buffer = new DeltaBuffer(this.opts.deltaBufferSize, source.snapshot().seq);
    this.detach = source.onDelta((deltas) => this.onDeltas(deltas));
    this.detachConfig = config?.configs.onUpdate((entry) => this.pushConfig(entry));
    this.detachEvents = activity?.events.onEvent((event) => this.pushEvent(event));
    this.detachMetrics = activity?.metrics.onUpdate((updates) => this.pushMetricUpdates(updates));
    this.detachSignals = activity?.signals?.onUpdate((updates) => this.pushSignalUpdates(updates));
    this.detachAttributes = activity?.attributes?.onUpdate((updates) =>
      this.pushAttributeUpdates(updates),
    );
    this.detachAlarms = activity?.alarms?.onUpdate((snapshot) => this.pushAlarms(snapshot));
  }

  /**
   * Register a newly-opened transport. Sends nothing until the client's `hello` arrives.
   * `role` is the connection's RBAC role (C4), resolved by the auth seam at the WS edge
   * (`ws-server.ts` `onConnection`); it defaults to the command seam's configured
   * `defaultRole` (or, with no command seam, an inert placeholder — commanding is
   * UNAVAILABLE there anyway).
   */
  connect(transport: ClientTransport, role?: string): ClientSession {
    const session: Session = {
      transport,
      connectedAt: this.opts.clock(),
      role: role ?? this.command?.rbac.defaultRole ?? "",
      ready: false,
      missedPushes: 0,
      configKeys: new Set(),
      eventsSubscribed: false,
      metricsSubscribed: false,
      signalsSubscribed: false,
      attributesSubscribed: false,
      alarmsSubscribed: false,
      pendingCommands: new Set(),
    };
    this.sessions.set(transport.id, session);
    return {
      onMessage: (raw) => this.onMessage(session, raw),
      onClose: () => {
        this.sessions.delete(transport.id);
      },
    };
  }

  /**
   * Periodic tick - the composition root calls this alongside the FleetModel sweeper
   * (`console.ws.heartbeatIntervalMs`): sends a `heartbeat` to every ready client and
   * evicts any client still pre-hello past `helloTimeoutMs`. No internal timers, so
   * this is directly unit-testable with an injected clock - no sleeps.
   */
  tick(): void {
    const now = this.opts.clock();
    for (const session of [...this.sessions.values()]) {
      if (!session.ready) {
        if (now - session.connectedAt > this.opts.helloTimeoutMs) {
          this.reject(session, "malformed", "no hello received within timeout");
        }
        continue;
      }
      this.send(session, { type: "heartbeat", protocolVersion: PROTOCOL_VERSION, at: now });
    }
  }

  /** Currently connected clients (diagnostics/tests). */
  clientCount(): number {
    return this.sessions.size;
  }

  /** Detach from the FleetModel + side stores and close every client (composition-root shutdown). */
  stop(): void {
    this.detach();
    this.detachConfig?.();
    this.detachEvents?.();
    this.detachMetrics?.();
    this.detachSignals?.();
    this.detachAttributes?.();
    this.detachAlarms?.();
    for (const session of [...this.sessions.values()]) {
      session.transport.close(1001, "server shutting down");
    }
    this.sessions.clear();
  }

  // ------------------------------------------------------------------ internals

  private onMessage(session: Session, raw: string): void {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.reject(session, "malformed", parsed.reason);
      return;
    }
    const msg = parsed.message;
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.reject(
        session,
        "unsupported-protocol-version",
        `gateway is protocol v${PROTOCOL_VERSION}, client sent v${msg.protocolVersion}`,
      );
      return;
    }
    if (msg.type === "hello") {
      session.ready = true;
      session.missedPushes = 0;
      // Welcome first: the connection's resolved RBAC role (the account indicator's
      // source), sent before the snapshot so the shell can render identity immediately.
      this.send(session, { type: "welcome", protocolVersion: PROTOCOL_VERSION, role: session.role });
      this.resync(session, msg.resumeSeq);
      return;
    }
    if (!session.ready) {
      // The handshake contract: nothing is served before a valid hello.
      this.reject(session, "malformed", "hello must be the first frame");
      return;
    }
    this.onRequest(session, msg);
  }

  /** Post-hello client requests (the C5 config + C6 activity families; C4's command frames join here). */
  private onRequest(session: Session, msg: Exclude<ClientMessage, { type: "hello" }>): void {
    switch (msg.type) {
      case "get-config": {
        // Register interest first: a cfg racing in between lookup and reply is
        // pushed rather than lost. Interest is per-connection and additive.
        session.configKeys.add(componentKeyId(msg.key));
        const entry = this.config?.configs.get(msg.key);
        this.send(
          session,
          entry !== undefined
            ? configMessage(entry)
            : { type: "config-unavailable", protocolVersion: PROTOCOL_VERSION, key: msg.key },
        );
        return;
      }
      case "refresh-config":
        // Fire-and-forget re-pull: the composition root wires this to the per-device
        // `_bcast` republish broadcast; the answering `cfg` (once the device-side S1
        // listener exists) arrives on the bus and flows back as a `config` push.
        this.config?.refreshDevice(msg.device);
        return;
      case "subscribe-events": {
        // Register interest first (an event racing in lands as a push, dedupable by
        // id), then answer with the newest-first backlog — the client's baseline.
        session.eventsSubscribed = true;
        this.send(session, {
          type: "events",
          protocolVersion: PROTOCOL_VERSION,
          events: this.activity?.events.recent(msg.limit) ?? [],
        });
        return;
      }
      case "unsubscribe-events":
        session.eventsSubscribed = false;
        return;
      case "subscribe-metrics": {
        session.metricsSubscribed = true;
        this.send(session, {
          type: "metrics",
          protocolVersion: PROTOCOL_VERSION,
          series: this.activity?.metrics.snapshot() ?? [],
        });
        return;
      }
      case "unsubscribe-metrics":
        session.metricsSubscribed = false;
        return;
      case "subscribe-signals": {
        session.signalsSubscribed = true;
        this.send(session, {
          type: "signals",
          protocolVersion: PROTOCOL_VERSION,
          series: this.activity?.signals?.snapshot() ?? [],
        });
        return;
      }
      case "unsubscribe-signals":
        session.signalsSubscribed = false;
        return;
      case "subscribe-attributes": {
        session.attributesSubscribed = true;
        this.send(session, {
          type: "attributes",
          protocolVersion: PROTOCOL_VERSION,
          components: this.activity?.attributes?.snapshot() ?? [],
        });
        return;
      }
      case "unsubscribe-attributes":
        session.attributesSubscribed = false;
        return;
      case "subscribe-alarms": {
        session.alarmsSubscribed = true;
        this.send(session, {
          type: "alarms",
          protocolVersion: PROTOCOL_VERSION,
          snapshot: this.activity?.alarms?.snapshot() ?? EMPTY_ALARM_SNAPSHOT,
        });
        return;
      }
      case "unsubscribe-alarms":
        session.alarmsSubscribed = false;
        return;
      case "ack-alarm":
        // Ack toggles console-side state; the tracker's onUpdate re-pushes the fresh
        // `alarms` snapshot to every subscribed client (no direct reply needed).
        this.activity?.alarms?.ack(msg.alarmId);
        return;
      case "invoke-command":
        this.onInvokeCommand(session, msg);
        return;
    }
  }

  /**
   * A C4 `invoke-command`: RBAC + site-bus request/reply through the injected
   * {@link CommandGateway}, answered with exactly one `command-result` correlated by
   * `requestId`. Concurrency isolation: each invoke is an independent promise; the result
   * is delivered only if the SAME session is still connected when it settles (a command
   * whose client disconnected mid-flight is dropped, never sent to a stale/reused
   * transport). Without the command seam the frame is answered UNAVAILABLE honestly.
   */
  private onInvokeCommand(
    session: Session,
    msg: Extract<ClientMessage, { type: "invoke-command" }>,
  ): void {
    const { requestId, key, verb } = msg;
    if (this.command === undefined) {
      this.send(session, {
        type: "command-result",
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        key,
        verb,
        ok: false,
        error: { code: "UNAVAILABLE", message: "the console command gateway is not configured" },
        elapsedMs: 0,
      });
      return;
    }
    session.pendingCommands.add(requestId);
    void this.command.gateway
      .invoke({ requestId, key, verb, ...(msg.args !== undefined ? { args: msg.args } : {}) }, session.role)
      .then((result) => this.deliverCommandResult(session, result))
      .catch((e) => {
        // CommandGateway.invoke never throws by contract; this guards a broken injected
        // request fn — surface it as a REQUEST_FAILED result rather than an unhandled
        // rejection, so the client's pending command still settles.
        logger.warn(`edge-console ws: command invoke for ${requestId} threw: ${String(e)}`);
        this.deliverCommandResult(session, {
          requestId,
          key,
          verb,
          ok: false,
          error: { code: "REQUEST_FAILED", message: String(e) },
          elapsedMs: 0,
        });
      });
  }

  /** Deliver a settled command result iff its originating session is still connected. */
  private deliverCommandResult(session: Session, result: CommandResultData): void {
    session.pendingCommands.delete(result.requestId);
    // The session may have closed (onClose deletes it) or the transport been reused — only
    // deliver to the live, same session.
    if (this.sessions.get(session.transport.id) !== session) return;
    this.send(session, {
      type: "command-result",
      protocolVersion: PROTOCOL_VERSION,
      requestId: result.requestId,
      key: result.key,
      verb: result.verb,
      ok: result.ok,
      ...(result.ok ? { result: result.result } : {}),
      ...(!result.ok && result.error !== undefined ? { error: result.error } : {}),
      elapsedMs: result.elapsedMs,
    });
  }

  /** A fresh `evt` arrival: stream to every ready, event-subscribed client. */
  private pushEvent(event: ConsoleEvent): void {
    let encoded: string | undefined;
    for (const session of [...this.sessions.values()]) {
      if (!session.ready || !session.eventsSubscribed) continue;
      encoded ??= JSON.stringify({
        type: "event",
        protocolVersion: PROTOCOL_VERSION,
        event,
      } satisfies ServerMessage);
      this.sendEncoded(session, encoded);
    }
  }

  /** A fresh metric sample batch: push to every ready, metric-subscribed client. */
  private pushMetricUpdates(updates: MetricSeriesUpdate[]): void {
    let encoded: string | undefined;
    for (const session of [...this.sessions.values()]) {
      if (!session.ready || !session.metricsSubscribed) continue;
      encoded ??= JSON.stringify({
        type: "metric",
        protocolVersion: PROTOCOL_VERSION,
        updates,
      } satisfies ServerMessage);
      this.sendEncoded(session, encoded);
    }
  }

  /** A fresh signal sample batch (R0 data plane): push to every signal-subscribed client. */
  private pushSignalUpdates(updates: SignalSeriesUpdate[]): void {
    let encoded: string | undefined;
    for (const session of [...this.sessions.values()]) {
      if (!session.ready || !session.signalsSubscribed) continue;
      encoded ??= JSON.stringify({
        type: "signal",
        protocolVersion: PROTOCOL_VERSION,
        updates,
      } satisfies ServerMessage);
      this.sendEncoded(session, encoded);
    }
  }

  /** A fresh runtime-attribute batch (R0): push to every attribute-subscribed client. */
  private pushAttributeUpdates(updates: RuntimeAttributes[]): void {
    let encoded: string | undefined;
    for (const session of [...this.sessions.values()]) {
      if (!session.ready || !session.attributesSubscribed) continue;
      encoded ??= JSON.stringify({
        type: "attribute",
        protocolVersion: PROTOCOL_VERSION,
        updates,
      } satisfies ServerMessage);
      this.sendEncoded(session, encoded);
    }
  }

  /** A fresh alarm snapshot (R0): replace-push to every alarm-subscribed client. */
  private pushAlarms(snapshot: AlarmSnapshot): void {
    let encoded: string | undefined;
    for (const session of [...this.sessions.values()]) {
      if (!session.ready || !session.alarmsSubscribed) continue;
      encoded ??= JSON.stringify({
        type: "alarms",
        protocolVersion: PROTOCOL_VERSION,
        snapshot,
      } satisfies ServerMessage);
      this.sendEncoded(session, encoded);
    }
  }

  /** A fresh retained cfg: push to every ready client that requested this key. */
  private pushConfig(entry: StoredConfig): void {
    const id = componentKeyId(entry.key);
    let encoded: string | undefined;
    for (const session of [...this.sessions.values()]) {
      if (!session.ready || !session.configKeys.has(id)) continue;
      encoded ??= JSON.stringify(configMessage(entry));
      this.sendEncoded(session, encoded);
    }
  }

  /** Snapshot-then-deltas entry point: either resume (deltas only) or a fresh snapshot. */
  private resync(session: Session, resumeSeq: number | undefined): void {
    if (resumeSeq !== undefined) {
      const current = this.source.snapshot();
      if (resumeSeq <= current.seq) {
        const deltas = this.buffer.since(resumeSeq);
        if (deltas !== undefined) {
          if (deltas.length > 0) {
            this.send(session, { type: "delta", protocolVersion: PROTOCOL_VERSION, deltas });
          }
          return; // resumed - no snapshot needed, live delta pushes continue as normal
        }
      }
      // Gap (evicted range) or resumeSeq ahead of the server (stale/uncertain client
      // state) - fall through to a fresh snapshot rather than guess.
    }
    this.send(session, {
      type: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      snapshot: this.source.snapshot(),
    });
  }

  /** The FleetModel's delta-batch listener: buffer for resume, then fan out to every ready client. */
  private onDeltas(deltas: FleetDelta[]): void {
    for (const delta of deltas) this.buffer.push(delta);
    if (this.sessions.size === 0) return;

    // Serialize once and reuse for every unblocked client - fanout is O(clients), not
    // O(clients x json-size).
    const encoded = JSON.stringify({
      type: "delta",
      protocolVersion: PROTOCOL_VERSION,
      deltas,
    } satisfies ServerMessage);

    for (const session of [...this.sessions.values()]) {
      if (!session.ready) continue; // pre-hello clients get nothing but the hello-timeout eviction
      if (session.transport.bufferedAmount() > this.opts.maxBufferedBytes) {
        session.missedPushes++;
        if (session.missedPushes > this.opts.maxMissedPushes) {
          // Drop-to-resnapshot: give up on the missed deltas and resync from a clean
          // snapshot rather than let a slow reader's queue grow unbounded.
          session.missedPushes = 0;
          this.send(session, {
            type: "snapshot",
            protocolVersion: PROTOCOL_VERSION,
            snapshot: this.source.snapshot(),
          });
        }
        continue; // isolation: this client's backlog never delays the others below
      }
      session.missedPushes = 0;
      this.sendEncoded(session, encoded);
    }
  }

  private reject(session: Session, code: WsErrorCode, message: string): void {
    this.send(session, { type: "error", protocolVersion: PROTOCOL_VERSION, code, message });
    session.transport.close(4000, message);
    this.sessions.delete(session.transport.id);
  }

  private send(session: Session, msg: ServerMessage): void {
    this.sendEncoded(session, JSON.stringify(msg));
  }

  private sendEncoded(session: Session, encoded: string): void {
    try {
      session.transport.send(encoded);
    } catch (e) {
      // The transport is already gone; its own close/error handling will call
      // ClientSession.onClose(). Never let one client's send failure affect the others.
      logger.warn(`edge-console ws: send to ${session.transport.id} failed: ${String(e)}`);
    }
  }
}

/** The `config` frame for one retained entry (body verbatim — already lib-redacted). */
function configMessage(entry: StoredConfig): ServerMessage {
  return {
    type: "config",
    protocolVersion: PROTOCOL_VERSION,
    key: entry.key,
    cfg: entry.body,
    receivedAt: entry.receivedAt,
    ...(entry.sourceTimestamp !== undefined ? { sourceTimestamp: entry.sourceTimestamp } : {}),
  };
}
