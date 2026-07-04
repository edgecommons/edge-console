/**
 * FleetStore — the browser-side mirror of the server FleetModel (slice C3).
 *
 * PURE fold core, no IO and no clock reads: the {@link FleetClient} (the WS IO shell)
 * feeds it the gateway's snapshot-then-deltas stream, passing the client receipt time
 * in explicitly — the same inject-the-clock discipline the server FleetModel uses, so
 * every fold is deterministic and unit-testable without sockets or sleeps.
 *
 * Folding rules (mirroring `server/src/fleet/fleet-model.ts`):
 *  - `snapshot` replaces the whole store; `snapshot.seq` is the delta baseline.
 *  - deltas are applied strictly in `seq` order: `seq <= lastApplied` is skipped
 *    (idempotent on resume overlap), `seq > lastApplied + 1` is a GAP — the store
 *    stops folding and reports it so the client can resync (reconnect with
 *    `resumeSeq`; the gateway resumes or re-snapshots — correctness over cleverness).
 *  - liveness is SERVER-computed (the console-side miss-detection engine lives in the
 *    FleetModel; its 1 s sweeper emits `liveness-changed` deltas) — the browser never
 *    re-derives the staleness ladder, it just applies transitions. The one exception
 *    is the snapshot-under-outage corner (see below).
 *  - device UNREACHABLE is an overlay, exactly like the server: the per-component
 *    ladder is stored separately and the effective liveness is computed in the view.
 *
 * Two protocol realities this store encodes honestly:
 *  1. `value-updated` deltas carry no body (they are change notifications) — cached
 *     value BODIES refresh only via snapshots. Edge-health needs none of them live
 *     (liveness/uptime/last-seen all travel as dedicated delta fields); the richer
 *     value surfaces (C6 metrics/config screens) will extend the protocol.
 *  2. A snapshot taken while a device is UNREACHABLE hides the underlying ladder
 *     (the server overlays it). The store records those ladders as "unknown" and,
 *     when reachability clears, fills them in with the server's own recompute rule
 *     (STOPPED held; otherwise age-derived from `lastStateAt` using the default D5
 *     multipliers) — any residual divergence self-heals with the server's next
 *     `liveness-changed` delta.
 *
 * Clock skew: all fleet timestamps are SERVER-clock ms. The store maintains
 * `clockOffsetMs = clientReceiptTime - serverFrameTime` (refreshed on every applied
 * frame, heartbeats included) so views can render honest ages on a skewed client.
 */
import type {
  CachedValue,
  CadenceSource,
  ComponentKey,
  ComponentSnapshot,
  InstanceStatus,
  FleetDelta,
  FleetSnapshot,
  Liveness,
  WireHierLevel,
} from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";

/** The staleness ladder thresholds used ONLY for the snapshot-under-outage fill-in. */
export interface LadderOptions {
  warnMultiplier: number;
  staleMultiplier: number;
  offlineMultiplier: number;
  defaultIntervalSecs: number;
}

/** The D5 defaults (mirrors the server's `DEFAULT_FLEET_MODEL_OPTIONS`). */
export const DEFAULT_LADDER_OPTIONS: LadderOptions = {
  warnMultiplier: 2,
  staleMultiplier: 2.5,
  offlineMultiplier: 5,
  defaultIntervalSecs: 5,
};

/** A component in the client store/view. `liveness` is EFFECTIVE (overlay applied). */
export interface ComponentView {
  key: ComponentKey;
  /** Canonical `device/component/instance` id (stable React key). */
  id: string;
  path: string;
  hier: WireHierLevel[];
  liveness: Liveness;
  status?: string;
  /** Last reported uptime (secs) — extrapolate from `uptimeAnchorAt` for display. */
  uptimeSecs?: number;
  /** Server-clock ms when `uptimeSecs` was authoritative (snapshot state / restart). */
  uptimeAnchorAt?: number;
  /** Server-clock ms of the last `state` arrival. */
  lastStateAt?: number;
  /**
   * Per-instance connectivity from the last `state` body's `instances[]` (#1c) — every configured
   * instance (OPC UA server / Modbus slave / file-replicator source dir) with its
   * connected/disconnected status. Absent for single-instance/main-only components.
   */
  instances?: InstanceStatus[];
  expectedIntervalSecs: number;
  cadenceSource: CadenceSource;
  restarts: number;
  /** LKV cache pass-through (bodies refresh via snapshots only — see module doc). */
  values: CachedValue[];
  droppedChannels: number;
}

/** A device in the client view. */
export interface DeviceView {
  device: string;
  unreachable: boolean;
  /** Server-clock ms, present while `unreachable`. */
  unreachableSince?: number;
  components: ComponentView[];
}

