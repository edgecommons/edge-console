/**
 * Edge Console protocol — the shared type contract between the server and the UI.
 *
 * These shapes travel two seams:
 *  1. server-internal: the FleetModel's snapshot API + delta event stream (slice C1);
 *  2. the WS gateway's snapshot-then-deltas frames (slice C2), which reuse the same
 *     `FleetSnapshot`/`FleetDelta` types verbatim so no re-mapping layer exists.
 *
 * Grammar/source-of-truth: `docs/UNS-RECONCILIATION-AND-PHASE1-PLAN.md` (the
 * reconciliation of DESIGN.md v0.3 against the shipped UNS core) — topics are
 * `ecv1/{device}/{component}/{instance}/{class}[/channel…]`, identity is the
 * top-level envelope `identity` element (`{hier, path, component, instance}`,
 * device = last `hier` value), and the six consumer classes are the console's
 * whole subscription surface.
 */

/**
 * Protocol version stamped into every WS frame (bumped on breaking changes).
 * v2 (slice C5): the config-review message family — client `get-config`/
 * `refresh-config`, server `config`/`config-unavailable`. Breaking because a v1
 * gateway rejects-and-closes on the new client frames; the exact-match version
 * handshake turns that skew into a clean "reload the page" instead.
 * v3 (slice C6): the activity message family — client `subscribe-events`/
 * `unsubscribe-events`/`subscribe-metrics`/`unsubscribe-metrics`, server
 * `events`/`event`/`metrics`/`metric`. Breaking for the same reason as v2: a
 * v2 gateway rejects-and-closes on the new client frames.
 * v4 (slice C4): the command message family — client `invoke-command`, server
 * `command-result`. The console's first WRITE surface: the browser asks the gateway
 * to invoke a UNS command verb on a target component; the gateway issues a
 * `messaging().request()` to the component's `cmd` inbox on the site bus (the bridge
 * rewrites `reply_to` transparently) and returns the reply as a `command-result`.
 * Breaking for the same reason as v2/v3: a v3 gateway rejects-and-closes on the new
 * client frame.
 * v5 (slice R0, the data + shell foundation): four additive surfaces the realigned
 * screens (R1-R6) consume, plus the account-role handshake.
 *  - the DATA-plane `signals` family — client `subscribe-signals`/`unsubscribe-signals`,
 *    server `signals`/`signal` (the UNS `data` class, which was ingested then discarded);
 *  - the management-plane runtime `attributes` family — client `subscribe-attributes`/
 *    `unsubscribe-attributes`, server `attributes`/`attribute` (latest `sys.*` cpu/mem/
 *    threads + adapter `southbound_health` connection state, projected off the metric class);
 *  - the console-side `alarms` family — client `subscribe-alarms`/`unsubscribe-alarms`/
 *    `ack-alarm`, server `alarms` (an `evt`-driven raise/clear alarm state machine with
 *    device-UNREACHABLE containment and console-side ack);
 *  - the `welcome` server frame (the connection's resolved RBAC role, sent right after a
 *    valid `hello`) — the account indicator's data source;
 *  - `component-discovered` deltas now carry `hier` (the full identity hierarchy), so a
 *    late-discovered component groups dynamically without waiting for the next snapshot.
 * Breaking for the same reason as v2/v3/v4: a v4 gateway rejects-and-closes on the new
 * client frames, and the exact-match version handshake turns the skew into a clean reload.
 *
 * R6 (the Settings screen) adds NO new client frame and one purely-additive server frame
 * (`settings`, pushed after `welcome`) — so it does NOT bump the version, on the same
 * additive precedent as the `self`/`busMsgsPerSec` heartbeat fields: an old client ignores
 * the unknown `settings` frame, and a new client against an old gateway simply never
 * receives it (the view degrades honestly).
 */
export const PROTOCOL_VERSION = 5;

/**
 * The six UNS classes a fleet consumer subscribes (`ecv1/+/+/+/{cls}` wildcards).
 * `cmd` is published (never subscribed) and `app` is not consumed — per the plan §3.
 */
export type ConsumerClass = "state" | "cfg" | "evt" | "metric" | "data" | "log";

/** The consumer classes in canonical subscription order. */
export const CONSUMER_CLASSES: readonly ConsumerClass[] = [
  "state",
  "cfg",
  "evt",
  "metric",
  "data",
  "log",
];

/** One level of the UNS enterprise hierarchy (wire shape of `identity.hier[]`). */
export interface WireHierLevel {
  level: string;
  value: string;
}

/**
 * The wire shape of the top-level UNS `identity` envelope element. `device` is NOT a
 * wire field — it is the last `hier` entry's value (computed, per D-U/G11).
 */
export interface WireIdentity {
  hier: WireHierLevel[];
  path: string;
  component: string;
  instance: string;
}

/** The FleetModel's component key: `(device, component, instance)`. */
export interface ComponentKey {
  device: string;
  component: string;
  instance: string;
}

/** Canonical string form of a {@link ComponentKey} (map keys, WS frame targets). */
export function componentKeyId(key: ComponentKey): string {
  return `${key.device}/${key.component}/${key.instance}`;
}

/**
 * Per-component liveness, from the console-side miss-detection state machine
 * (DESIGN §6.2, reconciliation G4/G5):
 *  - `FRESH`       — last `state` keepalive within 2 x the expected interval;
 *  - `WARN`        — overdue past 2 x (the "warn shading" band);
 *  - `STALE`       — overdue past 2.5 x;
 *  - `OFFLINE`     — overdue past 5 x (miss-detection's "missing");
 *  - `STOPPED`     — the component reported a graceful `{"status":"STOPPED"}` state
 *                    (held until the next RUNNING state — no staleness decay);
 *  - `UNREACHABLE` — whole-device containment from the bridge's raw LWT
 *                    (`{"status":"UNREACHABLE"}`); overlays every component on the
 *                    device until the next `state` envelope arrives from it.
 */
export type Liveness = "FRESH" | "WARN" | "STALE" | "OFFLINE" | "STOPPED" | "UNREACHABLE";

/** Where a component's expected keepalive interval came from (reconciliation G4/Q3). */
export type CadenceSource = "default" | "cfg";

