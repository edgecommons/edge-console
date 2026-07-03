/**
 * The FleetModel — the console's pure, timestamped **last-known-value cache** and
 * console-side **miss-detection** engine (DESIGN §6.1/§6.2, reconciliation §3). This
 * is the platform's retain substitute: every cached value carries its receipt
 * timestamp, so a late-joining browser gets the current value immediately AND its age.
 *
 * Pure core (no IO, injected clock): the BusIngress feeds it {@link IngressEvent}s;
 * a 1 s sweeper (owned by the composition root) calls {@link FleetModel.sweep}. It
 * exposes a snapshot API for the future WS gateway (C2) plus a delta event stream —
 * both typed by `@edgecommons/edge-console-protocol`.
 *
 * Liveness (per component, from the `state` keepalive — the backbone):
 *  - cadence is **console-derived** (Q3 decision): expected interval =
 *    `cfg.body.config.heartbeat.intervalSecs` once the component's `cfg` announcement
 *    arrives, default 5 s until then (min 1, lenient numerics like the lib);
 *  - the ladder: FRESH -> WARN (>2x) -> STALE (>2.5x) -> OFFLINE (>5x), tunable;
 *  - restart vs gap: an `uptimeSecs` decrease means restart (G4);
 *  - graceful `{"status":"STOPPED"}` holds STOPPED (no staleness decay) until the
 *    next RUNNING state;
 *  - whole-device UNREACHABLE from the bridge raw LWT (G5): the device subtree is
 *    frozen (sweeper skips it), components report UNREACHABLE by overlay, and the
 *    flag is terminal until the next `state` **envelope** from that device (a state
 *    that arrived at the site broker proves the uplink works again).
 */
import type {
  CachedValue,
  CadenceSource,
  ComponentKey,
  ComponentSnapshot,
  DeviceSnapshot,
  FleetDelta,
  FleetSnapshot,
  Liveness,
  WireHierLevel,
} from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";
import type { EnvelopeEvent, IngressEvent } from "../ingress/normalizer";

/** Milliseconds since the epoch, injectable for tests (DESIGN's "no sleeps" rule). */
export type Clock = () => number;

/** FleetModel tuning — the `component.global.console` staleness + cache knobs. */
export interface FleetModelOptions {
  warnMultiplier: number;
  staleMultiplier: number;
  offlineMultiplier: number;
  defaultIntervalSecs: number;
  maxChannelsPerComponent: number;
}

/** The defaults (DESIGN §6.2 / D5; cadence default per reconciliation G4). */
export const DEFAULT_FLEET_MODEL_OPTIONS: FleetModelOptions = {
  warnMultiplier: 2,
  staleMultiplier: 2.5,
  offlineMultiplier: 5,
  defaultIntervalSecs: 5,
  maxChannelsPerComponent: 1024,
};

/** A delta-batch listener; batches are never empty. */
export type DeltaListener = (deltas: FleetDelta[]) => void;

/** Mutable per-component record. */
interface ComponentRecord {
  key: ComponentKey;
  path: string;
  hier: WireHierLevel[];
  /** Last reported state body `status` (`RUNNING`/`STOPPED`), if any. */
  status?: string;
  uptimeSecs?: number;
  lastStateAt?: number;
  /** Discovery time — the staleness baseline until a first `state` arrives. */
  firstSeenAt: number;
  /** cfg-derived keepalive interval (seconds), once known. */
  intervalSecs?: number;
  cadenceSource: CadenceSource;
  /** The staleness state machine's committed state (UNREACHABLE is a device-level overlay, never stored here). */
  ladder: Exclude<Liveness, "UNREACHABLE">;
  restarts: number;
  /** LKV cache keyed by `cls` or `cls/channel`. */
  values: Map<string, CachedValue>;
  droppedChannels: number;
}

/** Mutable per-device record. */
interface DeviceRecord {
  device: string;
  unreachable: boolean;
  unreachableSince?: number;
  components: Map<string, ComponentRecord>;
}

