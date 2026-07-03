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

/** Protocol version stamped into every C2 WS frame (bumped on breaking changes). */
export const PROTOCOL_VERSION = 1;

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
  | { type: "component-discovered"; seq: number; at: number; key: ComponentKey; path: string }
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
 * Client -> server frames. Only `hello` exists in this slice (C4's command frames land
 * later, as their own union member). A client sends `hello` as its first frame on every
 * connection (including reconnects); `resumeSeq`, when present, is the last
 * {@link FleetDelta.seq} the client applied in a prior session — the resume attempt
 * (§ below). Omit it for a fresh connection (always yields a snapshot).
 */
export type ClientMessage = {
  type: "hello";
  protocolVersion: number;
  resumeSeq?: number;
};

/**
 * Server -> client frames.
 *  - `snapshot` — the full {@link FleetSnapshot}; sent on every connect without a
 *    resumable `resumeSeq`, and as the fallback whenever the gateway can't prove
 *    contiguous delta coverage (an old/evicted `resumeSeq`, or a backpressured client
 *    that fell too far behind — "drop-to-resnapshot").
 *  - `delta`  — a batch of {@link FleetDelta}s, always in increasing `seq` order; applied
 *    only once a `snapshot` (or a successful resume) established a `seq` baseline.
 *  - `heartbeat` — periodic liveness/keep-alive; carries the gateway clock as `at`.
 *  - `error` — a rejected frame (see {@link WsErrorCode}); the gateway closes the
 *    connection immediately after sending it.
 */
export type ServerMessage =
  | { type: "snapshot"; protocolVersion: number; snapshot: FleetSnapshot }
  | { type: "delta"; protocolVersion: number; deltas: FleetDelta[] }
  | { type: "heartbeat"; protocolVersion: number; at: number }
  | { type: "error"; protocolVersion: number; code: WsErrorCode; message: string };

/** The outcome of validating one raw inbound WS text frame. */
export type ParsedClientMessage =
  | { ok: true; message: ClientMessage }
  | { ok: false; reason: string };

/**
 * Parse + validate a raw client frame. Pure, no IO — usable by the gateway (to reject)
 * and by the future UI client (to construct/self-check outgoing frames) alike. Anything
 * that fails validation is reported as `{ok: false}`; the caller decides the transport
 * consequence (the C2 gateway sends a `WsErrorCode: "malformed"` error and closes).
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
  if (obj.type !== "hello") {
    return { ok: false, reason: `unknown message type '${String(obj.type)}'` };
  }
  if (typeof obj.protocolVersion !== "number" || !Number.isInteger(obj.protocolVersion)) {
    return { ok: false, reason: "protocolVersion must be an integer" };
  }
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
      protocolVersion: obj.protocolVersion,
      ...(obj.resumeSeq !== undefined ? { resumeSeq: obj.resumeSeq as number } : {}),
    },
  };
}