/**
 * One timestamped last-known value — the FleetModel cache entry that replaces broker
 * retain (DESIGN §6.1/§6.4): a late joiner gets the current value immediately AND its
 * age. Keyed by `(component key, class[, channel])`.
 */
export interface CachedValue {
  cls: ConsumerClass;
  /** `/`-joined channel tokens; absent for the leaf classes (`state`, `cfg`). */
  channel?: string;
  /** The envelope body (already lib-redacted for `cfg`). */
  body: unknown;
  /** Envelope tags, verbatim. `_`-prefixed keys are system-reserved (e.g. `_relay`) — never business context. */
  tags?: Record<string, unknown>;
  /** Console receipt time (ms epoch) — the authoritative LKV timestamp (event-time on the raw-LWT path too). */
  receivedAt: number;
  /** The publisher's `header.timestamp` claim, when present (display only — never drives staleness). */
  sourceTimestamp?: string;
}

/** A component's slice of a {@link FleetSnapshot}. */
export interface ComponentSnapshot {
  key: ComponentKey;
  /** The `identity.path` (full hierarchy join) — the tree/grouping key for the UI. */
  path: string;
  /** The full hierarchy, for N-level rollups (site/area/line/... views). */
  hier: WireHierLevel[];
  /** Effective liveness (device UNREACHABLE overlays the staleness ladder). */
  liveness: Liveness;
  /** Last reported `state.status` (`RUNNING`/`STOPPED`), if any state arrived yet. */
  status?: string;
  /** Last reported `state.uptimeSecs` (restart detection = a decrease). */
  uptimeSecs?: number;
  /** Receipt time of the last `state` keepalive (ms epoch). */
  lastStateAt?: number;
  /** The expected keepalive interval (seconds) driving miss-detection. */
  expectedIntervalSecs: number;
  /** Whether the interval is the 5 s default or derived from the component's `cfg`. */
  cadenceSource: CadenceSource;
  /** Observed restarts (uptimeSecs resets). */
  restarts: number;
  /** Every cached last-known value (state/cfg/evt/metric/data/log, per channel). */
  values: CachedValue[];
  /** Distinct channels dropped by the per-component channel cap (cache overflow guard). */
  droppedChannels: number;
}

/** A device's slice of a {@link FleetSnapshot}. */
export interface DeviceSnapshot {
  device: string;
  /** Whole-device UNREACHABLE (bridge LWT) — terminal until the next `state` envelope from the device. */
  unreachable: boolean;
  /** When the device became unreachable (ms epoch), while `unreachable` is true. */
  unreachableSince?: number;
  components: ComponentSnapshot[];
}

/**
 * A consistent point-in-time view of the fleet. `seq` is the last delta sequence
 * number folded into this snapshot: a C2 client applies only deltas with
 * `seq > snapshot.seq` (the snapshot-then-deltas rule — no client assembles state
 * from deltas alone).
 */
export interface FleetSnapshot {
  seq: number;
  takenAt: number;
  devices: DeviceSnapshot[];
}

/**
 * The FleetModel's change events — the delta stream behind the C2 WS fan-out and the
 * alarm/event surfaces. Every delta carries a monotonic `seq` and the model-clock
 * timestamp `at` (ms epoch).
 */
export type FleetDelta =
  | { type: "device-discovered"; seq: number; at: number; device: string }
  | {
      type: "component-discovered";
      seq: number;
      at: number;
      key: ComponentKey;
      path: string;
      /** The full identity hierarchy (`[{level,value}]`, last = device) — dynamic grouping without a snapshot. */
      hier: WireHierLevel[];
    }
  | {
      type: "value-updated";
      seq: number;
      at: number;
      key: ComponentKey;
      cls: ConsumerClass;
      channel?: string;
    }
  | {
      type: "liveness-changed";
      seq: number;
      at: number;
      key: ComponentKey;
      from: Liveness;
      to: Liveness;
    }
  | {
      type: "component-restarted";
      seq: number;
      at: number;
      key: ComponentKey;
      previousUptimeSecs: number;
      uptimeSecs: number;
    }
  | {
      type: "device-reachability-changed";
      seq: number;
      at: number;
      device: string;
      unreachable: boolean;
      /** How many components the transition contained/released (the "+N suppressed" rollup). */
      componentCount: number;
    };

/* -----------------------------------------------------------------------------
 * C6 — events & metrics: the two consumer classes whose BODIES the console serves
 * (the liveness stream deliberately carries none — same finding as `cfg`/C5).
 *
 * `evt` = discrete component notifications. The wire convention is
 * `evt/{severity}/{type}` (UNS-CANONICAL §4.3, e.g. `evt/critical/overtemp`), but
 * the class is OPEN — any channel shape is accepted and split leniently. The console
 * keeps a bounded rolling recent-history (newest-first) and STREAMS arrivals to
 * subscribed clients (notifications fit subscribe/stream, not request/response).
 *
 * `metric` = numeric measures on `metric/{name}`. The body is typically the
 * library's EMF object (measure values flattened to the top level next to string
 * dimensions and the `_aws` metadata block), but any body with top-level finite
 * numbers — or a bare number — folds. The console keeps the latest value plus a
 * small bounded recent series per (component, metric, measure) and serves
 * snapshot-then-updates to subscribed clients.
 * --------------------------------------------------------------------------- */

/**
 * One component event as the console holds it: the `evt` envelope body plus the
 * console's attribution/severity split and receipt stamp.
 */
export interface ConsoleEvent {
  /**
   * Monotonic server-assigned id (arrival order; React keys; live-append dedup).
   * Restarts with the console process — a fresh `events` backlog resets clients.
   */
  id: number;
  key: ComponentKey;
  /**
   * The severity token — the first channel token when the channel follows the
   * `evt/{severity}/{type}` convention. Verbatim (the UI classifies it); absent
   * when the channel carried no severity position.
   */
  severity?: string;
  /** The event type/name — the channel remainder (see {@link splitEventChannel}). */
  type: string;
  /** The full channel verbatim, when present (diagnostics). */
  channel?: string;
  /** The envelope body verbatim — the event detail. */
  body: unknown;
  /** Envelope tags, verbatim (`_`-prefixed keys are system-reserved). */
  tags?: Record<string, unknown>;
  /** Console receipt time (server-clock ms epoch). */
  receivedAt: number;
  /** The publisher's `header.timestamp` claim, when present (display only). */
  sourceTimestamp?: string;
}