/** The immutable derived view handed to React (identity-stable until the next fold). */
export interface FleetView {
  /** Last applied delta seq (the snapshot baseline when no delta arrived yet). */
  seq: number;
  devices: DeviceView[];
  /** `clientReceiptTime - serverFrameTime` (ms): serverTs + offset = client-clock ts. */
  clockOffsetMs: number;
  /** Client-clock ms of the last applied snapshot/delta (not heartbeats). */
  lastUpdatedAt?: number;
}

/** The outcome of folding one delta batch. */
export interface FoldResult {
  /** Number of deltas actually applied (skipped duplicates excluded). */
  applied: number;
  /** True when a seq gap was detected — the caller must resync with the gateway. */
  gap: boolean;
}

/** Mutable per-component record (the store's internal shape). */
interface ComponentState {
  key: ComponentKey;
  id: string;
  path: string;
  hier: WireHierLevel[];
  /**
   * The staleness-machine state, or `undefined` when unknown (snapshot taken under a
   * device outage — the server overlay hid it). Never "UNREACHABLE": that liveness
   * only exists as the device-level overlay, applied in {@link FleetStore.view}.
   */
  ladder?: Exclude<Liveness, "UNREACHABLE">;
  status?: string;
  uptimeSecs?: number;
  uptimeAnchorAt?: number;
  lastStateAt?: number;
  /** Per-instance connectivity from the last `state` body's `instances[]` (#1c), if carried. */
  instances?: InstanceStatus[];
  expectedIntervalSecs: number;
  cadenceSource: CadenceSource;
  restarts: number;
  values: Map<string, CachedValue>;
  droppedChannels: number;
}

interface DeviceState {
  device: string;
  unreachable: boolean;
  unreachableSince?: number;
  components: Map<string, ComponentState>;
}

/**
 * The server's ladder function (fleet-model.ts `ladderFor`), reproduced for the ONE
 * client-side use: filling in ladders hidden by a snapshot-under-outage overlay.
 */
export function ladderForAge(
  ageMs: number,
  intervalSecs: number,
  opts: LadderOptions,
): Exclude<Liveness, "UNREACHABLE" | "STOPPED"> {
  const intervalMs = intervalSecs * 1000;
  if (ageMs > opts.offlineMultiplier * intervalMs) return "OFFLINE";
  if (ageMs > opts.staleMultiplier * intervalMs) return "STALE";
  if (ageMs > opts.warnMultiplier * intervalMs) return "WARN";
  return "FRESH";
}

/** The client-side fleet store: snapshot apply + seq-ordered delta fold + derived view. */
export class FleetStore {
  private readonly opts: LadderOptions;
  private devices = new Map<string, DeviceState>();
  private seq = 0;
  private snapshotApplied = false;
  private clockOffsetMs = 0;
  private lastUpdatedAt: number | undefined;

  /** Version counter + cached view — `view()` is identity-stable between folds. */
  private version = 0;
  private cachedView: FleetView | undefined;
  private cachedVersion = -1;

  constructor(opts?: Partial<LadderOptions>) {
    this.opts = { ...DEFAULT_LADDER_OPTIONS, ...opts };
  }

  /** Whether a snapshot baseline exists (deltas are only foldable after one). */
  hasSnapshot(): boolean {
    return this.snapshotApplied;
  }

  /** The last applied seq — the `resumeSeq` a reconnecting client sends. */
  lastAppliedSeq(): number {
    return this.seq;
  }

  /** Replace the whole store with a gateway snapshot. */
  applySnapshot(snapshot: FleetSnapshot, receivedAt: number): void {
    this.devices = new Map();
    for (const device of snapshot.devices) {
      const components = new Map<string, ComponentState>();
      for (const comp of device.components) {
        components.set(componentKeyId(comp.key), this.componentFromSnapshot(comp));
      }
      this.devices.set(device.device, {
        device: device.device,
        unreachable: device.unreachable,
        ...(device.unreachableSince !== undefined
          ? { unreachableSince: device.unreachableSince }
          : {}),
        components,
      });
    }
    this.seq = snapshot.seq;
    this.snapshotApplied = true;
    this.clockOffsetMs = receivedAt - snapshot.takenAt;
    this.lastUpdatedAt = receivedAt;
    this.bump();
  }

  /**
   * Fold one gateway delta batch in seq order. Duplicates (`seq <= lastApplied`) are
   * skipped; a gap stops the fold and reports `{gap: true}` — the caller resyncs.
   * A batch arriving before any snapshot is itself a gap (no baseline to fold onto).
   */
  applyDeltas(deltas: FleetDelta[], receivedAt: number): FoldResult {
    if (!this.snapshotApplied) return { applied: 0, gap: true };
    let applied = 0;
    let lastAt: number | undefined;
    for (const delta of deltas) {
      if (delta.seq <= this.seq) continue; // resume overlap — already folded
      if (delta.seq !== this.seq + 1) {
        if (applied > 0) this.finishFold(receivedAt, lastAt);
        return { applied, gap: true };
      }
      this.applyDelta(delta);
      this.seq = delta.seq;
      lastAt = delta.at;
      applied++;
    }
    if (applied > 0) this.finishFold(receivedAt, lastAt);
    return { applied, gap: false };
  }

