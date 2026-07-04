/**
 * AttributeStore — the console's runtime-ATTRIBUTES surface (slice R0): the latest
 * per-component operational facts the Overview columns (R1) and the Component Detail
 * Health tab (R2) render — CPU / memory / threads / fds and the adapter southbound
 * connection state.
 *
 * This is a PROJECTION over the same `metric`-class ingest that feeds the MetricStore
 * (the metric data path repurposed, not a new emission): the library's `sys` heartbeat
 * measures become the process attributes, and an adapter's `southbound_health` metric
 * becomes the connection state (`connectionState` string + `readErrors`/`writeErrors`).
 * Every field is latest-wins and optional — a component that never published a given
 * measure simply omits it, and the UI shows "—".
 *
 * Same side-store discipline as the MetricStore/SignalStore: pure core, no IO, injected
 * clock; the WS gateway serves `snapshot()` to a `subscribe-attributes` client and pushes
 * the per-ingest update batch. Bounded by distinct components (overflow dropped + counted).
 */
import type { ComponentKey, RuntimeAttributes } from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";
import type { IngressEvent } from "../ingress/normalizer";
import type { Clock } from "./fleet-model";

/** The metric channel carrying the process `sys` heartbeat measures. */
export const SYS_METRIC = "sys";
/** The metric channel carrying the adapter southbound connection health. */
export const SOUTHBOUND_HEALTH_METRIC = "southbound_health";

/** The attribute-surface bounds. */
export interface AttributeStoreOptions {
  /** Max distinct components tracked; overflow dropped + counted. Default 5000. */
  maxComponents: number;
}

export const DEFAULT_ATTRIBUTE_STORE_OPTIONS: AttributeStoreOptions = {
  maxComponents: 5000,
};

/** Notified with each ingest's update batch (one bus arrival = one changed component). */
export type AttributeUpdateListener = (updates: RuntimeAttributes[]) => void;

/** Mutable per-component attribute record. */
interface AttrState {
  key: ComponentKey;
  cpuPercent?: number;
  memoryMb?: number;
  threads?: number;
  fds?: number;
  connectionState?: string;
  readErrors?: number;
  writeErrors?: number;
  receivedAt: number;
  sourceTimestamp?: string;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asObject(body: unknown): Record<string, unknown> | undefined {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

/**
 * The `sys` measure fields we project as process attributes (measure name → attribute
 * field). Any not present in the body is left untouched (latest-wins per field).
 */
const SYS_FIELDS: Array<[string, keyof Pick<AttrState, "cpuPercent" | "memoryMb" | "threads" | "fds">]> =
  [
    ["cpu", "cpuPercent"],
    ["memory", "memoryMb"],
    ["threads", "threads"],
    ["fds", "fds"],
  ];

/** The runtime-attributes projection: `metric` ingest tee + latest-wins + snapshot/update fanout. */
export class AttributeStore {
  private readonly opts: AttributeStoreOptions;
  private readonly byId = new Map<string, AttrState>();
  private readonly listeners: AttributeUpdateListener[] = [];
  private dropped = 0;

  constructor(
    private readonly clock: Clock,
    opts?: Partial<AttributeStoreOptions>,
  ) {
    this.opts = { ...DEFAULT_ATTRIBUTE_STORE_OPTIONS, ...opts };
  }

  /**
   * Tee one ingress event into the store. Only attributable `metric` envelopes on the
   * `sys` or `southbound_health` channels contribute; everything else is a no-op.
   */
  ingest(event: IngressEvent): void {
    if (event.kind !== "envelope" || event.cls !== "metric") return;
    if (event.channel !== SYS_METRIC && event.channel !== SOUTHBOUND_HEALTH_METRIC) return;
    const last = event.identity.hier[event.identity.hier.length - 1];
    const device = last?.value;
    if (device === undefined || device === "") return; // unattributable — defensive (G11)
    const body = asObject(event.body);
    if (body === undefined) return;

    // Compute the field patch WITHOUT touching the map — an event with no usable
    // measure (all non-numeric / wrong shape) contributes nothing and creates no record.
    const patch: Partial<AttrState> = {};
    if (event.channel === SYS_METRIC) {
      for (const [measure, field] of SYS_FIELDS) {
        const n = finiteNumber(body[measure]);
        if (n !== undefined) patch[field] = n;
      }
    } else {
      // southbound_health: a connection-state string + cumulative error counters.
      if (typeof body.connectionState === "string") patch.connectionState = body.connectionState;
      const readErrors = finiteNumber(body.readErrors);
      if (readErrors !== undefined) patch.readErrors = readErrors;
      const writeErrors = finiteNumber(body.writeErrors);
      if (writeErrors !== undefined) patch.writeErrors = writeErrors;
    }
    if (Object.keys(patch).length === 0) return;

    const key: ComponentKey = {
      device,
      component: event.identity.component,
      instance: event.identity.instance,
    };
    const id = componentKeyId(key);
    let state = this.byId.get(id);
    if (state === undefined) {
      if (this.byId.size >= this.opts.maxComponents) {
        this.dropped++;
        return;
      }
      state = { key, receivedAt: this.clock() };
      this.byId.set(id, state);
    }
    Object.assign(state, patch);
    state.receivedAt = this.clock();
    if (event.sourceTimestamp !== undefined) state.sourceTimestamp = event.sourceTimestamp;
    else delete state.sourceTimestamp;

    const update = attributesOf(state);
    for (const listener of [...this.listeners]) listener([update]);
  }

  /** Every known component's runtime attributes, sorted by component id — the `subscribe-attributes` reply. */
  snapshot(): RuntimeAttributes[] {
    return [...this.byId.values()]
      .map(attributesOf)
      .sort((a, b) => componentKeyId(a.key).localeCompare(componentKeyId(b.key)));
  }

  /** Components currently tracked (diagnostics/tests). */
  componentCount(): number {
    return this.byId.size;
  }

  /** New components dropped by the cap (diagnostics/tests). */
  droppedComponents(): number {
    return this.dropped;
  }

  /** Register an update-batch listener; returns the unsubscribe function. */
  onUpdate(listener: AttributeUpdateListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}

/** Project the mutable record into the wire {@link RuntimeAttributes} (omitting absent fields). */
function attributesOf(s: AttrState): RuntimeAttributes {
  return {
    key: { ...s.key },
    ...(s.cpuPercent !== undefined ? { cpuPercent: s.cpuPercent } : {}),
    ...(s.memoryMb !== undefined ? { memoryMb: s.memoryMb } : {}),
    ...(s.threads !== undefined ? { threads: s.threads } : {}),
    ...(s.fds !== undefined ? { fds: s.fds } : {}),
    ...(s.connectionState !== undefined ? { connectionState: s.connectionState } : {}),
    ...(s.readErrors !== undefined ? { readErrors: s.readErrors } : {}),
    ...(s.writeErrors !== undefined ? { writeErrors: s.writeErrors } : {}),
    receivedAt: s.receivedAt,
    ...(s.sourceTimestamp !== undefined ? { sourceTimestamp: s.sourceTimestamp } : {}),
  };
}