/** The canonical severity buckets the console renders (raw tokens are classified). */
export type EventSeverityLevel = "critical" | "error" | "warning" | "info" | "debug";

/** Raw severity token -> canonical bucket (lenient synonym map). */
const SEVERITY_SYNONYMS: Record<string, EventSeverityLevel> = {
  critical: "critical",
  crit: "critical",
  fatal: "critical",
  emergency: "critical",
  alert: "critical",
  error: "error",
  err: "error",
  warning: "warning",
  warn: "warning",
  info: "info",
  notice: "info",
  debug: "debug",
  trace: "debug",
};

/**
 * Classify a raw severity token into a canonical bucket, or `undefined` for an
 * unknown/absent token (rendered neutrally — the class is open, never rejected).
 */
export function classifyEventSeverity(severity: string | undefined): EventSeverityLevel | undefined {
  if (severity === undefined) return undefined;
  return SEVERITY_SYNONYMS[severity.toLowerCase()];
}

/** The label shown for an event whose channel carried no type token. */
export const UNNAMED_EVENT_TYPE = "(unnamed)";

/**
 * Split an `evt` channel into `{severity?, type}` per the `evt/{severity}/{type}`
 * convention, leniently: with two or more tokens the first is the severity position
 * (verbatim, even if unrecognized) and the rest join as the type; a single token is
 * a severity iff it classifies as one (`evt/critical`), otherwise a bare type
 * (`evt/overtemp`); no channel at all yields the {@link UNNAMED_EVENT_TYPE} type.
 */
export function splitEventChannel(channel: string | undefined): {
  severity?: string;
  type: string;
} {
  if (channel === undefined || channel === "") return { type: UNNAMED_EVENT_TYPE };
  const tokens = channel.split("/");
  if (tokens.length === 1) {
    const token = tokens[0]!;
    return classifyEventSeverity(token) !== undefined
      ? { severity: token, type: UNNAMED_EVENT_TYPE }
      : { type: token };
  }
  return { severity: tokens[0]!, type: tokens.slice(1).join("/") };
}

/** One sample of a metric series (server-clock ms + the measure's numeric value). */
export interface MetricPoint {
  at: number;
  value: number;
}

/**
 * The bound both sides keep per metric series (points, drop-oldest). Shared so the
 * client's fold mirrors the server's retention exactly.
 */
export const DEFAULT_METRIC_SERIES_POINTS = 60;

/**
 * One (component, metric, measure) series as the `metrics` snapshot carries it:
 * the latest value plus the bounded recent series (ascending time, newest last —
 * `points` always includes the latest sample).
 */
export interface MetricSeriesSnapshot {
  key: ComponentKey;
  /** The UNS metric name — the channel under `metric/` (may itself contain `/`). */
  metric: string;
  /** The numeric field within the metric body (`"value"` for bare-number bodies). */
  measure: string;
  latest: number;
  /** Console receipt time of the latest sample (server-clock ms epoch). */
  receivedAt: number;
  /** The publisher's `header.timestamp` claim on the latest sample, when present. */
  sourceTimestamp?: string;
  points: MetricPoint[];
}

/**
 * One fresh sample for a series (a live `metric` push): the client appends it to
 * its bounded series (or starts a new one), latest-wins.
 */
export interface MetricSeriesUpdate {
  key: ComponentKey;
  metric: string;
  measure: string;
  point: MetricPoint;
  sourceTimestamp?: string;
}

/* -----------------------------------------------------------------------------
 * R0 — the DATA plane: the `signals` family (the UNS `data` class).
 *
 * The `data` class carries telemetry / business SIGNALS on `data/{signal}` — the ONE
 * class the corrected framing calls the "data plane" (everything else is management/
 * control plane). The uns-bridge already delivers it and the FleetModel already caches
 * the latest value, but nothing surfaced it: R0 adds a SignalStore (latest value +
 * quality + a small bounded recent series per `(component, signal)`) with a
 * subscribe/snapshot surface mirroring the C6 metric family, so the future Signals
 * screen (R5) has its data.
 *
 * A signal body follows the `SouthboundSignalUpdate` contract when it is an object
 * (`{value, quality}`), but the class is OPEN: a bare scalar body folds as the value
 * with no quality. {@link extractSignalSample} is the lenient split.
 * --------------------------------------------------------------------------- */

/** The recent-series bound both sides keep per signal (points, drop-oldest). */
export const DEFAULT_SIGNAL_SERIES_POINTS = 60;

/** One sample of a signal series (server-clock ms + the value + optional quality). */
export interface SignalPoint {
  at: number;
  /** The signal value verbatim (scalar or the whole body — the class is open). */
  value: unknown;
  /** Data-quality token (`GOOD`/`UNCERTAIN`/`BAD`) when the body carried one. */
  quality?: string;
}

/**
 * One `(component, signal)` series as the `signals` snapshot carries it: the latest
 * value + quality plus the bounded recent series (ascending time, newest last).
 */
export interface SignalSeriesSnapshot {
  key: ComponentKey;
  /** The UNS signal name — the channel under `data/` (may itself contain `/`). */
  signal: string;
  latest: unknown;
  /** Latest data-quality token, when present. */
  quality?: string;
  /** Console receipt time of the latest sample (server-clock ms epoch). */
  receivedAt: number;
  sourceTimestamp?: string;
  points: SignalPoint[];
}

/** One fresh sample for a signal series (a live `signal` push): bounded append, latest-wins. */
export interface SignalSeriesUpdate {
  key: ComponentKey;
  signal: string;
  point: SignalPoint;
  sourceTimestamp?: string;
}

/**
 * Split a `data` body into `{value, quality}` leniently: an object body with a
 * `value` field yields that value (and its `quality` string when present); any other
 * object yields the whole body as the value; a scalar body is the value with no
 * quality. Never throws — the class is open, never rejected.
 */
export function extractSignalSample(body: unknown): { value: unknown; quality?: string } {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const o = body as Record<string, unknown>;
    const value = Object.prototype.hasOwnProperty.call(o, "value") ? o.value : body;
    const quality = typeof o.quality === "string" ? o.quality : undefined;
    return quality !== undefined ? { value, quality } : { value };
  }
  return { value: body };
}