  /** A gateway heartbeat: refreshes the clock-offset estimate (no fleet change). */
  noteHeartbeat(serverAt: number, receivedAt: number): void {
    this.clockOffsetMs = receivedAt - serverAt;
    this.bump();
  }

  /** The immutable derived view (cached; identity changes only when the store does). */
  view(): FleetView {
    if (this.cachedView !== undefined && this.cachedVersion === this.version) {
      return this.cachedView;
    }
    const devices: DeviceView[] = [...this.devices.values()]
      .sort((a, b) => a.device.localeCompare(b.device))
      .map((device) => ({
        device: device.device,
        unreachable: device.unreachable,
        ...(device.unreachable && device.unreachableSince !== undefined
          ? { unreachableSince: device.unreachableSince }
          : {}),
        components: [...device.components.values()]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((comp) => this.componentView(device, comp)),
      }));
    this.cachedView = {
      seq: this.seq,
      devices,
      clockOffsetMs: this.clockOffsetMs,
      ...(this.lastUpdatedAt !== undefined ? { lastUpdatedAt: this.lastUpdatedAt } : {}),
    };
    this.cachedVersion = this.version;
    return this.cachedView;
  }

  // ------------------------------------------------------------------ internals

  private componentFromSnapshot(comp: ComponentSnapshot): ComponentState {
    const values = new Map<string, CachedValue>();
    for (const v of comp.values) {
      // Keyed by source instance too, so per-instance values (filler1 vs kep2) don't collide.
      values.set(
        v.channel !== undefined ? `${v.instance}/${v.cls}/${v.channel}` : `${v.instance}/${v.cls}`,
        { ...v },
      );
    }
    return {
      key: { ...comp.key },
      id: componentKeyId(comp.key),
      path: comp.path,
      hier: comp.hier.map((e) => ({ ...e })),
      // The overlay hides the ladder — record "unknown", fill in when it clears.
      ...(comp.liveness !== "UNREACHABLE" ? { ladder: comp.liveness } : {}),
      ...(comp.status !== undefined ? { status: comp.status } : {}),
      ...(comp.uptimeSecs !== undefined ? { uptimeSecs: comp.uptimeSecs } : {}),
      // uptimeSecs was reported by the state received at lastStateAt — the anchor.
      ...(comp.uptimeSecs !== undefined && comp.lastStateAt !== undefined
        ? { uptimeAnchorAt: comp.lastStateAt }
        : {}),
      ...(comp.lastStateAt !== undefined ? { lastStateAt: comp.lastStateAt } : {}),
      ...(comp.instances !== undefined ? { instances: comp.instances.map((i) => ({ ...i })) } : {}),
      expectedIntervalSecs: comp.expectedIntervalSecs,
      cadenceSource: comp.cadenceSource,
      restarts: comp.restarts,
      values,
      droppedChannels: comp.droppedChannels,
    };
  }