/** A {@link FleetDelta} before its sequence number is assigned. */
type DeltaSeed = FleetDelta extends infer D ? (D extends FleetDelta ? Omit<D, "seq"> : never) : never;

/** The pure fleet state: LKV cache + liveness machine + snapshot/delta surface. */
export class FleetModel {
  private readonly opts: FleetModelOptions;
  private readonly devicesByName = new Map<string, DeviceRecord>();
  private readonly listeners: DeltaListener[] = [];
  private seq = 0;

  constructor(
    private readonly clock: Clock,
    opts?: Partial<FleetModelOptions>,
  ) {
    this.opts = { ...DEFAULT_FLEET_MODEL_OPTIONS, ...opts };
  }

  /** Register a delta listener; returns the unsubscribe function. */
  onDelta(listener: DeltaListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** The known device names (drives the per-device `republish-*` broadcast set). */
  devices(): string[] {
    return [...this.devicesByName.keys()].sort();
  }

  /**
   * Fold one ingress event into the model. Returns (and notifies listeners with) the
   * resulting deltas, each stamped with a monotonic `seq`.
   */
  ingest(event: IngressEvent): FleetDelta[] {
    const now = this.clock();
    const deltas: FleetDelta[] = [];
    if (event.kind === "device-unreachable") {
      this.applyUnreachable(event.device, now, deltas);
    } else if (event.kind === "envelope") {
      this.applyEnvelope(event, now, deltas);
    }
    // "ignored" events produce no state change (BusIngress logs/counts them).
    this.notify(deltas);
    return deltas;
  }

  /**
   * One miss-detection tick (the composition root runs this every
   * `console.staleness.sweepIntervalMs`): recompute every component's ladder from the
   * age of its last `state` (or its discovery time when none arrived yet — a
   * component that never proves liveness degrades honestly). STOPPED components and
   * UNREACHABLE devices are frozen — those states are explicit truths, not staleness.
   */
  sweep(): FleetDelta[] {
    const now = this.clock();
    const deltas: FleetDelta[] = [];
    for (const device of this.devicesByName.values()) {
      if (device.unreachable) continue;
      for (const comp of device.components.values()) {
        if (comp.ladder === "STOPPED") continue;
        const level = this.ladderFor(comp, now);
        if (level !== comp.ladder) {
          this.push(deltas, {
            type: "liveness-changed",
            at: now,
            key: comp.key,
            from: comp.ladder,
            to: level,
          });
          comp.ladder = level;
        }
      }
    }
    this.notify(deltas);
    return deltas;
  }

  /** A consistent point-in-time snapshot (deterministically ordered). */
  snapshot(): FleetSnapshot {
    const devices: DeviceSnapshot[] = [...this.devicesByName.values()]
      .sort((a, b) => a.device.localeCompare(b.device))
      .map((device) => ({
        device: device.device,
        unreachable: device.unreachable,
        ...(device.unreachable && device.unreachableSince !== undefined
          ? { unreachableSince: device.unreachableSince }
          : {}),
        components: [...device.components.values()]
          .sort((a, b) => componentKeyId(a.key).localeCompare(componentKeyId(b.key)))
          .map((comp) => this.componentSnapshot(device, comp)),
      }));
    return { seq: this.seq, takenAt: this.clock(), devices };
  }

  // ------------------------------------------------------------------ internals

  private componentSnapshot(device: DeviceRecord, comp: ComponentRecord): ComponentSnapshot {
    return {
      key: { ...comp.key },
      path: comp.path,
      hier: comp.hier.map((e) => ({ ...e })),
      // Device UNREACHABLE overlays the component ladder (containment, G5).
      liveness: device.unreachable ? "UNREACHABLE" : comp.ladder,
      ...(comp.status !== undefined ? { status: comp.status } : {}),
      ...(comp.uptimeSecs !== undefined ? { uptimeSecs: comp.uptimeSecs } : {}),
      ...(comp.lastStateAt !== undefined ? { lastStateAt: comp.lastStateAt } : {}),
      expectedIntervalSecs: comp.intervalSecs ?? this.opts.defaultIntervalSecs,
      cadenceSource: comp.cadenceSource,
      restarts: comp.restarts,
      values: [...comp.values.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, v]) => ({ ...v })),
      droppedChannels: comp.droppedChannels,
    };
  }

  /** The staleness ladder for a component at `now` (never STOPPED — callers gate that). */
  private ladderFor(comp: ComponentRecord, now: number): Exclude<Liveness, "UNREACHABLE" | "STOPPED"> {
    const intervalMs = (comp.intervalSecs ?? this.opts.defaultIntervalSecs) * 1000;
    const age = now - (comp.lastStateAt ?? comp.firstSeenAt);
    if (age > this.opts.offlineMultiplier * intervalMs) return "OFFLINE";
    if (age > this.opts.staleMultiplier * intervalMs) return "STALE";
    if (age > this.opts.warnMultiplier * intervalMs) return "WARN";
    return "FRESH";
  }

  private applyUnreachable(deviceName: string, now: number, deltas: FleetDelta[]): void {
    const device = this.ensureDevice(deviceName, now, deltas);
    if (device.unreachable) return; // already contained — idempotent
    device.unreachable = true;
    device.unreachableSince = now;
    this.push(deltas, {
      type: "device-reachability-changed",
      at: now,
      device: deviceName,
      unreachable: true,
      componentCount: device.components.size,
    });
  }

  private applyEnvelope(event: EnvelopeEvent, now: number, deltas: FleetDelta[]): void {
    const last = event.identity.hier[event.identity.hier.length - 1];
    const deviceName = last?.value;
    if (deviceName === undefined || deviceName === "") return; // unattributable — defensive
    const device = this.ensureDevice(deviceName, now, deltas);
    const comp = this.ensureComponent(device, event, now, deltas);

    this.cacheValue(comp, event, now, deltas);

    if (event.cls === "state") {
      this.applyState(device, comp, event, now, deltas);
    } else if (event.cls === "cfg") {
      this.applyCfg(comp, event);
    }
  }

  /** LKV update + `value-updated`, with the per-component distinct-channel cap. */
  private cacheValue(
    comp: ComponentRecord,
    event: EnvelopeEvent,
    now: number,
    deltas: FleetDelta[],
  ): void {
    const key = event.channel !== undefined ? `${event.cls}/${event.channel}` : event.cls;
    if (!comp.values.has(key) && comp.values.size >= this.opts.maxChannelsPerComponent) {
      comp.droppedChannels++;
      return;
    }
    comp.values.set(key, {
      cls: event.cls,
      ...(event.channel !== undefined ? { channel: event.channel } : {}),
      body: event.body,
      ...(event.tags !== undefined ? { tags: event.tags } : {}),
      receivedAt: now,
      ...(event.sourceTimestamp !== undefined ? { sourceTimestamp: event.sourceTimestamp } : {}),
    });
    this.push(deltas, {
      type: "value-updated",
      at: now,
      key: comp.key,
      cls: event.cls,
      ...(event.channel !== undefined ? { channel: event.channel } : {}),
    });
  }

  /**
   * The `state` keepalive: liveness backbone. Also the ONLY signal that clears a
   * device's UNREACHABLE flag — a state envelope from the device proves the uplink
   * relays again (G5 "terminal until the next state").
   */
  private applyState(
    device: DeviceRecord,
    comp: ComponentRecord,
    event: EnvelopeEvent,
    now: number,
    deltas: FleetDelta[],
  ): void {
    if (device.unreachable) {
      device.unreachable = false;
      device.unreachableSince = undefined;
      this.push(deltas, {
        type: "device-reachability-changed",
        at: now,
        device: device.device,
        unreachable: false,
        componentCount: device.components.size,
      });
    }

    const body =
      event.body !== null && typeof event.body === "object" && !Array.isArray(event.body)
        ? (event.body as Record<string, unknown>)
        : {};
    const status = typeof body.status === "string" ? body.status : undefined;
    if (status !== undefined) comp.status = status;

    if (status === "STOPPED") {
      // Graceful stop is an explicit truth: hold STOPPED, no staleness decay.
      this.commitLadder(comp, "STOPPED", now, deltas);
      return;
    }

    // RUNNING (or an unknown status — treat as alive: the keepalive arrived).
    const uptime =
      typeof body.uptimeSecs === "number" && Number.isFinite(body.uptimeSecs)
        ? body.uptimeSecs
        : undefined;
    if (uptime !== undefined) {
      if (comp.uptimeSecs !== undefined && uptime < comp.uptimeSecs) {
        comp.restarts++;
        this.push(deltas, {
          type: "component-restarted",
          at: now,
          key: comp.key,
          previousUptimeSecs: comp.uptimeSecs,
          uptimeSecs: uptime,
        });
      }
      comp.uptimeSecs = uptime;
    }
    comp.lastStateAt = now;
    this.commitLadder(comp, "FRESH", now, deltas);
  }

  /**
   * The `cfg` announcement carries the component's effective config — the console
   * derives the expected keepalive cadence from `config.heartbeat.intervalSecs`
   * (lenient: a missing/invalid value keeps the current cadence; min 1 s, floats
   * truncated — mirroring the lib's own HeartbeatConfig parsing).
   */
  private applyCfg(comp: ComponentRecord, event: EnvelopeEvent): void {
    const body =
      event.body !== null && typeof event.body === "object" && !Array.isArray(event.body)
        ? (event.body as Record<string, unknown>)
        : {};
    const config =
      body.config !== null && typeof body.config === "object" && !Array.isArray(body.config)
        ? (body.config as Record<string, unknown>)
        : {};
    const heartbeat =
      config.heartbeat !== null &&
      typeof config.heartbeat === "object" &&
      !Array.isArray(config.heartbeat)
        ? (config.heartbeat as Record<string, unknown>)
        : {};
    const raw = heartbeat.intervalSecs;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const interval = Math.trunc(raw);
      if (interval >= 1) {
        comp.intervalSecs = interval;
        comp.cadenceSource = "cfg";
      }
    }
  }

  private commitLadder(
    comp: ComponentRecord,
    level: Exclude<Liveness, "UNREACHABLE">,
    now: number,
    deltas: FleetDelta[],
  ): void {
    if (comp.ladder === level) return;
    this.push(deltas, {
      type: "liveness-changed",
      at: now,
      key: comp.key,
      from: comp.ladder,
      to: level,
    });
    comp.ladder = level;
  }

  private ensureDevice(deviceName: string, now: number, deltas: FleetDelta[]): DeviceRecord {
    let device = this.devicesByName.get(deviceName);
    if (device === undefined) {
      device = { device: deviceName, unreachable: false, components: new Map() };
      this.devicesByName.set(deviceName, device);
      this.push(deltas, { type: "device-discovered", at: now, device: deviceName });
    }
    return device;
  }

  private ensureComponent(
    device: DeviceRecord,
    event: EnvelopeEvent,
    now: number,
    deltas: FleetDelta[],
  ): ComponentRecord {
    const key: ComponentKey = {
      device: device.device,
      component: event.identity.component,
      instance: event.identity.instance,
    };
    const id = componentKeyId(key);
    let comp = device.components.get(id);
    if (comp === undefined) {
      comp = {
        key,
        path: event.identity.path,
        hier: event.identity.hier.map((e) => ({ ...e })),
        firstSeenAt: now,
        cadenceSource: "default",
        ladder: "FRESH",
        restarts: 0,
        values: new Map(),
        droppedChannels: 0,
      };
      device.components.set(id, comp);
      this.push(deltas, {
        type: "component-discovered",
        at: now,
        key: { ...key },
        path: comp.path,
      });
    }
    return comp;
  }

  /** Stamp the monotonic sequence number and collect the delta. */
  private push(deltas: FleetDelta[], seed: DeltaSeed): void {
    deltas.push({ ...seed, seq: ++this.seq } as FleetDelta);
  }

  private notify(deltas: FleetDelta[]): void {
    if (deltas.length === 0) return;
    for (const listener of [...this.listeners]) {
      listener(deltas);
    }
  }
}