/* -----------------------------------------------------------------------------
 * R0 — runtime ATTRIBUTES (management plane): the latest per-component operational
 * facts the Overview columns (R1) and the Component Detail Health tab (R2) render.
 *
 * These are the `sys.*` heartbeat measures (cpu / memory / threads / fds) plus the
 * adapter `southbound_health` connection state (`connectionState` + `readErrors` /
 * `writeErrors`) — a PROJECTION over the same `metric`-class ingest that feeds the
 * MetricStore (repurposed, not a new emission). Every field is optional: a component
 * that never published a given measure simply omits it (the UI shows "—").
 * --------------------------------------------------------------------------- */

/** The latest runtime attributes for one component (all fields optional; latest-wins per field). */
export interface RuntimeAttributes {
  key: ComponentKey;
  /** `sys` cpu measure (percent). */
  cpuPercent?: number;
  /** `sys` memory measure (whatever unit the component emits — MB by convention). */
  memoryMb?: number;
  /** `sys` threads measure. */
  threads?: number;
  /** `sys` open file descriptors measure. */
  fds?: number;
  /** Southbound connection state string (`southbound_health` body `connectionState`). */
  connectionState?: string;
  /** Southbound cumulative read errors. */
  readErrors?: number;
  /** Southbound cumulative write errors. */
  writeErrors?: number;
  /**
   * The publishing component's deployment platform (`HOST`/`GREENGRASS`/`KUBERNETES`), when the
   * component ADVERTISES it via the envelope `tags.platform` metadata (config-driven — the library
   * does not stamp it automatically). Drives the Overview group-row `(HOST)`/`(Greengrass)`
   * annotation (R1); omitted (and honestly blank) when no component on the device advertised it.
   */
  platform?: string;
  /**
   * A small bounded recent CPU-percent series (oldest→newest), accumulated from the `sys` cpu
   * measure — the Overview CPU-cell sparkline (R1). Present only for components that emit `sys`
   * cpu; absent (no sparkline, bare "—"/latest) otherwise.
   */
  cpuSeries?: number[];
  /** Console receipt time of the most recent contributing sample (server-clock ms). */
  receivedAt: number;
  sourceTimestamp?: string;
}

/* -----------------------------------------------------------------------------
 * R1 — the console's OWN self-identity + process vitals + messaging transport.
 *
 * The console IS a ggcommons component: it knows its own resolved identity (device/component),
 * its deployment platform + messaging transport + site-broker host (all from its own runtime
 * config), and can measure its own process (cpu / memory / uptime). This is the honest source
 * behind the Overview "Edge node — console self" tile and the "Edge bus" tile's transport foot
 * (rather than a fabricated string). It rides the low-frequency `heartbeat` (optional/additive —
 * a gateway with no self-monitor simply omits it, and old clients ignore it).
 * --------------------------------------------------------------------------- */

/** The console's own runtime self-identity + process vitals + messaging transport (R1). */
export interface ConsoleSelf {
  /** The console's own node/device name (`identity.device`) — the tile headline (e.g. `gw-dallas-01`). */
  device: string;
  /** The console's component token (`edge-console`). */
  component: string;
  /** Resolved deployment platform (`HOST`/`GREENGRASS`/`KUBERNETES`), when known. */
  platform?: string;
  /** Resolved messaging transport (`MQTT`/`IPC`), when known — the Edge-bus tile foot. */
  transport?: string;
  /** The site-bus broker host (`messaging.local.host`), when known — the Edge-bus tile foot `· <broker>`. */
  broker?: string;
  /** The console process CPU percent (share of one core over the last sample window); absent on the first sample. */
  cpuPercent?: number;
  /** The console process resident memory (MB). */
  memoryMb?: number;
  /** The console process uptime (seconds). */
  uptimeSecs: number;
}

/* -----------------------------------------------------------------------------
 * R6 — the console's OWN effective policy + configuration (the Settings screen).
 *
 * The console read this off its own `component.global.console` subtree at startup
 * (`console-config.ts`), so it can honestly SHOW itself: the RBAC policy that gates the
 * command write-path, the site-bus connection + its WS listener, the miss-detection
 * thresholds, the command deadlines (incl. the bridge reply-map TTL ceiling), and the
 * store-retention caps. This is a READ-ONLY projection — a curated, wire-friendly copy of
 * what the console holds, never the raw config document. It rides its own `settings` frame,
 * pushed right after `welcome` on connect (like `welcome`, server-initiated — no client
 * request); a gateway with no settings source simply omits it and old/new clients that
 * never receive it degrade honestly (the view says "not yet received").
 * --------------------------------------------------------------------------- */

/** One role's verb policy in the {@link ConsoleSettings} projection (order-stable, wire-friendly). */
export interface ConsoleSettingsRole {
  /** The role name (`operator`/`viewer`/…). */
  name: string;
  /** Verbs this role may invoke (`["*"]` = all). */
  allow: string[];
  /** Verbs this role may never invoke (wins over `allow`; `["*"]` = block all). */
  deny: string[];
  /** Whether this is the fallback role assigned to a connection with no resolved principal. */
  isDefault: boolean;
}

/**
 * The console's own effective policy + configuration, as the read-only Settings screen (R6)
 * renders it. Every field is REAL — sourced from the console's resolved runtime config; the
 * connection-identity fields are optional (present only when the console knows them).
 */