  private componentView(device: DeviceState, comp: ComponentState): ComponentView {
    // Effective liveness: the device overlay wins; an unknown ladder outside an
    // outage window (transient corner) degrades honestly to OFFLINE until a delta.
    const liveness: Liveness = device.unreachable ? "UNREACHABLE" : (comp.ladder ?? "OFFLINE");
    return {
      key: { ...comp.key },
      id: comp.id,
      path: comp.path,
      hier: comp.hier.map((e) => ({ ...e })),
      liveness,
      ...(comp.status !== undefined ? { status: comp.status } : {}),
      ...(comp.uptimeSecs !== undefined ? { uptimeSecs: comp.uptimeSecs } : {}),
      ...(comp.uptimeAnchorAt !== undefined ? { uptimeAnchorAt: comp.uptimeAnchorAt } : {}),
      ...(comp.lastStateAt !== undefined ? { lastStateAt: comp.lastStateAt } : {}),
      ...(comp.instances !== undefined ? { instances: comp.instances.map((i) => ({ ...i })) } : {}),
      expectedIntervalSecs: comp.expectedIntervalSecs,
      cadenceSource: comp.cadenceSource,
      restarts: comp.restarts,
      values: [...comp.values.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, v]) => ({ ...v })),
      droppedChannels: comp.droppedChannels,
    };
  }

  private applyDelta(delta: FleetDelta): void {
    switch (delta.type) {
      case "device-discovered":
        this.ensureDevice(delta.device);
        return;
      case "component-discovered":
        this.ensureComponent(delta.key, delta.path, delta.hier);
        return;
      case "value-updated": {
        const comp = this.ensureComponent(delta.key);
        const key =
          delta.channel !== undefined
            ? `${delta.instance}/${delta.cls}/${delta.channel}`
            : `${delta.instance}/${delta.cls}`;
        const existing = comp.values.get(key);
        // Bodies do not travel in deltas — refresh the timestamp, keep the last body.
        comp.values.set(
          key,
          existing !== undefined
            ? { ...existing, receivedAt: delta.at }
            : {
                instance: delta.instance,
                cls: delta.cls,
                ...(delta.channel !== undefined ? { channel: delta.channel } : {}),
                body: undefined,
                receivedAt: delta.at,
              },
        );
        if (delta.cls === "state") {
          comp.lastStateAt = delta.at;
          // Mirror the server's applyState: every state arrival re-commits FRESH
          // (the server emits a liveness delta only on CHANGE, so a client whose
          // ladder diverged — e.g. the outage fill-in guessed OFFLINE while the
          // server's frozen ladder was FRESH — would otherwise stay wrong forever).
          // Guard STOPPED: when the arriving state IS a graceful stop, the STOPPED
          // transition follows in the same batch and overwrites this; a held
          // STOPPED with no transition stays held, exactly like the server.
          if (comp.ladder !== "STOPPED") comp.ladder = "FRESH";
        }
        return;
      }
      case "liveness-changed": {
        const comp = this.ensureComponent(delta.key);
        if (delta.to !== "UNREACHABLE") comp.ladder = delta.to;
        // The transition implies the state body the client never sees (G4 semantics):
        // STOPPED is only reported by a graceful stop; FRESH only by a RUNNING state.
        if (delta.to === "STOPPED") comp.status = "STOPPED";
        else if (delta.to === "FRESH") comp.status = "RUNNING";
        return;
      }
      case "component-restarted": {
        const comp = this.ensureComponent(delta.key);
        comp.restarts++;
        comp.uptimeSecs = delta.uptimeSecs;
        comp.uptimeAnchorAt = delta.at;
        comp.status = "RUNNING"; // a restart is proven by a RUNNING keepalive
        return;
      }
      case "device-reachability-changed": {
        const device = this.ensureDevice(delta.device);
        device.unreachable = delta.unreachable;
        if (delta.unreachable) {
          device.unreachableSince = delta.at;
        } else {
          device.unreachableSince = undefined;
          this.fillUnknownLadders(device, delta.at);
        }
        return;
      }
    }
  }

  /**
   * The snapshot-under-outage fill-in (module doc, reality #2): when reachability
   * clears, resolve every ladder the overlay hid using the server's own recompute
   * rule — STOPPED is an explicit truth and is held; everything else is age-derived
   * from the last state arrival. A component that never reported a state has no age
   * baseline the client knows (the server uses its private `firstSeenAt`) — degrade
   * to OFFLINE and let the server's next sweep delta correct it if needed.
   */
  private fillUnknownLadders(device: DeviceState, serverNow: number): void {
    for (const comp of device.components.values()) {
      if (comp.ladder !== undefined) continue;
      if (comp.status === "STOPPED") {
        comp.ladder = "STOPPED";
      } else if (comp.lastStateAt !== undefined) {
        comp.ladder = ladderForAge(
          serverNow - comp.lastStateAt,
          comp.expectedIntervalSecs,
          this.opts,
        );
      } else {
        comp.ladder = "OFFLINE";
      }
    }
  }

  private ensureDevice(name: string): DeviceState {
    let device = this.devices.get(name);
    if (device === undefined) {
      device = { device: name, unreachable: false, components: new Map() };
      this.devices.set(name, device);
    }
    return device;
  }

  private ensureComponent(key: ComponentKey, path?: string, hier?: WireHierLevel[]): ComponentState {
    const device = this.ensureDevice(key.device);
    const id = componentKeyId(key);
    let comp = device.components.get(id);
    if (comp === undefined) {
      comp = {
        key: { ...key },
        id,
        path: path ?? key.device,
        // `component-discovered` now carries the full hierarchy (protocol v5), so a
        // late-discovered component groups dynamically without waiting for a snapshot.
        hier: hier !== undefined ? hier.map((e) => ({ ...e })) : [],
        ladder: "FRESH", // mirrors the server's discovery default
        expectedIntervalSecs: this.opts.defaultIntervalSecs,
        cadenceSource: "default",
        restarts: 0,
        values: new Map(),
        droppedChannels: 0,
      };
      device.components.set(id, comp);
    }
    return comp;
  }

  private finishFold(receivedAt: number, lastServerAt: number | undefined): void {
    this.lastUpdatedAt = receivedAt;
    if (lastServerAt !== undefined) this.clockOffsetMs = receivedAt - lastServerAt;
    this.bump();
  }

  private bump(): void {
    this.version++;
  }
}