export interface ConsoleSettings {
  /** The C4 command authorization policy (`console.rbac`) — roles + per-verb allow/deny. */
  rbac: {
    /** The fallback role assigned to an unauthenticated connection (the auth seam's stub). */
    defaultRole: string;
    /** The declared roles (order-stable), each flagged `isDefault` for the fallback. */
    roles: ConsoleSettingsRole[];
  };
  /** The site-bus connection identity + the console's own WS gateway listener. */
  connection: {
    /** The console's own node/device name (`identity.device`), when known. */
    device?: string;
    /** The console component token (`edge-console`), when known. */
    component?: string;
    /** Resolved deployment platform (`HOST`/`GREENGRASS`/`KUBERNETES`), when known. */
    platform?: string;
    /** Resolved site-bus messaging transport (`MQTT`/`IPC`), when known. */
    transport?: string;
    /** The site-bus broker host (`messaging.local.host`), when known. */
    broker?: string;
    /** The console's WS gateway listen port (`console.ws.port`). */
    wsPort: number;
    /** The console's WS gateway bind address (`console.ws.bindAddress`). */
    wsBindAddress: string;
    /** Server→client heartbeat cadence (ms) (`console.ws.heartbeatIntervalMs`). */
    heartbeatIntervalMs: number;
  };
  /** The miss-detection ladder (`console.staleness`, DESIGN §6.2). */
  staleness: {
    warnMultiplier: number;
    staleMultiplier: number;
    offlineMultiplier: number;
    /** The expected keepalive interval (secs) until a component's `cfg` announces one. */
    defaultIntervalSecs: number;
    /** The liveness sweeper period (ms). */
    sweepIntervalMs: number;
  };
  /** The command-gateway timeout policy (`console.commands`). */
  commands: {
    /** Default per-command deadline (ms) when a verb has no override. */
    defaultTimeoutMs: number;
    /** The hard ceiling — the uns-bridge reply-map TTL (paired-knob rule). */
    maxTimeoutMs: number;
    /** Per-verb deadline overrides (ms), order-stable by verb. */
    verbTimeouts: { verb: string; ms: number }[];
  };
  /** The FleetModel + activity-store retention caps (`console.cache`/`.events`/`.metrics`). */
  retention: {
    /** Max distinct `(class, channel)` cache entries per component (`cache.maxChannelsPerComponent`). */
    maxChannelsPerComponent: number;
    /** Fleet-wide recent-events ring capacity (`events.maxEvents`). */
    maxEvents: number;
    /** Per-component recent-events ring capacity (`events.maxPerComponent`). */
    maxPerComponent: number;
    /** Recent points kept per metric series (`metrics.maxSeriesPoints`). */
    maxSeriesPoints: number;
    /** Max distinct metric series overall (`metrics.maxSeries`). */
    maxSeries: number;
  };
}

/* -----------------------------------------------------------------------------
 * R0 — the console-side ALARM tracker (management plane).
 *
 * The console derives alarms from the `evt` severity stream: a critical/error/warning
 * `evt` RAISES an active alarm keyed by `(component, type)`; a normal-severity (info/
 * debug) follow-up on the same key CLEARS it (into history). `ack` is console-side
 * state. Device UNREACHABLE CONTAINS a device's component alarms — they are suppressed
 * from the active counts ("the road is down, not the houses"), not cleared. This is the
 * data behind the Overview "Active alerts" tile (R1) and the Events & Alarms screen (R4).
 * --------------------------------------------------------------------------- */

/** The severities that RAISE an alarm (everything else clears — the class is open). */
export const ALARMING_SEVERITIES: readonly EventSeverityLevel[] = ["critical", "error", "warning"];

/** Whether a classified severity raises an alarm (vs clears one). */
export function isAlarmingSeverity(level: EventSeverityLevel | undefined): boolean {
  return level !== undefined && ALARMING_SEVERITIES.includes(level);
}

/** One console alarm (active or, with `resolvedAt`, a resolved history entry). */
export interface ConsoleAlarm {
  /** Stable id `${componentId}::${type}` — React keys, ack correlation, live dedup. */
  id: string;
  key: ComponentKey;
  /** Canonical `device/component/instance` id (grouping). */
  componentId: string;
  /** The raising severity (critical/error/warning). */
  severity: EventSeverityLevel;
  /** The event type — the `evt/{severity}/{type}` remainder. */
  type: string;
  /** The latest raising event's `body.message`, when present. */
  message?: string;
  /** Server-clock ms the alarm first became active. */
  raisedAt: number;
  /** Server-clock ms of the most recent raising event. */
  lastAt: number;
  /** Raising events since it became active. */
  count: number;
  /** Console-side acknowledgement (does not clear the alarm). */
  acked: boolean;
  /** Suppressed under an UNREACHABLE device (excluded from active counts). */
  contained: boolean;
  /** Server-clock ms the alarm cleared (present only on history entries). */
  resolvedAt?: number;
  channel?: string;
}

/** The active-alarm rollup (the Overview tile + the notifications badge). */
export interface AlarmCounts {
  /** Active, non-contained critical alarms. */
  critical: number;
  /** Active, non-contained warning + error alarms. */
  warning: number;
  /** Total active, non-contained alarms (the badge count). */
  active: number;
  /** Alarms suppressed under UNREACHABLE devices (the "+N contained" rollup). */
  contained: number;
  /** Active alarms that have been acknowledged. */
  acked: number;
}

/** The alarm surface as the `alarms` frame carries it (active list + counts). */
export interface AlarmSnapshot {
  /** Active alarms (contained ones included, flagged `contained`), newest raise first. */
  active: ConsoleAlarm[];
  counts: AlarmCounts;
}

/* -----------------------------------------------------------------------------
 * C4 — commanding: the console's first WRITE surface (invoke a UNS command verb on a
 * target component). The browser sends `invoke-command`; the gateway RBAC-checks it,
 * issues a `messaging().request()` to the component's own `cmd` inbox
 * (`ecv1/{device}/{component}/{instance}/cmd/{verb}`, `header.name` = verb, body =
 * args), awaits the reply (the uns-bridge rewrites `reply_to` so a site→device
 * request/reply is transparent), and answers with exactly one `command-result`.
 *
 * The built-in verbs every ggcommons component answers (uns-test-vectors/commands.json,
 * DESIGN-uns §9.5): `ping`, `reload-config`, `get-configuration`. Custom-verb DISCOVERY
 * is a Phase-2 concern (the `describe` capability manifest / panels), so the console
 * cannot enumerate a component's custom verbs yet — it offers the built-ins plus a
 * generic verb+args form.
 * --------------------------------------------------------------------------- */

/**
 * A command failure, machine-readable. The `code` is either a CONSOLE-side code
 * ({@link ConsoleCommandErrorCode}) or the COMPONENT's own error code passed through
 * verbatim (e.g. `UNKNOWN_VERB`/`HANDLER_ERROR`/`RELOAD_FAILED`/`NO_CONFIG` from the
 * library `CommandInbox`) — the UI must treat `code` as an opaque string, not a closed
 * enum (only {@link ConsoleCommandErrorCode.FORBIDDEN} drives a distinct UI affordance).
 */
export interface CommandError {
  code: string;
  message: string;
}

/**
 * The error codes the CONSOLE gateway itself synthesizes (never the component's reply):
 *  - `FORBIDDEN` — the connection's RBAC role may not invoke the verb (never hit the bus);
 *  - `TIMEOUT` — no reply within the per-verb deadline (≤ the bridge reply-map TTL);
 *  - `REQUEST_FAILED` — the request could not be issued/awaited (transport/publish error);
 *  - `INVALID_TARGET` — the `(key, verb)` did not form a valid UNS topic (bad token/depth);
 *  - `MALFORMED_REPLY` — a reply arrived whose body was not the `{ok, result|error}` shape;
 *  - `UNAVAILABLE` — the gateway has no command seam wired (no site-bus request path).
 */
export type ConsoleCommandErrorCode =
  | "FORBIDDEN"
  | "TIMEOUT"
  | "REQUEST_FAILED"
  | "INVALID_TARGET"
  | "MALFORMED_REPLY"
  | "UNAVAILABLE";

/** The three universal built-in verbs every ggcommons component answers. */
export const BUILTIN_COMMAND_VERBS = ["ping", "reload-config", "get-configuration"] as const;
export type BuiltinCommandVerb = (typeof BUILTIN_COMMAND_VERBS)[number];

/* -----------------------------------------------------------------------------
 * C2 — the WS gateway wire envelope: snapshot-then-deltas.
 *
 * Every frame in both directions carries `protocolVersion` (= {@link PROTOCOL_VERSION}
 * today) so a version skew between an old browser tab and a redeployed gateway is a
 * clean rejection, never a silent misparse — the seam DESIGN §6.4/reconciliation G2/G13
 * call "keep it versioned". `parseClientMessage` is the sole validator: the gateway
 * accepts nothing it hasn't round-tripped through this function (no partial/lenient
 * acceptance of client input — "correctness over cleverness" applies to the wire edge
 * too, unlike the config parsers' deliberate leniency).
 * --------------------------------------------------------------------------- */

/** Machine-readable error codes the C2 gateway can send back on a rejected frame. */
export type WsErrorCode = "malformed" | "unsupported-protocol-version";

/**
 * Client -> server frames.
 *  - `hello` — the mandatory FIRST frame on every connection (including reconnects);
 *    `resumeSeq`, when present, is the last {@link FleetDelta.seq} the client applied
 *    in a prior session — the resume attempt (§ below). Omit it for a fresh connection
 *    (always yields a snapshot).
 *  - `get-config` (C5) — request the named component's latest retained `cfg` body (the
 *    redacted effective config its library publisher pushed). The gateway answers with
 *    exactly one `config` or `config-unavailable`, and additionally registers the
 *    client's INTEREST in that key: every later `cfg` arrival for it is pushed as a
 *    fresh `config` frame for the life of the connection (interest does not survive
 *    reconnects — the client re-requests after its next `hello`).
 *  - `refresh-config` (C5) — trigger the per-device `_bcast` `republish-cfg`
 *    broadcast on the site bus, asking every component on `device` to re-push its
 *    `cfg`. Fire-and-forget: no direct reply; the fresh announcements arrive on the
 *    bus and flow to interested clients as `config` pushes. (Whether any component
 *    answers depends on the device-side ggcommons S1 listener — absence is silent,
 *    never an error.)
 *  - `subscribe-events` (C6) — register this connection's interest in the fleet-wide
 *    `evt` stream. The gateway answers with ONE `events` backlog frame (the recent
 *    rolling history, newest-first, optionally capped by `limit`) and then pushes
 *    every later arrival as an `event` frame for the life of the interest.
 *    Interest is per-connection (re-subscribe after reconnect, like `get-config`).
 *  - `unsubscribe-events` (C6) — stop the `event` pushes (e.g. the view unmounted).
 *    No reply; idempotent.
 *  - `subscribe-metrics` (C6) — register interest in the metric surface. The gateway
 *    answers with ONE `metrics` snapshot frame (every known series: latest value +
 *    bounded recent points) and then pushes fresh samples as `metric` frames.
 *  - `unsubscribe-metrics` (C6) — stop the `metric` pushes. No reply; idempotent.
 *  - `invoke-command` (C4) — invoke `verb` (with optional `args`) on the component named
 *    by `key`. `requestId` is a CLIENT-chosen correlation token echoed back on the
 *    matching `command-result`, so a client can have several commands in flight at once
 *    and route each answer. The gateway answers with exactly one `command-result` for
 *    this `requestId` (success, component error, or a console-synthesized
 *    {@link ConsoleCommandErrorCode}). Rides the same one WS connection as everything else.
 */
export type ClientMessage =
  | { type: "hello"; protocolVersion: number; resumeSeq?: number }
  | { type: "get-config"; protocolVersion: number; key: ComponentKey }
  | { type: "refresh-config"; protocolVersion: number; device: string }
  | { type: "subscribe-events"; protocolVersion: number; limit?: number }
  | { type: "unsubscribe-events"; protocolVersion: number }
  | { type: "subscribe-metrics"; protocolVersion: number }
  | { type: "unsubscribe-metrics"; protocolVersion: number }
  | {
      type: "invoke-command";
      protocolVersion: number;
      requestId: string;
      key: ComponentKey;
      verb: string;
      args?: Record<string, unknown>;
    }
  // R0 data-plane signals: snapshot reply + live pushes, per-connection interest (C6 shape).
  | { type: "subscribe-signals"; protocolVersion: number }
  | { type: "unsubscribe-signals"; protocolVersion: number }
  // R0 runtime attributes: snapshot reply + live pushes, per-connection interest.
  | { type: "subscribe-attributes"; protocolVersion: number }
  | { type: "unsubscribe-attributes"; protocolVersion: number }
  // R0 alarms: snapshot reply + live pushes; `ack-alarm` toggles console-side ack.
  | { type: "subscribe-alarms"; protocolVersion: number }
  | { type: "unsubscribe-alarms"; protocolVersion: number }
  | { type: "ack-alarm"; protocolVersion: number; alarmId: string };

/**
 * Server -> client frames.
 *  - `snapshot` — the full {@link FleetSnapshot}; sent on every connect without a
 *    resumable `resumeSeq`, and as the fallback whenever the gateway can't prove
 *    contiguous delta coverage (an old/evicted `resumeSeq`, or a backpressured client
 *    that fell too far behind — "drop-to-resnapshot").
 *  - `delta`  — a batch of {@link FleetDelta}s, always in increasing `seq` order; applied
 *    only once a `snapshot` (or a successful resume) established a `seq` baseline.
 *  - `heartbeat` — periodic liveness/keep-alive; carries the gateway clock as `at`.
 *  - `config` (C5) — one component's latest retained `cfg` envelope body, VERBATIM as
 *    the library publisher pushed it (`{"config": {...}}`, secrets already redacted at
 *    the source). Sent as the reply to `get-config` and pushed on every later `cfg`
 *    arrival for a key the client requested. `receivedAt` is the console's receipt
 *    time (server-clock ms) — the "last received Ns ago" stamp; `sourceTimestamp` is
 *    the publisher's own header claim, display only.
 *  - `config-unavailable` (C5) — the reply to `get-config` when the console holds no
 *    `cfg` for that key (the component never pushed one since the console started, or
 *    it doesn't exist). Not terminal: a later push flips it via a `config` frame.
 *  - `events` (C6) — the reply to `subscribe-events`: the rolling recent history,
 *    NEWEST-FIRST. Replaces whatever event list the client held (the server's ring
 *    is the truth of "recent" — a fresh backlog after reconnect self-heals).
 *  - `event` (C6) — one live `evt` arrival, pushed to every subscribed client. The
 *    monotonic `event.id` dedups the backlog/push seam.
 *  - `metrics` (C6) — the reply to `subscribe-metrics`: every known metric series
 *    (latest + bounded recent points). Replaces the client's metric state.
 *  - `metric` (C6) — fresh samples pushed to subscribed clients; one bus arrival can
 *    carry several measures, hence a batch. The client appends bounded (see
 *    {@link DEFAULT_METRIC_SERIES_POINTS}), starting unseen series from scratch.
 *  - `command-result` (C4) — the single answer to an `invoke-command`, correlated by the
 *    client's `requestId`. `ok` distinguishes success (`result` = the verb's result
 *    object, e.g. ping's `{status, uptimeSecs}`) from failure (`error` = a
 *    {@link CommandError}, the component's own coded error OR a console-synthesized
 *    {@link ConsoleCommandErrorCode}). `elapsedMs` is the gateway-measured round-trip
 *    (0 for a locally-short-circuited FORBIDDEN/UNAVAILABLE). Unlike `error`, this never
 *    closes the connection — a failed command is a normal result.
 *  - `error` — a rejected frame (see {@link WsErrorCode}); the gateway closes the
 *    connection immediately after sending it.
 */
export type ServerMessage =
  | { type: "snapshot"; protocolVersion: number; snapshot: FleetSnapshot }
  | { type: "delta"; protocolVersion: number; deltas: FleetDelta[] }
  // R1 self-surfaces (all optional + additive — a gateway with no meter/monitor omits them and
  // old clients ignore them, so no version bump):
  //  - `busMsgsPerSec`: the console's OWN bus-ingest throughput (rolling msgs/sec) — the "Edge bus"
  //    tile's headline number;
  //  - `busRecentRates`: a bounded ring of recent per-second bus rates (oldest→newest) — the
  //    "Edge bus" tile SPARKLINE;
  //  - `self`: the console's own identity + process vitals + messaging transport — the "Edge node
  //    console self" tile AND the "Edge bus" tile's transport/broker foot.
  | {
      type: "heartbeat";
      protocolVersion: number;
      at: number;
      busMsgsPerSec?: number;
      busRecentRates?: number[];
      self?: ConsoleSelf;
    }
  // R0 welcome: the connection's resolved RBAC role, sent right after a valid `hello`
  // (before the snapshot) — the app-bar account indicator's data source.
  | { type: "welcome"; protocolVersion: number; role: string }
  // R6 settings: the console's own effective policy + configuration, pushed right after
  // `welcome` (server-initiated, no client request) — the read-only Settings screen's source.
  // Optional/additive (a gateway with no settings source omits it; old clients ignore the
  // unknown frame, new clients against an old gateway degrade honestly), so no version bump.
  | { type: "settings"; protocolVersion: number; settings: ConsoleSettings }
  | {
      type: "config";
      protocolVersion: number;
      key: ComponentKey;
      /** The retained `cfg` body, verbatim (lib-redacted: `"***"` values, `$secret` refs untouched). */
      cfg: unknown;
      /** Console receipt time of this cfg (server-clock ms epoch). */
      receivedAt: number;
      /** The publisher's `header.timestamp` claim, when present (display only). */
      sourceTimestamp?: string;
    }
  | { type: "config-unavailable"; protocolVersion: number; key: ComponentKey }
  | { type: "events"; protocolVersion: number; events: ConsoleEvent[] }
  | { type: "event"; protocolVersion: number; event: ConsoleEvent }
  | { type: "metrics"; protocolVersion: number; series: MetricSeriesSnapshot[] }
  | { type: "metric"; protocolVersion: number; updates: MetricSeriesUpdate[] }
  // R0 signals (data plane): the `subscribe-signals` reply (every series) + live pushes.
  | { type: "signals"; protocolVersion: number; series: SignalSeriesSnapshot[] }
  | { type: "signal"; protocolVersion: number; updates: SignalSeriesUpdate[] }
  // R0 runtime attributes: the `subscribe-attributes` reply (every component) + live pushes.
  | { type: "attributes"; protocolVersion: number; components: RuntimeAttributes[] }
  | { type: "attribute"; protocolVersion: number; updates: RuntimeAttributes[] }
  // R0 alarms: the `subscribe-alarms` reply AND every later change (active list + counts).
  // One replace-frame (low volume; ack/containment can move many rows at once).
  | { type: "alarms"; protocolVersion: number; snapshot: AlarmSnapshot }
  | {
      type: "command-result";
      protocolVersion: number;
      requestId: string;
      key: ComponentKey;
      verb: string;
      ok: boolean;
      /** The verb's result object (present iff `ok`). */
      result?: unknown;
      /** The coded failure (present iff `!ok`). */
      error?: CommandError;
      /** Gateway-measured round-trip (ms); 0 for a locally short-circuited failure. */
      elapsedMs: number;
    }
  | { type: "error"; protocolVersion: number; code: WsErrorCode; message: string };

/** The outcome of validating one raw inbound WS text frame. */
export type ParsedClientMessage =
  | { ok: true; message: ClientMessage }
  | { ok: false; reason: string };

/** Whether `value` is a non-null, non-array plain object (a JSON `{}`). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate a wire {@link ComponentKey}: an object with non-empty string
 * `device`/`component`/`instance`. Returns a fresh, extras-stripped copy (never the
 * caller's object) or `undefined`. Exported for the UI client's own frame checks.
 */
export function parseComponentKey(value: unknown): ComponentKey | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const { device, component, instance } = obj;
  if (typeof device !== "string" || device === "") return undefined;
  if (typeof component !== "string" || component === "") return undefined;
  if (typeof instance !== "string" || instance === "") return undefined;
  return { device, component, instance };
}

/**
 * Parse + validate a raw client frame. Pure, no IO — usable by the gateway (to reject)
 * and by the UI client (to construct/self-check outgoing frames) alike. Anything
 * that fails validation is reported as `{ok: false}`; the caller decides the transport
 * consequence (the C2 gateway sends a `WsErrorCode: "malformed"` error and closes).
 * Note: an unsupported `protocolVersion` is NOT a parse failure — the gateway rejects
 * it distinctly (`unsupported-protocol-version`) so a stale tab gets a clear signal.
 */
export function parseClientMessage(raw: string): ParsedClientMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, reason: "frame must be a JSON object" };
  }
  const obj = json as Record<string, unknown>;
  if (typeof obj.protocolVersion !== "number" || !Number.isInteger(obj.protocolVersion)) {
    return { ok: false, reason: "protocolVersion must be an integer" };
  }
  const protocolVersion = obj.protocolVersion;

  switch (obj.type) {
    case "hello": {
      if (obj.resumeSeq !== undefined) {
        if (
          typeof obj.resumeSeq !== "number" ||
          !Number.isInteger(obj.resumeSeq) ||
          obj.resumeSeq < 0
        ) {
          return { ok: false, reason: "resumeSeq must be a non-negative integer" };
        }
      }
      return {
        ok: true,
        message: {
          type: "hello",
          protocolVersion,
          ...(obj.resumeSeq !== undefined ? { resumeSeq: obj.resumeSeq as number } : {}),
        },
      };
    }
    case "get-config": {
      const key = parseComponentKey(obj.key);
      if (key === undefined) {
        return {
          ok: false,
          reason: "get-config key must be {device, component, instance} non-empty strings",
        };
      }
      return { ok: true, message: { type: "get-config", protocolVersion, key } };
    }
    case "refresh-config": {
      if (typeof obj.device !== "string" || obj.device === "") {
        return { ok: false, reason: "refresh-config device must be a non-empty string" };
      }
      return {
        ok: true,
        message: { type: "refresh-config", protocolVersion, device: obj.device },
      };
    }
    case "subscribe-events": {
      if (obj.limit !== undefined) {
        if (typeof obj.limit !== "number" || !Number.isInteger(obj.limit) || obj.limit < 1) {
          return { ok: false, reason: "subscribe-events limit must be a positive integer" };
        }
      }
      return {
        ok: true,
        message: {
          type: "subscribe-events",
          protocolVersion,
          ...(obj.limit !== undefined ? { limit: obj.limit as number } : {}),
        },
      };
    }
    case "unsubscribe-events":
      return { ok: true, message: { type: "unsubscribe-events", protocolVersion } };
    case "subscribe-metrics":
      return { ok: true, message: { type: "subscribe-metrics", protocolVersion } };
    case "unsubscribe-metrics":
      return { ok: true, message: { type: "unsubscribe-metrics", protocolVersion } };
    case "subscribe-signals":
      return { ok: true, message: { type: "subscribe-signals", protocolVersion } };
    case "unsubscribe-signals":
      return { ok: true, message: { type: "unsubscribe-signals", protocolVersion } };
    case "subscribe-attributes":
      return { ok: true, message: { type: "subscribe-attributes", protocolVersion } };
    case "unsubscribe-attributes":
      return { ok: true, message: { type: "unsubscribe-attributes", protocolVersion } };
    case "subscribe-alarms":
      return { ok: true, message: { type: "subscribe-alarms", protocolVersion } };
    case "unsubscribe-alarms":
      return { ok: true, message: { type: "unsubscribe-alarms", protocolVersion } };
    case "ack-alarm": {
      if (typeof obj.alarmId !== "string" || obj.alarmId === "") {
        return { ok: false, reason: "ack-alarm alarmId must be a non-empty string" };
      }
      return { ok: true, message: { type: "ack-alarm", protocolVersion, alarmId: obj.alarmId } };
    }
    case "invoke-command": {
      if (typeof obj.requestId !== "string" || obj.requestId === "") {
        return { ok: false, reason: "invoke-command requestId must be a non-empty string" };
      }
      const key = parseComponentKey(obj.key);
      if (key === undefined) {
        return {
          ok: false,
          reason: "invoke-command key must be {device, component, instance} non-empty strings",
        };
      }
      if (typeof obj.verb !== "string" || obj.verb === "") {
        return { ok: false, reason: "invoke-command verb must be a non-empty string" };
      }
      // args, when present, must be a plain object (the verb's argument bag); the topic
      // and header.name carry the verb — args is the request body. An array/primitive is
      // rejected here rather than silently coerced.
      if (obj.args !== undefined && !isPlainObject(obj.args)) {
        return { ok: false, reason: "invoke-command args, when present, must be a JSON object" };
      }
      return {
        ok: true,
        message: {
          type: "invoke-command",
          protocolVersion,
          requestId: obj.requestId,
          key,
          verb: obj.verb,
          ...(obj.args !== undefined ? { args: obj.args as Record<string, unknown> } : {}),
        },
      };
    }
    default:
      return { ok: false, reason: `unknown message type '${String(obj.type)}'` };
  }
}
